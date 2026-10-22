import { and, asc, eq, isNull, sql } from "drizzle-orm";
import {
  collections,
  documents,
  runAsActor,
  SYSTEM,
  templates,
  user,
  type Database,
  type Document,
  type DocumentOrigin,
} from "@tandem/db";
import type { AuthorInfo } from "@tandem/editor";
import { ForbiddenError, InvalidInputError, NotFoundError } from "../errors.js";
import { DocumentServiceBase, rowsOf } from "./document-tree-internals.js";
import { insertDocument } from "./documents.js";

/** Levels of a template's descendants that instantiation copies (children,
 * grandchildren, great-grandchildren). Deeper pages stay behind. */
export const TEMPLATE_SUBTREE_DEPTH = 3;

/** `{{name}}`: a letter, then word characters or hyphens, single spaces allowed. */
const VARIABLE = /\{\{\s*([A-Za-z][\w-]*(?: [\w-]+)*)\s*\}\}/g;

/** Filled in by the server unless the caller passes a value. Every other
 * name is a prompt the caller answers. */
const BUILTIN_VARIABLES: Readonly<Record<string, true>> = { date: true, title: true, me: true, parent: true };

export interface TemplateSummary {
  /** The template document's id. */
  id: string;
  name: string;
  workspaceId: string;
  collectionId: string;
  /** The template document's `updated_at`, recorded as `origin.version`. */
  version: string;
}

/** One page instantiation would create, variables already expanded. */
export interface PlannedPage {
  title: string;
  markdown: string;
  children: PlannedPage[];
}

export interface TemplatePlan {
  /** Null for a blank page: no template given and no default here. */
  template: TemplateSummary | null;
  page: PlannedPage;
  /** Prompt names the template uses, in first-use order. */
  prompts: string[];
  /** Prompts the caller gave no value for; they expand to empty text. */
  missing: string[];
}

export interface InstantiateResult extends TemplatePlan {
  /** The new top page; null on a dry run. */
  document: Document | null;
}

export interface InstantiateInput {
  /** A template document id; null for a blank page; omitted to use the
   * deepest default of the target location, else a blank page. */
  templateId?: string | null;
  collectionId: string;
  parentDocumentId?: string | null;
  /** Prompt answers. Values for built-ins (date, title, me, parent) override them. */
  variables?: Record<string, string>;
  /** Plan only: resolve and expand, create nothing. */
  dryRun?: boolean;
}

/** Where a default template is set: a collection or a document (folder). */
export type DefaultTemplateTarget = { collectionId: string } | { documentId: string };

/** Replace every `{{name}}` with its value; names without one become empty. */
export function expandVariables(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(VARIABLE, (_, name: string) => (Object.hasOwn(values, name) ? values[name]! : ""));
}

interface TemplateNode {
  id: string;
  parentDocumentId: string | null;
  title: string;
  contentMd: string;
  tags: string[];
  defaultTemplateId: string | null;
  children: TemplateNode[];
}

const BLANK: TemplateNode = {
  id: "",
  parentDocumentId: null,
  title: "",
  contentMd: "",
  tags: [],
  defaultTemplateId: null,
  children: [],
};

function promptsOf(root: TemplateNode): string[] {
  const names = new Set<string>();
  const visit = (node: TemplateNode) => {
    for (const text of [node.title, node.contentMd]) {
      for (const [, name] of text.matchAll(VARIABLE)) {
        if (!Object.hasOwn(BUILTIN_VARIABLES, name!)) names.add(name!);
      }
    }
    node.children.forEach(visit);
  };
  visit(root);
  return [...names];
}

/** Expand one page and its copied descendants. A page's `{{title}}` is its
 * own expanded title; a child's `{{parent}}` is the page above it. */
function planPage(
  node: TemplateNode,
  values: Readonly<Record<string, string>>,
  title = expandVariables(node.title, { ...values, title: "" }),
): PlannedPage {
  return {
    title,
    markdown: expandVariables(node.contentMd, { ...values, title }),
    children: node.children.map((child) => planPage(child, { ...values, parent: title })),
  };
}

