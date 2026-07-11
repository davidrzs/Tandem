import { ForbiddenError, InvalidInputError, NotFoundError } from "../errors.js";
import { and, asc, desc, eq, isNull, like, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  collections,
  documents,
  runAsActor,
  SYSTEM,
  user,
  type Actor,
  type Database,
  type Document,
} from "@tandem/db";
import {
  applyEditToState,
  scanTaskItems,
  type AuthorIdentity,
  type AuthorInfo,
} from "@tandem/editor";
import { jsonToMarkdown, markdownToJSON } from "../markdown.js";

export interface CreateDocumentInput {
  collectionId: string;
  parentDocumentId?: string | null;
  title?: string;
  markdown?: string;
  tags?: string[];
}

export interface UpdateDocumentInput {
  title?: string;
  tags?: string[];
}

/** Clean up user/agent-supplied tags: trim, collapse inner whitespace, drop
 * empties, dedupe case-insensitively (first spelling wins), cap length + count. */
export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim().replace(/\s+/g, " ").slice(0, 50);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= 20) break;
  }
  return out;
}

/** The actor tried to write a document their role only lets them read. */
export class DocumentWriteDeniedError extends ForbiddenError {
  constructor(message = "you do not have write access to this document") {
    super(message);
    this.name = "DocumentWriteDeniedError";
  }
}

export interface SearchOptions {
  collectionId?: string;
  limit?: number;
  /** Restrict to documents carrying this tag (exact, case-sensitive). */
  tag?: string;
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
  | "tags"
  | "createdAt"
  | "updatedAt"
  | "archivedAt"
  | "deletedAt"
>;

export interface DocumentNode extends DocumentMeta {
  children: DocumentNode[];
}

/** An in-document task (`- [ ] @user …`) assigned to a user, for the start page. */
export interface TodoItem {
  documentId: string;
  documentTitle: string;
  collectionId: string;
  workspaceId: string;
  /** 0-based line in the document's markdown (a stable-enough anchor). */
  line: number;
  text: string;
  done: boolean;
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
    private readonly author?: AuthorIdentity,
  ) {}

