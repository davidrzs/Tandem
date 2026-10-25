import { and, asc, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import {
  collections,
  documents,
  documentTypes,
  runAsActor,
  SYSTEM,
  templates,
  typeFields,
  user,
  type Database,
  type Document,
  type DocumentOrigin,
  type TemplateDefault,
} from "@tandem/db";
import type { AuthorInfo, PropertyOp } from "@tandem/editor";
import { ForbiddenError, InvalidInputError, NotFoundError } from "../errors.js";
import { DocumentServiceBase, previousSibling, rowsOf } from "./document-tree-internals.js";
import { insertDocument, type InsertDocumentInput } from "./documents.js";
import { seedStarterKit, type StarterKitResult } from "./seed-types.js";
import { evaluateDefaults, normalizeDefault, type DefaultContext } from "./template-defaults.js";
import { assertCanDefine, assertPagesExist } from "./types.js";

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
  /** The latest `updated_at` across the copied subtree, recorded as `origin.version`. */
  version: string;
  /** The type new pages get; null leaves them untyped. */
  typeId: string | null;
  /** First values of new pages, by field id of the type. */
  defaults: Record<string, TemplateDefault>;
}

/** A template beside the last page made from it (the newest the actor can
 * read), so a damaged or changed template shows before the next page copies
 * it. */
export interface TemplateUse {
  /** Live sections across the pages instantiation copies. */
  liveSections: number;
  /** When the last page was made from it; null if none was. */
  lastUsedAt: string | null;
  /** Its version is newer than the one that page was made from. */
  changedSinceLastUse: boolean;
  /** Sentences for the caller: fewer live sections than that page had, and
   * a change since then. Empty when neither holds. */
  warnings: string[];
}

export type ListedTemplate = TemplateSummary & TemplateUse;

/** One page instantiation would create, variables already expanded. */
export interface PlannedPage {
  title: string;
  markdown: string;
  children: PlannedPage[];
}