async function createPages(
  db: Database,
  author: AuthorInfo,
  node: TemplateNode,
  page: PlannedPage,
  placement: { collectionId: string; parentDocumentId: string | null },
  origin?: DocumentOrigin,
): Promise<Document> {
  const doc = await insertDocument(
    db,
    {
      ...placement,
      title: page.title,
      markdown: page.markdown,
      tags: node.tags,
      defaultTemplateId: node.defaultTemplateId,
      ...(origin ? { origin } : {}),
    },
    author,
  );
  for (const [i, child] of node.children.entries()) {
    await createPages(db, author, child, page.children[i]!, {
      collectionId: placement.collectionId,
      parentDocumentId: doc.id,
    });
  }
  return doc;
}

/** Templates are documents plus a `templates` row; this service lists,
 * marks, and instantiates them. Every call is RLS-scoped to the actor. */
export class TemplateService extends DocumentServiceBase {
  /** Active templates the actor can read, by name. */
  async list(workspaceId?: string): Promise<TemplateSummary[]> {
    const rows = await this.exec((db) =>
      db
        .select({
          id: templates.documentId,
          name: templates.name,
          workspaceId: templates.workspaceId,
          collectionId: documents.collectionId,
          updatedAt: documents.updatedAt,
        })
        .from(templates)
        .innerJoin(documents, eq(documents.id, templates.documentId))
        .where(
          and(
            isNull(documents.deletedAt),
            isNull(documents.archivedAt),
            workspaceId ? eq(templates.workspaceId, workspaceId) : undefined,
          ),
        )
        .orderBy(asc(templates.name), asc(templates.documentId)),
    );
    return rows.map(({ updatedAt, ...row }) => ({ ...row, version: updatedAt.toISOString() }));
  }

  /** Mark a document (and so its subtree) as a template named `name`.
   * Marking it again renames it. */
  async templatize(documentId: string, name: string): Promise<TemplateSummary> {
    const createdBy = this.actor.kind === "user" ? this.actor.userId : "system";
    const system = this.actor.kind !== "user";
    return this.execTx(async (db) => {
      const [doc] = await db
        .select({
          workspaceId: documents.workspaceId,
          collectionId: documents.collectionId,
          title: documents.title,
          updatedAt: documents.updatedAt,
          writable: sql<boolean>`${documents.collectionId} IN (SELECT app_writable_collections())`,
        })
        .from(documents)
        .where(
          and(eq(documents.id, documentId), isNull(documents.deletedAt), isNull(documents.archivedAt)),
        );
      if (!doc) throw new NotFoundError("document not found");
      if (!system && !doc.writable) throw new ForbiddenError("this document is read-only for you");
      const label = name.trim() || doc.title.trim() || "Untitled template";
      await db
        .insert(templates)
        .values({ documentId, workspaceId: doc.workspaceId, name: label, createdBy })
        .onConflictDoUpdate({
          target: templates.documentId,
          set: { name: label, updatedAt: new Date() },
        });
      return {
        id: documentId,
        name: label,
        workspaceId: doc.workspaceId,
        collectionId: doc.collectionId,
        version: doc.updatedAt.toISOString(),
      };
    });
  }

  /** Turn a template back into an ordinary page. False when the actor may
   * not write it (or it was not a template). Defaults pointing at it clear. */
  async untemplatize(documentId: string): Promise<boolean> {
    const rows = await this.exec((db) =>
      db
        .delete(templates)
        .where(eq(templates.documentId, documentId))
        .returning({ id: templates.documentId }),
    );
    return rows.length > 0;
  }