  private exec<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    return runAsActor(this.db, this.actor, fn);
  }

  /** Attribution identity for content this service writes into Yjs state. */
  private authorInfo(): AuthorInfo {
    const identity =
      this.author ??
      (this.actor.kind === "user"
        ? { userId: this.actor.userId, name: "", ai: false }
        : { userId: "system", name: "System", ai: true });
    return { ...identity, at: Date.now() };
  }

  /** Columns safe to ship to clients — excludes content_md/json, ydoc_state, search_vector. */
  private static readonly metaColumns = {
    id: documents.id,
    workspaceId: documents.workspaceId,
    collectionId: documents.collectionId,
    parentDocumentId: documents.parentDocumentId,
    position: documents.position,
    title: documents.title,
    tags: documents.tags,
    createdAt: documents.createdAt,
    updatedAt: documents.updatedAt,
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
      if (!col) throw new NotFoundError("collection not found");

      const parentId = input.parentDocumentId ?? null;
      if (parentId) {
        // Same rule as move(): the parent must be a visible document in the
        // same collection (the FK alone runs as table owner and would accept
        // a cross-tenant uuid).
        const [parent] = await db
          .select({ collectionId: documents.collectionId })
          .from(documents)
          .where(and(eq(documents.id, parentId), isNull(documents.deletedAt)));
        if (!parent || parent.collectionId !== input.collectionId) {
          throw new InvalidInputError("parent must be a document in the same collection");
        }
      }
      const position = await this.nextPosition(db, input.collectionId, parentId);
      // Seed the Yjs write model at creation so the initial content is
      // attributed to its creator (not to whoever opens the doc first).
      const seeded = input.markdown?.trim()
        ? applyEditToState(null, () => input.markdown!, this.authorInfo())
        : null;
      const { contentMd, contentJson } = seeded ?? deriveContent("");
      const [row] = await db
        .insert(documents)
        .values({
          workspaceId: col.workspaceId,
          collectionId: input.collectionId,
          parentDocumentId: parentId,
          title: input.title ?? "",
          tags: input.tags ? normalizeTags(input.tags) : [],
          position,
          contentMd,
          contentJson,
          ydocState: seeded?.ydocState ?? null,
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
    if (this.actor.kind !== "user") return true; // system bypasses RLS
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
      if (patch.tags !== undefined) set.tags = normalizeTags(patch.tags);
      const [row] = await db
        .update(documents)
        .set(set)
        .where(and(eq(documents.id, id), isNull(documents.deletedAt)))
        .returning();
      return row ?? null;
    });
  }

  /**
   * Body edit for writers WITHOUT a live collaboration session (the fallback
   * when no collab writer is wired): hydrate the persisted Yjs state, apply
   * the markdown transform
   * as an attributed edit, persist state + derived read model together so
   * ydoc_state never goes stale. Throws DocumentWriteDeniedError on read-only
   * docs and lets transform errors (bad targets) propagate to the caller.
   */
  async editBody(
    id: string,
    transform: (currentMd: string) => string,
  ): Promise<Document> {
    const doc = await this.get(id);
    if (!doc) throw new NotFoundError("document not found");
    if (!(await this.canWrite(id))) throw new DocumentWriteDeniedError();
    const edited = applyEditToState(
      doc.ydocState,
      transform,
      this.authorInfo(),
      doc.contentMd,
    );
    return this.exec(async (db) => {
      const [row] = await db
        .update(documents)
        .set({
          ydocState: edited.ydocState,
          contentMd: edited.contentMd,
          contentJson: edited.contentJson,
          updatedAt: new Date(),
        })
        .where(and(eq(documents.id, id), isNull(documents.deletedAt)))
        .returning();
      if (!row) throw new DocumentWriteDeniedError();
      return row;
    });
  }

  /** Persist the live Yjs state + derived read model (Hocuspocus onStoreDocument). */
  async saveCollabSnapshot(
    id: string,
    snapshot: { ydocState: Uint8Array; contentMd: string; contentJson: unknown },
  ): Promise<{ workspaceId: string } | null> {
    return this.exec(async (db) => {
      const rows = await db
        .update(documents)
        .set({
          ydocState: snapshot.ydocState,
          contentMd: snapshot.contentMd,
          contentJson: snapshot.contentJson,
          updatedAt: new Date(),
        })
        // Don't let a debounced store resurrect a soft-deleted document.
        .where(and(eq(documents.id, id), isNull(documents.deletedAt)))
        .returning({ id: documents.id, workspaceId: documents.workspaceId });
      if (rows.length === 0) {
        // Deleted docs are intentionally skipped. Anything else means RLS
        // filtered the write (read-only actor) — fail loud, don't drop data.
        const [existing] = await db
          .select({ id: documents.id })
          .from(documents)
          .where(and(eq(documents.id, id), isNull(documents.deletedAt)));
        if (existing) throw new DocumentWriteDeniedError();
        return null;
      }
      return { workspaceId: rows[0]!.workspaceId };
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
          throw new InvalidInputError("a document cannot be its own parent");
        }
        // The new parent must live in the same collection (keeps the tree
        // consistent and prevents cross-collection/tenant parent edges).
        const [parent] = await db
          .select({ collectionId: documents.collectionId })
          .from(documents)
          .where(and(eq(documents.id, target.parentDocumentId), isNull(documents.deletedAt)));
        if (!parent || parent.collectionId !== doc.collectionId) {
          throw new InvalidInputError("parent must be a document in the same collection");
        }

        // Reject moving id into one of its own descendants (would create a cycle).
        const result = await db.execute(sql`
          WITH RECURSIVE subtree AS (
            SELECT id FROM documents WHERE id = ${id}
            UNION ALL
            SELECT d.id FROM documents d JOIN subtree s ON d.parent_document_id = s.id
          )
          SELECT 1 FROM subtree WHERE id = ${target.parentDocumentId} LIMIT 1
        `);
        // execute()'s row shape differs by driver: an array for postgres-js, a
        // { rows } object for PGlite — same normalization workspaces.ts uses.
        const rows = (Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows) ?? [];
        if (rows.length > 0) {
          throw new InvalidInputError("cannot move a document into one of its own descendants");
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

  /** Stamp a column on a document AND all its descendants (subtree ops keep
   * the tree consistent: a child can't stay active under an archived parent).
   * Runs RLS-scoped, so it only touches rows the actor may write. */
  private async stampSubtree(
    db: Database,
    id: string,
    column: "archived_at" | "deleted_at",
    value: Date | null,
  ): Promise<void> {
    await db.execute(sql`
      WITH RECURSIVE subtree AS (
        SELECT id FROM documents WHERE id = ${id}
        UNION ALL
        SELECT d.id FROM documents d JOIN subtree s ON d.parent_document_id = s.id
      )
      UPDATE documents
      SET ${sql.raw(column)} = ${value}, updated_at = now()
      WHERE id IN (SELECT id FROM subtree) AND deleted_at IS NULL
    `);
  }

  /** Archive a document and its descendants (hidden from the tree/search,
   * recoverable via restore). Returns null if the actor may not write it. */
  async archive(id: string): Promise<Document | null> {
    return this.exec(async (db) => {
      await this.stampSubtree(db, id, "archived_at", new Date());
      const [row] = await db
        .select()
        .from(documents)
        .where(and(eq(documents.id, id), isNull(documents.deletedAt)));
      return row?.archivedAt ? row : null;
    });
  }

  /** Un-archive a document and its descendants. */
  async restore(id: string): Promise<Document | null> {
    return this.exec(async (db) => {
      await this.stampSubtree(db, id, "archived_at", null);
      const [row] = await db
        .select()
        .from(documents)
        .where(and(eq(documents.id, id), isNull(documents.deletedAt)));
      return row && !row.archivedAt ? row : null;
    });
  }

  /** Soft-delete a document and its descendants. Returns false if nothing was
   * deleted (missing or not writable). */
  async softDelete(id: string): Promise<boolean> {
    return this.exec(async (db) => {
      await this.stampSubtree(db, id, "deleted_at", new Date());
      const [row] = await db
        .select({ id: documents.id })
        .from(documents)
        .where(and(eq(documents.id, id), isNull(documents.deletedAt)));
      return !row;
    });
  }

  async listByCollection(collectionId: string): Promise<DocumentMeta[]> {
    return this.exec((db) =>
      db
        .select(DocumentService.metaColumns)
        .from(documents)
        .where(
          and(
            eq(documents.collectionId, collectionId),
            isNull(documents.deletedAt),
            isNull(documents.archivedAt),
          ),
        )
        .orderBy(asc(documents.position)),
    );
  }

  /** Archived subtree roots in a collection (their descendants restore with them). */
  async listArchived(collectionId: string): Promise<DocumentMeta[]> {
    return this.exec(async (db) => {
      const parent = alias(documents, "parent");
      return db
        .select(DocumentService.metaColumns)
        .from(documents)
        .leftJoin(parent, eq(parent.id, documents.parentDocumentId))
        .where(
          and(
            eq(documents.collectionId, collectionId),
            isNull(documents.deletedAt),
            sql`${documents.archivedAt} IS NOT NULL`,
            sql`(${documents.parentDocumentId} IS NULL OR ${parent.archivedAt} IS NULL OR ${parent.deletedAt} IS NOT NULL)`,
          ),
        )
        .orderBy(desc(documents.archivedAt));
    });
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
      else if (!node.parentDocumentId) roots.push(node);
      // A child whose parent is filtered out (archived separately) is omitted
      // rather than promoted to a fake root.
    }
    return roots;
  }

  /** Full-text search over titles (weight A) and bodies (weight B). Returns
   * metadata + a highlighted snippet — never the body/binary columns (results
   * ship to browsers and agents). */
  async search(
    query: string,
    opts: SearchOptions = {},
  ): Promise<Array<DocumentMeta & { rank: number; snippet: string }>> {
    // Prefix-match every term: the index uses the un-stemmed 'simple' config,
    // so "Read" must still find "Reading the river" while someone types.
    const terms = query.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.slice(0, 8) ?? [];
    const tag = opts.tag?.trim();
    // A tag on its own is a valid search (browse by label); text alone or both.
    if (terms.length === 0 && !tag) return [];
    return this.exec((db) => {
      const tagFilter = tag ? sql`${documents.tags} @> ARRAY[${tag}]::text[]` : undefined;
      const base = and(
        isNull(documents.deletedAt),
        isNull(documents.archivedAt),
        opts.collectionId ? eq(documents.collectionId, opts.collectionId) : undefined,
        tagFilter,
      );

      // Tag-only browse: no text ranking, newest first, no snippet.
      if (terms.length === 0) {
        const zero = sql<number>`0`;
        const empty = sql<string>`''`;
        return db
          .select({ ...DocumentService.metaColumns, rank: zero, snippet: empty })
          .from(documents)
          .where(base)
          .orderBy(desc(documents.updatedAt))
          .limit(opts.limit ?? 20);
      }

      const prefixQuery = terms.map((t) => `'${t}':*`).join(" & ");
      const tsquery = sql`to_tsquery('simple', ${prefixQuery})`;
      const rank = sql<number>`ts_rank(${documents.searchVector}, ${tsquery})`;
      // Highlight delimiters are control chars (chr 2/3): impossible in the
      // text itself, so clients can mark fragments without parsing HTML.
      const snippet = sql<string>`ts_headline('simple', ${documents.contentMd}, ${tsquery}, 'MaxFragments=2, MaxWords=16, MinWords=6, StartSel=' || chr(2) || ', StopSel=' || chr(3))`;
      return db
        .select({ ...DocumentService.metaColumns, rank, snippet })
        .from(documents)
        .where(and(sql`${documents.searchVector} @@ ${tsquery}`, base))
        .orderBy(desc(rank))
        .limit(opts.limit ?? 20);
    });
  }

  /** Every distinct tag across the documents this actor can read (RLS-scoped),
   * for tag autocomplete. Excludes archived/deleted. */
  async listTags(): Promise<string[]> {
    const rows = await this.exec((db) =>
      db
        .select({ tag: sql<string>`unnest(${documents.tags})` })
        .from(documents)
        .where(and(isNull(documents.deletedAt), isNull(documents.archivedAt))),
    );
    return [...new Set(rows.map((r) => r.tag))].sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase()),
    );
  }

  /** Documents that reference this one (a `[title](/d/<id>)` link in their
   * markdown — what pageRef nodes serialize to). RLS-scoped: you only see
   * referencing documents you could open anyway. */
  async backlinks(id: string): Promise<DocumentMeta[]> {
    return this.exec((db) =>
      db
        .select(DocumentService.metaColumns)
        .from(documents)
        .where(
          and(
            isNull(documents.deletedAt),
            isNull(documents.archivedAt),
            ne(documents.id, id),
            like(documents.contentMd, `%](/d/${id})%`),
          ),
        )
        .orderBy(desc(documents.updatedAt))
        .limit(50),
    );
  }

  /**
   * Tasks assigned to the current user across every document they can read
   * (RLS scopes the scan). A task is assigned via an `@mention` of the user's
   * email or its local part: `- [ ] @alice ship the thing`.
   */
  async listMyTodos(): Promise<TodoItem[]> {
    if (this.actor.kind !== "user") throw new ForbiddenError("requires a user actor");
    const userId = this.actor.userId;
    // Email lookup runs system-scoped: the auth user table isn't RLS-granted.
    const [me] = await runAsActor(this.db, SYSTEM, (db) =>
      db.select({ email: user.email }).from(user).where(eq(user.id, userId)),
    );
    if (!me) return [];
    const email = me.email.toLowerCase();
    const handles = new Set([email, email.split("@")[0]!]);

    const rows = await this.exec((db) =>
      db
        .select({
          id: documents.id,
          title: documents.title,
          collectionId: documents.collectionId,
          workspaceId: documents.workspaceId,
          contentMd: documents.contentMd,
        })
        .from(documents)
        .where(
          and(
            isNull(documents.deletedAt),
            isNull(documents.archivedAt),
            // Cheap prefilter; exact matching happens in the parser below.
            sql`${documents.contentMd} LIKE '%- [%'`,
          ),
        ),
    );

    const todos: TodoItem[] = [];
    for (const row of rows) {
      for (const task of scanTaskItems(row.contentMd)) {
        if (!task.mentions.some((m) => handles.has(m))) continue;
        todos.push({
          documentId: row.id,
          documentTitle: row.title,
          collectionId: row.collectionId,
          workspaceId: row.workspaceId,
          line: task.line,
          text: task.text,
          done: task.done,
        });
      }
    }
    return todos;
  }
}