export interface TemplatePlan {
  /** Null for a blank page: no template given and no default here. */
  template: ListedTemplate | null;
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
  /** The top page's title, in place of the template's expanded title (and
   * of `variables.title`); its `{{title}}` reads it. */
  title?: string;
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

/** Prompt names in first-use order; `rootTitle: false` skips the top page's
 * title when the caller replaces it. */
function promptsOf(root: TemplateNode, rootTitle: boolean): string[] {
  const names = new Set<string>();
  const visit = (node: TemplateNode) => {
    for (const text of node === root && !rootTitle ? [node.contentMd] : [node.title, node.contentMd]) {
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
  top: Pick<InsertDocumentInput, "origin" | "typeId" | "properties"> = {},
): Promise<Document> {
  const doc = await insertDocument(
    db,
    {
      ...placement,
      title: page.title,
      markdown: page.markdown,
      tags: node.tags,
      defaultTemplateId: node.defaultTemplateId,
      ...top,
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

/** `aggregate` over `v`: the template page and the descendants instantiation
 * copies. */
const overSubtree = (aggregate: SQL) => sql`(
  WITH RECURSIVE sub(id, depth) AS (
    SELECT ${documents.id}, 0
    UNION ALL
    SELECT d.id, s.depth + 1 FROM documents d JOIN sub s ON d.parent_document_id = s.id
    WHERE s.depth < ${TEMPLATE_SUBTREE_DEPTH} AND d.deleted_at IS NULL AND d.archived_at IS NULL
  )
  SELECT ${aggregate} FROM sub JOIN documents v ON v.id = sub.id
)`;

/** Latest `updated_at` over the copied pages, so editing any of them changes
 * the version. */
const subtreeUpdatedAt = overSubtree(sql`max(v.updated_at)`).mapWith(documents.updatedAt);

/** Live sections over the copied pages: the markdown writes each as this
 * comment on a line of its own. */
const subtreeLiveSections = overSubtree(
  sql`coalesce(sum((SELECT count(*) FROM regexp_matches(v.content_md, '^<!-- live-section: [a-z_]+ -->$', 'gn'))), 0)`,
).mapWith(Number);

interface LastUse {
  origin: DocumentOrigin;
  at: string;
}

/** The template's newest page: its origin and creation time. */
const lastUse = sql<LastUse | null>`(
  SELECT jsonb_build_object('origin', d.origin, 'at', d.created_at) FROM documents d
  WHERE d.origin IS NOT NULL AND d.origin->>'templateId' = ${templates.documentId}::text
  ORDER BY d.created_at DESC LIMIT 1
)`;

const summaryColumns = {
  id: templates.documentId,
  name: templates.name,
  workspaceId: templates.workspaceId,
  collectionId: documents.collectionId,
  updatedAt: subtreeUpdatedAt,
  typeId: templates.defaultTypeId,
  defaults: templates.defaults,
};

const listedColumns = { ...summaryColumns, liveSections: subtreeLiveSections, lastUse };

function toSummary({ updatedAt, ...row }: { updatedAt: Date } & Omit<TemplateSummary, "version">): TemplateSummary {
  return { ...row, version: updatedAt.toISOString() };
}

function toListed({
  liveSections,
  lastUse,
  ...row
}: Parameters<typeof toSummary>[0] & { liveSections: number; lastUse: LastUse | null }): ListedTemplate {
  const summary = toSummary(row);
  if (!lastUse) return { ...summary, liveSections, lastUsedAt: null, changedSinceLastUse: false, warnings: [] };
  const lastUsedAt = new Date(lastUse.at).toISOString();
  const changedSinceLastUse = Date.parse(summary.version) > Date.parse(lastUse.origin.version);
  const before = lastUse.origin.liveSections;
  const warnings: string[] = [];
  if (before !== undefined && liveSections < before) {
    warnings.push(
      `It has ${liveSections} live section(s) where the page made from it at ${lastUsedAt} had ${before}: ` +
        "a live section may have been deleted or turned into plain text.",
    );
  }
  if (changedSinceLastUse) warnings.push(`It changed after its last use at ${lastUsedAt}.`);
  return { ...summary, liveSections, lastUsedAt, changedSinceLastUse, warnings };
}

/** Templates are documents plus a `templates` row; this service lists,
 * marks, and instantiates them. Every call is RLS-scoped to the actor. */
export class TemplateService extends DocumentServiceBase {
  /** Active templates the actor can read, by name. */
  async list(workspaceId?: string): Promise<ListedTemplate[]> {
    const rows = await this.exec((db) =>
      db
        .select(listedColumns)
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
    return rows.map(toListed);
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
          updatedAt: subtreeUpdatedAt,
          writable: sql<boolean>`${documents.collectionId} IN (SELECT app_writable_collections())`,
        })
        .from(documents)
        .where(
          and(eq(documents.id, documentId), isNull(documents.deletedAt), isNull(documents.archivedAt)),
        );
      if (!doc) throw new NotFoundError("document not found");
      if (!system && !doc.writable) throw new ForbiddenError("this document is read-only for you");
      const label = name.trim() || doc.title.trim() || "Untitled template";
      const [row] = await db
        .insert(templates)
        .values({ documentId, workspaceId: doc.workspaceId, name: label, createdBy })
        .onConflictDoUpdate({
          target: templates.documentId,
          set: { name: label, updatedAt: new Date() },
        })
        .returning({ typeId: templates.defaultTypeId, defaults: templates.defaults });
      return {
        id: documentId,
        name: label,
        workspaceId: doc.workspaceId,
        collectionId: doc.collectionId,
        version: doc.updatedAt.toISOString(),
        ...row!,
      };
    });
  }

  /** Turn a template back into an ordinary page: the template it was, or
   * null when the actor may not write it (or it was not a template).
   * Defaults pointing at it clear. */
  async untemplatize(documentId: string): Promise<{ workspaceId: string; name: string } | null> {
    const [row] = await this.exec((db) =>
      db
        .delete(templates)
        .where(eq(templates.documentId, documentId))
        .returning({ workspaceId: templates.workspaceId, name: templates.name }),
    );
    return row ?? null;
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
   * one transaction. Every copied body is the instantiating actor's writing.
   * The top page records `origin` (with the template's live-section count,
   * which the next use compares against), gets the template's type, and its
   * first values as per-field ops by the same author; later template edits
   * never touch it.
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
      let template: ListedTemplate | null = null;
      let root = BLANK;
      if (templateId) {
        const [row] = await db
          .select(listedColumns)
          .from(templates)
          .innerJoin(documents, eq(documents.id, templates.documentId))
          .where(eq(templates.documentId, templateId));
        if (!row) throw new NotFoundError("template not found");
        if (row.workspaceId !== place.workspaceId) {
          throw new InvalidInputError("template belongs to another workspace");
        }
        template = toListed(row);
        root = await this.loadTree(db, templateId);
      }

      const now = new Date();
      const values = {
        date: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`,
        me,
        parent: place.name,
        ...variables,
      };
      const title = input.title ?? variables.title;
      const page = planPage(root, values, title);
      const prompts = promptsOf(root, title === undefined);
      const plan: TemplatePlan = {
        template,
        page,
        prompts,
        missing: prompts.filter((name) => !Object.hasOwn(variables, name)),
      };
      if (input.dryRun) return { ...plan, document: null };

      const placement = { collectionId: input.collectionId, parentDocumentId };
      const typed = template?.typeId
        ? {
            typeId: template.typeId,
            properties: await this.firstValues(db, template.typeId, template.defaults, placement, {
              today: values.date,
              now,
              me,
            }),
          }
        : {};
      const document = await createPages(
        db,
        this.authorInfo(),
        root,
        page,
        placement,
        template
          ? {
              origin: { templateId: template.id, version: template.version, liveSections: template.liveSections },
              ...typed,
            }
          : {},
      );
      return { ...plan, document };
    });
  }

  /** The ops that give a new page of `typeId` at `placement` its defaults. */
  private async firstValues(
    db: Database,
    typeId: string,
    defaults: Readonly<Record<string, TemplateDefault>>,
    placement: { collectionId: string; parentDocumentId: string | null },
    ctx: Omit<DefaultContext, "previous">,
  ): Promise<PropertyOp[]> {
    const fields = await db
      .select()
      .from(typeFields)
      .where(and(eq(typeFields.typeId, typeId), isNull(typeFields.retiredAt)))
      .orderBy(asc(typeFields.position), asc(typeFields.key));
    const previous = Object.values(defaults).some((d) => d.kind === "from_previous_sibling")
      ? ((await previousSibling(db, { typeId, ...placement }))?.properties ?? null)
      : null;
    return evaluateDefaults(fields, defaults, { ...ctx, previous });
  }

  /** A template the actor can see and, as owner or admin, define. */
  private async definable(db: Database, templateId: string) {
    const [row] = await db
      .select(summaryColumns)
      .from(templates)
      .innerJoin(documents, eq(documents.id, templates.documentId))
      .where(and(eq(templates.documentId, templateId), isNull(documents.deletedAt)));
    if (!row) throw new NotFoundError("template not found");
    await assertCanDefine(db, this.actor, row.workspaceId);
    return row;
  }

  /** Write a template row the actor may define; RLS hides it when they can't
   * write the template's collection. */
  private async updateTemplate(
    db: Database,
    templateId: string,
    set: PgUpdateSetSource<typeof templates>,
  ): Promise<void> {
    const rows = await db
      .update(templates)
      .set({ ...set, updatedAt: new Date() })
      .where(eq(templates.documentId, templateId))
      .returning({ id: templates.documentId });
    if (rows.length === 0) throw new ForbiddenError("this template is read-only for you");
  }

  /** Set or clear the type pages from this template get (owner or admin).
   * Defaults belong to the type's fields, so a different type drops them. */
  async setDefaultType(templateId: string, typeId: string | null): Promise<TemplateSummary> {
    return this.exec(async (db) => {
      const row = await this.definable(db, templateId);
      if (typeId) {
        const [type] = await db
          .select({ workspaceId: documentTypes.workspaceId })
          .from(documentTypes)
          .where(eq(documentTypes.id, typeId));
        if (type?.workspaceId !== row.workspaceId) throw new NotFoundError("type not found");
      }
      if (typeId === row.typeId) return toSummary(row);
      await this.updateTemplate(db, templateId, { defaultTypeId: typeId, defaults: {} });
      return toSummary({ ...row, typeId, defaults: {} });
    });
  }

  /** Set or clear (null) the default of one field of the template's type
   * (owner or admin). A literal is checked against the field and stored in
   * its stored form; an empty literal clears the default. */
  async setFieldDefault(templateId: string, fieldId: string, input: TemplateDefault | null): Promise<TemplateSummary> {
    return this.exec(async (db) => {
      const row = await this.definable(db, templateId);
      if (!row.typeId) throw new InvalidInputError("give the template a type before setting defaults");
      const [field] = await db
        .select()
        .from(typeFields)
        .where(and(eq(typeFields.id, fieldId), eq(typeFields.typeId, row.typeId), isNull(typeFields.retiredAt)));
      if (!field) throw new InvalidInputError("that field is not a live field of the template's type");
      const normalized = input ? normalizeDefault(field, input) : { value: null };
      if ("error" in normalized) throw new InvalidInputError(normalized.error);
      const value = normalized.value;
      if (value?.kind === "value" && (field.kind === "doc" || field.kind === "doc_list")) {
        await assertPagesExist(db, row.workspaceId, [value.value].flat() as string[]);
      }
      // A per-field patch on the map, so two people setting different fields don't race.
      await this.updateTemplate(db, templateId, {
        defaults: value
          ? sql`${templates.defaults} || jsonb_build_object(${fieldId}::text, ${JSON.stringify(value)}::jsonb)`
          : sql`${templates.defaults} - ${fieldId}::text`,
      });
      const defaults = { ...row.defaults };
      if (value) defaults[fieldId] = value;
      else delete defaults[fieldId];
      return toSummary({ ...row, defaults });
    });
  }

  /** Add the starter types (Meeting, Project, Person) and their templates
   * to the workspace, the templates in `collectionId` (owner or admin).
   * Converges: whatever already exists by name is kept as it is. */
  async addStarterKit(workspaceId: string, collectionId: string): Promise<StarterKitResult> {
    return this.execTx((db) => seedStarterKit(db, this.actor, this.authorInfo(), workspaceId, collectionId));
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