  /** Set or clear the template new pages start from at `target`. False when
   * the actor may not write the target. */
  async setDefault(target: DefaultTemplateTarget, templateId: string | null): Promise<boolean> {
    return this.exec(async (db) => {
      const [place] =
        "collectionId" in target
          ? await db
              .select({ workspaceId: collections.workspaceId })
              .from(collections)
              .where(and(eq(collections.id, target.collectionId), isNull(collections.deletedAt)))
          : await db
              .select({ workspaceId: documents.workspaceId })
              .from(documents)
              .where(and(eq(documents.id, target.documentId), isNull(documents.deletedAt)));
      if (!place) throw new NotFoundError("collection" in target ? "collection not found" : "document not found");
      if (templateId) {
        const [template] = await db
          .select({ workspaceId: templates.workspaceId })
          .from(templates)
          .where(eq(templates.documentId, templateId));
        if (!template) throw new NotFoundError("template not found");
        if (template.workspaceId !== place.workspaceId) {
          throw new InvalidInputError("template belongs to another workspace");
        }
      }
      const rows =
        "collectionId" in target
          ? await db
              .update(collections)
              .set({ defaultTemplateId: templateId })
              .where(eq(collections.id, target.collectionId))
              .returning({ id: collections.id })
          : await db
              .update(documents)
              .set({ defaultTemplateId: templateId })
              .where(eq(documents.id, target.documentId))
              .returning({ id: documents.id });
      return rows.length > 0;
    });
  }

  /** The template a new page at this location starts from: the deepest
   * ancestor's default (the parent itself first), then the collection's.
   * Defaults pointing at archived or trashed templates are skipped. */
  async defaultFor(collectionId: string, parentDocumentId: string | null): Promise<string | null> {
    return this.exec((db) => this.resolveDefault(db, collectionId, parentDocumentId));
  }

  private async resolveDefault(
    db: Database,
    collectionId: string,
    parentDocumentId: string | null,
  ): Promise<string | null> {
    // depth bound: tree queries must terminate even over a corrupt parent cycle.
    const rows = rowsOf<{ id: string }>(
      await db.execute(sql`
        WITH RECURSIVE chain(id, parent_id, default_template_id, depth) AS (
          SELECT id, parent_document_id, default_template_id, 0
          FROM documents WHERE id = ${parentDocumentId}
          UNION ALL
          SELECT d.id, d.parent_document_id, d.default_template_id, c.depth + 1
          FROM documents d JOIN chain c ON d.id = c.parent_id
          WHERE c.depth < 1000
        ),
        candidates(template_id, depth) AS (
          SELECT default_template_id, depth FROM chain WHERE default_template_id IS NOT NULL
          UNION ALL
          SELECT default_template_id, 1000000 FROM collections
          WHERE id = ${collectionId} AND default_template_id IS NOT NULL
        )
        SELECT t.document_id AS id
        FROM candidates c
        JOIN templates t ON t.document_id = c.template_id
        JOIN documents td ON td.id = t.document_id
        WHERE td.deleted_at IS NULL AND td.archived_at IS NULL
        ORDER BY c.depth
        LIMIT 1
      `),
    );
    return rows[0]?.id ?? null;
  }

  /** The template's page and its active descendants, TEMPLATE_SUBTREE_DEPTH
   * levels deep, in sibling order. */
  private async loadTree(db: Database, templateId: string): Promise<TemplateNode> {
    const rows = rowsOf<{
      id: string;
      parent_document_id: string | null;
      title: string;
      content_md: string;
      tags: string[];
      default_template_id: string | null;
    }>(
      await db.execute(sql`
        WITH RECURSIVE sub(id, depth) AS (
          SELECT id, 0 FROM documents
          WHERE id = ${templateId} AND deleted_at IS NULL AND archived_at IS NULL
          UNION ALL
          SELECT d.id, s.depth + 1 FROM documents d JOIN sub s ON d.parent_document_id = s.id
          WHERE s.depth < ${TEMPLATE_SUBTREE_DEPTH} AND d.deleted_at IS NULL AND d.archived_at IS NULL
        )
        SELECT d.id, d.parent_document_id, d.title, d.content_md, d.tags, d.default_template_id
        FROM sub s JOIN documents d ON d.id = s.id
        ORDER BY s.depth, d.position, d.id
      `),
    );
    const byId = new Map<string, TemplateNode>();
    for (const row of rows) {
      const node: TemplateNode = {
        id: row.id,
        parentDocumentId: row.parent_document_id,
        title: row.title,
        contentMd: row.content_md,
        tags: row.tags,
        defaultTemplateId: row.default_template_id,
        children: [],
      };
      byId.set(node.id, node);
      if (node.id !== templateId) byId.get(node.parentDocumentId!)?.children.push(node);
    }
    const root = byId.get(templateId);
    if (!root) throw new NotFoundError("template not found");
    return root;
  }

