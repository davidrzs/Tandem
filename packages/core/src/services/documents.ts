import { and, asc, desc, eq, getTableColumns, isNull, sql } from "drizzle-orm";
import {
  collections,
  documents,
  runAsActor,
  SYSTEM,
  type Actor,
  type Database,
  type Document,
} from "@tandem/db";
import { jsonToMarkdown, markdownToJSON } from "../markdown.js";

export interface CreateDocumentInput {
  collectionId: string;
  parentDocumentId?: string | null;
  title?: string;
  markdown?: string;
}

export interface UpdateDocumentInput {
  title?: string;
  markdown?: string;
}

export interface SearchOptions {
  collectionId?: string;
  limit?: number;
}

/** Metadata-only view (no content_md / content_json / ydoc_state / search_vector)
 * — what listings and the editor header need, without shipping binary blobs. */
export type DocumentMeta = Pick<
  Document,
  | "id"
  | "workspaceId"
  | "collectionId"
  | "parentDocumentId"
  | "position"
  | "title"
  | "createdAt"
  | "updatedAt"
  | "publishedAt"
  | "archivedAt"
  | "deletedAt"
>;

export interface DocumentNode extends DocumentMeta {
  children: DocumentNode[];
}

/** Derive the persisted read-model fields (content_md + content_json) from markdown. */
function deriveContent(markdown: string): { contentMd: string; contentJson: unknown } {
  const contentJson = markdownToJSON(markdown);
  return { contentMd: jsonToMarkdown(contentJson), contentJson };
}

export class DocumentService {
  constructor(
    private readonly db: Database,
    private readonly actor: Actor = SYSTEM,
  ) {}

