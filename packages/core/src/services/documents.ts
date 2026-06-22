import { and, asc, desc, eq, getTableColumns, isNull, sql } from "drizzle-orm";
import type { Database } from "@realtime/db";
import { documents, type Document } from "@realtime/db";
import { jsonToMarkdown, markdownToJSON, normalizeMarkdown } from "../markdown.js";

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

export interface DocumentNode extends Document {
  children: DocumentNode[];
}

/** Derive the persisted read-model fields (content_md + content_json) from markdown. */
function deriveContent(markdown: string): { contentMd: string; contentJson: unknown } {
  const contentJson = markdownToJSON(markdown);
  // Re-serialize so the stored markdown is always the canonical form of the JSON.
  return { contentMd: jsonToMarkdown(contentJson), contentJson };
}

export class DocumentService {
  constructor(private readonly db: Database) {}

  /** Markdown view of a document — what the MCP `get_document` read tool returns. */
  toMarkdown(doc: Document): string {
    return doc.contentMd;
  }

  /** Re-derive markdown from the stored JSON (used after Y.Doc-driven writes). */
  renderMarkdown(doc: Document): string {
    return doc.contentJson ? jsonToMarkdown(doc.contentJson) : doc.contentMd;
  }

  private async nextPosition(
    collectionId: string,
    parentDocumentId: string | null,
  ): Promise<number> {
    const [row] = await this.db
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
    const parentId = input.parentDocumentId ?? null;
    const position = await this.nextPosition(input.collectionId, parentId);
    const { contentMd, contentJson } = deriveContent(input.markdown ?? "");
    const [row] = await this.db
      .insert(documents)
      .values({
        collectionId: input.collectionId,
        parentDocumentId: parentId,
        title: input.title ?? "",
        position,
        contentMd,
        contentJson,
      })
      .returning();
    return row!;
  }

  /**
   * Persist the live Yjs state and its derived read model. Called by the
   * Hocuspocus onStoreDocument hook — the single durable write for collab edits.
   */
  async saveCollabSnapshot(
    id: string,
    snapshot: { ydocState: Uint8Array; contentMd: string; contentJson: unknown },
  ): Promise<void> {
    await this.db
      .update(documents)
      .set({
        ydocState: snapshot.ydocState,
        contentMd: snapshot.contentMd,
        contentJson: snapshot.contentJson,
        updatedAt: new Date(),
      })
      .where(eq(documents.id, id));
  }

  async get(id: string): Promise<Document | null> {
    const [row] = await this.db
      .select()
      .from(documents)
      .where(and(eq(documents.id, id), isNull(documents.deletedAt)));
    return row ?? null;
  }

  async update(id: string, patch: UpdateDocumentInput): Promise<Document | null> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.title !== undefined) set.title = patch.title;
    if (patch.markdown !== undefined) {
      const { contentMd, contentJson } = deriveContent(patch.markdown);
      set.contentMd = contentMd;
      set.contentJson = contentJson;
    }
    const [row] = await this.db
      .update(documents)
      .set(set)
      .where(and(eq(documents.id, id), isNull(documents.deletedAt)))
      .returning();
    return row ?? null;
  }

  async move(
    id: string,
    target: { parentDocumentId: string | null; position?: number },
  ): Promise<Document | null> {
    const position =
      target.position ??
      (await this.nextPosition(
        (await this.get(id))?.collectionId ?? "",
        target.parentDocumentId,
      ));
    const [row] = await this.db
      .update(documents)
      .set({
        parentDocumentId: target.parentDocumentId,
        position,
        updatedAt: new Date(),
      })
      .where(and(eq(documents.id, id), isNull(documents.deletedAt)))
      .returning();
    return row ?? null;
  }

  async archive(id: string): Promise<Document | null> {
    const [row] = await this.db
      .update(documents)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(eq(documents.id, id))
      .returning();
    return row ?? null;
  }

  async restore(id: string): Promise<Document | null> {
    const [row] = await this.db
      .update(documents)
      .set({ archivedAt: null, updatedAt: new Date() })
      .where(eq(documents.id, id))
      .returning();
    return row ?? null;
  }

  async softDelete(id: string): Promise<void> {
    await this.db
      .update(documents)
      .set({ deletedAt: new Date() })
      .where(eq(documents.id, id));
  }

  async listByCollection(collectionId: string): Promise<Document[]> {
    return this.db
      .select()
      .from(documents)
      .where(
        and(eq(documents.collectionId, collectionId), isNull(documents.deletedAt)),
      )
      .orderBy(asc(documents.position));
  }

  /** Nested document tree for a collection (sidebar shape). */
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
    const tsquery = sql`websearch_to_tsquery('simple', ${query})`;
    const rank = sql<number>`ts_rank(${documents.searchVector}, ${tsquery})`;
    return this.db
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
  }
}