  /**
   * Create a page from a template: resolve the template (explicit, the
   * location's default, or none for a blank page), expand its variables, then
   * copy its body and up to TEMPLATE_SUBTREE_DEPTH levels of child pages in
   * one transaction. Every copied body is the instantiating actor's writing;
   * the top page records `origin` and later template edits never touch it.
   */
  async instantiate(input: InstantiateInput): Promise<InstantiateResult> {
    const me = await this.displayName();
    const parentDocumentId = input.parentDocumentId ?? null;
    const variables = input.variables ?? {};
    return this.execTx(async (db) => {
      const [place] = parentDocumentId
        ? await db
            .select({ name: documents.title, workspaceId: documents.workspaceId })
            .from(documents)
            .where(and(eq(documents.id, parentDocumentId), isNull(documents.deletedAt)))
        : await db
            .select({ name: collections.name, workspaceId: collections.workspaceId })
            .from(collections)
            .where(and(eq(collections.id, input.collectionId), isNull(collections.deletedAt)));
      if (!place) throw new NotFoundError(parentDocumentId ? "parent document not found" : "collection not found");

      const templateId =
        input.templateId === undefined
          ? await this.resolveDefault(db, input.collectionId, parentDocumentId)
          : input.templateId;
      let template: TemplateSummary | null = null;
      let root = BLANK;
      if (templateId) {
        const [row] = await db
          .select({
            name: templates.name,
            workspaceId: templates.workspaceId,
            collectionId: documents.collectionId,
            updatedAt: documents.updatedAt,
          })
          .from(templates)
          .innerJoin(documents, eq(documents.id, templates.documentId))
          .where(eq(templates.documentId, templateId));
        if (!row) throw new NotFoundError("template not found");
        if (row.workspaceId !== place.workspaceId) {
          throw new InvalidInputError("template belongs to another workspace");
        }
        template = {
          id: templateId,
          name: row.name,
          workspaceId: row.workspaceId,
          collectionId: row.collectionId,
          version: row.updatedAt.toISOString(),
        };
        root = await this.loadTree(db, templateId);
      }

      const now = new Date();
      const values = {
        date: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`,
        me,
        parent: place.name,
        ...variables,
      };
      const page = planPage(root, values, variables.title);
      const prompts = promptsOf(root);
      const plan: TemplatePlan = {
        template,
        page,
        prompts,
        missing: prompts.filter((name) => !Object.hasOwn(variables, name)),
      };
      if (input.dryRun) return { ...plan, document: null };

      const document = await createPages(
        db,
        this.authorInfo(),
        root,
        page,
        { collectionId: input.collectionId, parentDocumentId },
        template ? { templateId: template.id, version: template.version } : undefined,
      );
      return { ...plan, document };
    });
  }

  /** `{{me}}`: the acting user's display name. Read system-side (the auth
   * user table has no app_user grant) and before the actor transaction. */
  private async displayName(): Promise<string> {
    if (this.actor.kind !== "user") return "System";
    const userId = this.actor.userId;
    const [row] = await runAsActor(this.db, SYSTEM, (db) =>
      db.select({ name: user.name }).from(user).where(eq(user.id, userId)),
    );
    return row?.name ?? "";
  }
}