  private exec<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    return runAsActor(this.db, this.actor, fn);
  }

  /** Columns safe to ship to clients — excludes content_md/json, ydoc_state, search_vector. */
  private static readonly metaColumns = {
    id: documents.id,
    workspaceId: documents.workspaceId,
    collectionId: documents.collectionId,
    parentDocumentId: documents.parentDocumentId,
    position: documents.position,
    title: documents.title,
    createdAt: documents.createdAt,
    updatedAt: documents.updatedAt,
    publishedAt: documents.publishedAt,
    archivedAt: documents.archivedAt,
    deletedAt: documents.deletedAt,
  };

  /** Metadata only (no body/binary) — for the editor header. */
  async getMeta(id: string): Promise<DocumentMeta | null> {
    return this.exec(async (db) => {
      const [row] = await db
        .select(DocumentService.metaColumns)
        .from(documents)
        .where(and(eq(documents.id, id), isNull(documents.deletedAt)));
      return row ?? null;
    });
  }

  /** Markdown view of a document — what the MCP `get_document` read tool returns. */
  toMarkdown(doc: Document): string {
    return doc.contentMd;
  }

  renderMarkdown(doc: Document): string {
    return doc.contentJson ? jsonToMarkdown(doc.contentJson) : doc.contentMd;
  }

  private async nextPosition(
    db: Database,
    collectionId: string,
    parentDocumentId: string | null,
  ): Promise<number> {
    const [row] = await db
      .select({ max: sql<number | null>`max(${documents.position})` })
      .from(documents)
      .where(
        and(
          eq(documents.collectionId, collectionId),
          parentDocumentId === null
            ? isNull(documents.parentDocumentId)
            : eq(documents.parentDocumentId, parentDocumentId),
          isNull(documents.deletedAt),
        ),
      );
    return (row?.max ?? 0) + 1;
  }

  async create(input: CreateDocumentInput): Promise<Document> {
    return this.exec(async (db) => {
      // Inherit the workspace from the (RLS-visible) collection. If the
      // collection isn't visible to this actor, the document can't be created.
      const [col] = await db
        .select({ workspaceId: collections.workspaceId })
        .from(collections)
        .where(eq(collections.id, input.collectionId));
      if (!col) throw new Error("collection not found");

      const parentId = input.parentDocumentId ?? null;
      const position = await this.nextPosition(db, input.collectionId, parentId);
      const { contentMd, contentJson } = deriveContent(input.markdown ?? "");
      const [row] = await db
        .insert(documents)
        .values({
          workspaceId: col.workspaceId,
          collectionId: input.collectionId,
          parentDocumentId: parentId,
          title: input.title ?? "",
          position,
          contentMd,
          contentJson,
        })
        .returning();
      return row!;
    });
  }

  async get(id: string): Promise<Document | null> {
    return this.exec(async (db) => {
      const [row] = await db
        .select()
        .from(documents)
        .where(and(eq(documents.id, id), isNull(documents.deletedAt)));
      return row ?? null;
    });
  }

  /** Whether the actor may write this document (its collection is writable). */
  async canWrite(id: string): Promise<boolean> {
    return this.exec(async (db) => {
      const [row] = await db
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            eq(documents.id, id),
            sql`${documents.collectionId} IN (SELECT app_writable_collections())`,
          ),
        );
      return !!row;
    });
  }

  async update(id: string, patch: UpdateDocumentInput): Promise<Document | null> {
    return this.exec(async (db) => {
      const set: Record<string, unknown> = { updatedAt: new Date() };
      if (patch.title !== undefined) set.title = patch.title;
      if (patch.markdown !== undefined) {
        const { contentMd, contentJson } = deriveContent(patch.markdown);
        set.contentMd = contentMd;
        set.contentJson = contentJson;
      }
      const [row] = await db
        .update(documents)
        .set(set)
        .where(and(eq(documents.id, id), isNull(documents.deletedAt)))
        .returning();
      return row ?? null;
    });
  }

  /** Persist the live Yjs state + derived read model (Hocuspocus onStoreDocument). */
  async saveCollabSnapshot(
    id: string,
    snapshot: { ydocState: Uint8Array; contentMd: string; contentJson: unknown },
  ): Promise<void> {
    await this.exec(async (db) => {
      await db
        .update(documents)
        .set({
          ydocState: snapshot.ydocState,
          contentMd: snapshot.contentMd,
          contentJson: snapshot.contentJson,
          updatedAt: new Date(),
        })
        // Don't let a debounced store resurrect a soft-deleted document.
        .where(and(eq(documents.id, id), isNull(documents.deletedAt)));
    });
  }

  async move(
    id: string,
    target: { parentDocumentId: string | null; position?: number },
  ): Promise<Document | null> {
    return this.exec(async (db) => {
      const [doc] = await db
        .select({ collectionId: documents.collectionId })
        .from(documents)
        .where(and(eq(documents.id, id), isNull(documents.deletedAt)));
      if (!doc) return null;

      if (target.parentDocumentId) {
        if (target.parentDocumentId === id) {
          throw new Error("a document cannot be its own parent");
        }
        // The new parent must live in the same collection (keeps the tree
        // consistent and prevents cross-collection/tenant parent edges).
        const [parent] = await db
          .select({ collectionId: documents.collectionId })
          .from(documents)
          .where(and(eq(documents.id, target.parentDocumentId), isNull(documents.deletedAt)));
        if (!parent || parent.collectionId !== doc.collectionId) {
          throw new Error("parent must be a document in the same collection");
        }
      }

      const position =
        target.position ??
        (await this.nextPosition(db, doc.collectionId, target.parentDocumentId));
      const [row] = await db
        .update(documents)
        .set({
          parentDocumentId: target.parentDocumentId,
          position,
          updatedAt: new Date(),
        })
        .where(and(eq(documents.id, id), isNull(documents.deletedAt)))
        .returning();
      return row ?? null;
    });
  }

  async archive(id: string): Promise<Document | null> {
    return this.exec(async (db) => {
      const [row] = await db
        .update(documents)
        .set({ archivedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(documents.id, id), isNull(documents.deletedAt)))
        .returning();
      return row ?? null;
    });
  }

  async restore(id: string): Promise<Document | null> {
    return this.exec(async (db) => {
      const [row] = await db
        .update(documents)
        .set({ archivedAt: null, updatedAt: new Date() })
        .where(and(eq(documents.id, id), isNull(documents.deletedAt)))
        .returning();
      return row ?? null;
    });
  }

  async softDelete(id: string): Promise<void> {
    await this.exec(async (db) => {
      await db
        .update(documents)
        .set({ deletedAt: new Date() })
        .where(eq(documents.id, id));
    });
  }

  async listByCollection(collectionId: string): Promise<DocumentMeta[]> {
    return this.exec((db) =>
      db
        .select(DocumentService.metaColumns)
        .from(documents)
        .where(
          and(eq(documents.collectionId, collectionId), isNull(documents.deletedAt)),
        )
        .orderBy(asc(documents.position)),
    );
  }

  async tree(collectionId: string): Promise<DocumentNode[]> {
    const flat = await this.listByCollection(collectionId);
    const byId = new Map<string, DocumentNode>();
    for (const d of flat) byId.set(d.id, { ...d, children: [] });
    const roots: DocumentNode[] = [];
    for (const node of byId.values()) {
      const parent = node.parentDocumentId
        ? byId.get(node.parentDocumentId)
        : undefined;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    return roots;
  }

  async search(
    query: string,
    opts: SearchOptions = {},
  ): Promise<Array<Document & { rank: number }>> {
    return this.exec((db) => {
      const tsquery = sql`websearch_to_tsquery('simple', ${query})`;
      const rank = sql<number>`ts_rank(${documents.searchVector}, ${tsquery})`;
      return db
        .select({ ...getTableColumns(documents), rank })
        .from(documents)
        .where(
          and(
            sql`${documents.searchVector} @@ ${tsquery}`,
            isNull(documents.deletedAt),
            opts.collectionId
              ? eq(documents.collectionId, opts.collectionId)
              : undefined,
          ),
        )
        .orderBy(desc(rank))
        .limit(opts.limit ?? 20);
    });
  }
}
