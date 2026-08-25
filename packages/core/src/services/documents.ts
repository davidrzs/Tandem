import { ForbiddenError, InvalidInputError, NotFoundError } from "../errors.js";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  like,
  lt,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
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
  /** Drop these documents — typically the one the caller is working from,
   * which tends to quote its own queries verbatim. */
  excludeIds?: string[];
  /** Drop documents carrying any of these tags (exact, case-sensitive). */
  excludeTags?: string[];
}

/** A tag with the number of active, readable documents carrying it. */
export interface TagCount {
  tag: string;
  count: number;
}

export type SearchMatchKind =
  | "tag"
  | "title_phrase"
  | "phrase"
  | "all_terms"
  | "partial_terms"
  | "fuzzy_title";

/** Search result diagnostics are deliberately lexical and deterministic: MCP
 * clients can see exactly which terms matched and decide whether to retry. */
export interface SearchHit extends DocumentMeta {
  rank: number;
  snippet: string;
  matchedTerms: string[];
  fuzzyTitleTerms: string[];
  totalTerms: number;
  matchKind: SearchMatchKind;
  collectionName: string;
  /** Collection + active ancestor titles + the result title. */
  path: string;
}

export interface RecentDocumentsOptions {
  collectionId?: string;
  /** Only return documents updated strictly after this instant. */
  updatedAfter?: Date;
  /** Keyset cursor: return documents older than this document. */
  before?: { updatedAt: Date; id: string };
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
  | "tags"
  | "createdAt"
  | "updatedAt"
  | "archivedAt"
  | "deletedAt"
>;

export interface DocumentNode extends DocumentMeta {
  children: DocumentNode[];
}

/** One document's bounded descendants plus the titles leading down to it. */
export interface DocumentSubtree {
  root: DocumentMeta;
  /** Collection-relative titles from the top-level ancestor to the root itself. */
  ancestry: string[];
  nodes: DocumentNode[];
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

/** Rows of a raw `db.execute`, whichever shape the driver hands back. */
function rowsOf<T>(result: unknown): T[] {
  const rows = Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows;
  return (rows ?? []) as T[];
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
  static readonly metaColumns = {
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

  /** Cheap workspace-level existence check for first-run UI. RLS still
   * limits the answer to documents the actor can read. */
  async hasAnyInWorkspace(workspaceId: string): Promise<boolean> {
    return this.exec(async (db) => {
      const [row] = await db
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            eq(documents.workspaceId, workspaceId),
            isNull(documents.deletedAt),
            isNull(documents.archivedAt),
          ),
        )
        .limit(1);
      return !!row;
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
        // Same rule as move(): the parent must be an active document in the
        // same collection (the FK alone runs as table owner and would accept
        // a cross-tenant uuid; a child under an archived parent would vanish
        // from the tree while staying searchable).
        const [parent] = await db
          .select({ collectionId: documents.collectionId })
          .from(documents)
          .where(
            and(eq(documents.id, parentId), isNull(documents.deletedAt), isNull(documents.archivedAt)),
          );
        if (!parent || parent.collectionId !== input.collectionId) {
          throw new InvalidInputError("parent must be an active document in the same collection");
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

  /** Copy a document's current content into a new sibling ("Title (copy)"),
   * created as — and fully attributed to — the acting user. Children are not
   * copied; the RLS write check on create() authorizes the whole operation. */
  async duplicate(id: string): Promise<Document> {
    const doc = await this.get(id);
    if (!doc) throw new NotFoundError("document not found");
    return this.create({
      collectionId: doc.collectionId,
      parentDocumentId: doc.parentDocumentId,
      title: `${doc.title || "Untitled"} (copy)`,
      markdown: this.toMarkdown(doc),
      tags: doc.tags ?? undefined,
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
        // The new parent must be active and live in the same collection (keeps
        // the tree consistent and prevents cross-collection/tenant parent edges).
        const [parent] = await db
          .select({ collectionId: documents.collectionId })
          .from(documents)
          .where(
            and(
              eq(documents.id, target.parentDocumentId),
              isNull(documents.deletedAt),
              isNull(documents.archivedAt),
            ),
          );
        if (!parent || parent.collectionId !== doc.collectionId) {
          throw new InvalidInputError("parent must be an active document in the same collection");
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
    // Raw-SQL params skip drizzle's column mapping, and postgres-js won't
    // serialize a Date it gets that way (PGlite does — tests alone won't catch
    // it). Bind ISO text; Postgres casts it against the column type.
    const stamp = value ? value.toISOString() : null;
    await db.execute(sql`
      WITH RECURSIVE subtree AS (
        SELECT id FROM documents WHERE id = ${id}
        UNION ALL
        SELECT d.id FROM documents d JOIN subtree s ON d.parent_document_id = s.id
      )
      UPDATE documents
      SET ${sql.raw(column)} = ${stamp}, updated_at = now()
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

  /** Load only the requested hierarchy levels below `rootId` (the collection's
   * top level when null). This keeps shallow MCP orientation requests from
   * reading every descendant in a large collection; the unbounded tree() path
   * remains available to the first-party UI/export. Takes the actor-scoped db
   * so subtree() can compose it with its root lookup in one transaction. */
  private async levels(
    db: Database,
    collectionId: string,
    maxDepth: number,
    rootId: string | null = null,
  ): Promise<DocumentMeta[]> {
    const active = [
      eq(documents.collectionId, collectionId),
      isNull(documents.deletedAt),
      isNull(documents.archivedAt),
    ] as const;
    const roots = await db
      .select(DocumentService.metaColumns)
      .from(documents)
      .where(
        and(
          ...active,
          rootId ? eq(documents.parentDocumentId, rootId) : isNull(documents.parentDocumentId),
        ),
      )
      .orderBy(asc(documents.position), asc(documents.id));
    const rows = [...roots];
    let parentIds = roots.map((row) => row.id);
    for (let depth = 2; depth <= maxDepth && parentIds.length > 0; depth += 1) {
      const level = await db
        .select(DocumentService.metaColumns)
        .from(documents)
        .where(and(...active, inArray(documents.parentDocumentId, parentIds)))
        .orderBy(asc(documents.position), asc(documents.id));
      rows.push(...level);
      parentIds = level.map((row) => row.id);
    }
    return rows;
  }

  /** Nest a flat, active-only listing under its parents. `rootParentId` is the
   * parent the top level hangs from (null for collection roots). A child whose
   * parent is missing (archived separately) is omitted rather than promoted to
   * a fake root. */
  private static nest(flat: DocumentMeta[], rootParentId: string | null): DocumentNode[] {
    const byId = new Map<string, DocumentNode>();
    for (const d of flat) byId.set(d.id, { ...d, children: [] });
    const roots: DocumentNode[] = [];
    for (const node of byId.values()) {
      if (node.parentDocumentId === rootParentId) roots.push(node);
      else if (node.parentDocumentId) byId.get(node.parentDocumentId)?.children.push(node);
    }
    return roots;
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

  async tree(collectionId: string, maxDepth?: number): Promise<DocumentNode[]> {
    if (maxDepth !== undefined && (!Number.isInteger(maxDepth) || maxDepth < 1)) {
      throw new InvalidInputError("tree depth must be a positive integer");
    }
    const flat =
      maxDepth === undefined
        ? await this.listByCollection(collectionId)
        : await this.exec((db) => this.levels(db, collectionId, maxDepth));
    return DocumentService.nest(flat, null);
  }

  /** The active descendants of one document, `maxDepth` levels below it —
   * bounded subtree navigation without reading the rest of the collection.
   * `ancestry` (top-level ancestor … the root's own title) lets callers print
   * collection-relative paths for the entries. */
  async subtree(rootId: string, maxDepth: number): Promise<DocumentSubtree> {
    if (!Number.isInteger(maxDepth) || maxDepth < 1) {
      throw new InvalidInputError("subtree depth must be a positive integer");
    }
    return this.exec(async (db) => {
      const [root] = await db
        .select(DocumentService.metaColumns)
        .from(documents)
        .where(
          and(eq(documents.id, rootId), isNull(documents.deletedAt), isNull(documents.archivedAt)),
        );
      if (!root) throw new NotFoundError("document not found");
      const ancestry = (await this.searchPaths(db, [rootId])).get(rootId) ?? [
        root.title || "Untitled",
      ];
      const flat = await this.levels(db, root.collectionId, maxDepth, rootId);
      return { root, ancestry, nodes: DocumentService.nest(flat, rootId) };
    });
  }

  /** Recently changed active documents, ordered newest-first with a stable
   * `(updated_at, id)` keyset cursor. The query is RLS-scoped and metadata-only. */
  async recent(opts: RecentDocumentsOptions = {}): Promise<DocumentMeta[]> {
    return this.exec((db) => {
      const before = opts.before
        ? or(
            lt(documents.updatedAt, opts.before.updatedAt),
            and(
              eq(documents.updatedAt, opts.before.updatedAt),
              lt(documents.id, opts.before.id),
            ),
          )
        : undefined;
      return db
        .select(DocumentService.metaColumns)
        .from(documents)
        .where(
          and(
            isNull(documents.deletedAt),
            isNull(documents.archivedAt),
            opts.collectionId ? eq(documents.collectionId, opts.collectionId) : undefined,
            opts.updatedAfter ? gt(documents.updatedAt, opts.updatedAfter) : undefined,
            before,
          ),
        )
        .orderBy(desc(documents.updatedAt), desc(documents.id))
        .limit(opts.limit ?? 20);
    });
  }

  /** Resolve readable ancestor paths for a bounded set of search hits in one
   * recursive query. The supplied db is the actor-scoped transaction, so RLS
   * applies to ancestors exactly as it does to the hits themselves. */
  private async searchPaths(
    db: Database,
    ids: readonly string[],
  ): Promise<Map<string, string[]>> {
    if (ids.length === 0) return new Map();
    const result = await db.execute(sql`
      WITH RECURSIVE document_paths AS (
        SELECT
          d.id AS leaf_id,
          d.parent_document_id,
          ARRAY[coalesce(nullif(d.title, ''), 'Untitled')]::text[] AS parts
        FROM documents d
        WHERE d.id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
          AND d.deleted_at IS NULL
          AND d.archived_at IS NULL

        UNION ALL

        SELECT
          path.leaf_id,
          parent.parent_document_id,
          ARRAY[coalesce(nullif(parent.title, ''), 'Untitled')]::text[] || path.parts
        FROM document_paths path
        JOIN documents parent ON parent.id = path.parent_document_id
        WHERE parent.deleted_at IS NULL
          AND parent.archived_at IS NULL
      )
      SELECT leaf_id, parts
      FROM document_paths
      WHERE parent_document_id IS NULL
    `);
    return new Map(
      rowsOf<{ leaf_id: string; parts: string[] }>(result).map((row) => [row.leaf_id, row.parts]),
    );
  }

  /** Attach the "Collection / Ancestor / Title" breadcrumb to search rows. */
  private async withPaths<T extends { id: string; title: string; collectionName: string }>(
    db: Database,
    rows: T[],
  ): Promise<Array<T & { path: string }>> {
    const paths = await this.searchPaths(db, rows.map((row) => row.id));
    return rows.map((row) => ({
      ...row,
      path: [row.collectionName, ...(paths.get(row.id) ?? [row.title || "Untitled"])].join(" / "),
    }));
  }

  /** Native Postgres search over title/body FTS plus pg_trgm title fuzziness.
   * Retrieval is deliberately broad (any lexical term); phrase/all-term/title
   * matches are ranking boosts, not gates. Never returns body/binary columns. */
  async search(
    query: string,
    opts: SearchOptions = {},
  ): Promise<SearchHit[]> {
    // Prefix-match every term: the index uses the un-stemmed 'simple' config,
    // so "Read" must still find "Reading the river" while someone types.
    const terms = [
      ...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []),
    ].slice(0, 8);
    const tag = opts.tag?.trim();
    const excludeIds = opts.excludeIds ?? [];
    const excludeTags = (opts.excludeTags ?? []).map((t) => t.trim()).filter(Boolean);
    // A tag on its own is a valid search (browse by label); text alone or both.
    if (terms.length === 0 && !tag) return [];
    return this.exec(async (db) => {
      const tagFilter = tag ? sql`${documents.tags} @> ARRAY[${tag}]::text[]` : undefined;
      // Exclusions keep documents that merely QUOTE the query (a backlog of
      // example searches, notes about a query) out of the way: lexical ranking
      // cannot tell those apart from the documents that answer it.
      const excludeTagFilter =
        excludeTags.length > 0
          ? sql`NOT (${documents.tags} && ARRAY[${sql.join(
              excludeTags.map((t) => sql`${t}`),
              sql`, `,
            )}]::text[])`
          : undefined;
      const base = and(
        isNull(documents.deletedAt),
        isNull(documents.archivedAt),
        opts.collectionId ? eq(documents.collectionId, opts.collectionId) : undefined,
        tagFilter,
        excludeIds.length > 0 ? notInArray(documents.id, excludeIds) : undefined,
        excludeTagFilter,
      );

      // Tag-only browse: no text ranking, newest first, no snippet.
      if (terms.length === 0) {
        const rows = await db
          .select({
            ...DocumentService.metaColumns,
            rank: sql<number>`0`,
            snippet: sql<string>`''`,
            matchedTerms: sql<string[]>`ARRAY[]::text[]`,
            fuzzyTitleTerms: sql<string[]>`ARRAY[]::text[]`,
            totalTerms: sql<number>`0`,
            matchKind: sql<SearchMatchKind>`'tag'`,
            collectionName: collections.name,
          })
          .from(documents)
          .innerJoin(collections, eq(collections.id, documents.collectionId))
          .where(base)
          .orderBy(desc(documents.updatedAt))
          .limit(opts.limit ?? 20);
        return this.withPaths(db, rows);
      }

      const termQueries = terms.map((term) =>
        sql`to_tsquery('simple', ${`'${term}':*`})`,
      );
      const broadQuery = sql`to_tsquery('simple', ${terms.map((t) => `'${t}':*`).join(" | ")})`;
      const strictQuery = sql`to_tsquery('simple', ${terms.map((t) => `'${t}':*`).join(" & ")})`;
      const phraseQuery = sql`to_tsquery('simple', ${terms.map((t) => `'${t}':*`).join(" <-> ")})`;
      const titleVector = sql`to_tsvector('simple', coalesce(${documents.title}, ''))`;
      const matchedCount = sql<number>`(${sql.join(
        termQueries.map(
          (termQuery) => sql`CASE WHEN ${documents.searchVector} @@ ${termQuery} THEN 1 ELSE 0 END`,
        ),
        sql` + `,
      )})`;
      const matchedTerms = sql<string[]>`array_remove(ARRAY[${sql.join(
        termQueries.map(
          (termQuery, index) =>
            sql`CASE WHEN ${documents.searchVector} @@ ${termQuery} THEN ${terms[index]!} ELSE NULL END`,
        ),
        sql`, `,
      )}]::text[], NULL)`;
      // Short inputs generate weak/noisy trigrams; FTS prefix search already
      // handles them better. Word similarity compares each term to a title span.
      const fuzzyTerms = terms.filter((term) => term.length >= 4);
      const fuzzyConditions = fuzzyTerms.map(
        (term) => sql`${term} <% lower(${documents.title})`,
      );
      const fuzzyFilter =
        fuzzyConditions.length > 0
          ? sql`(${sql.join(fuzzyConditions, sql` OR `)})`
          : sql`false`;
      const fuzzyTitleTerms = sql<string[]>`array_remove(ARRAY[${sql.join(
        fuzzyTerms.map((term) => {
          const termQuery = termQueries[terms.indexOf(term)]!;
          return sql`CASE WHEN NOT (${documents.searchVector} @@ ${termQuery}) AND ${term} <% lower(${documents.title}) THEN ${term} ELSE NULL END`;
        }),
        sql`, `,
      )}]::text[], NULL)`;
      const bestTitleSimilarity =
        fuzzyTerms.length > 0
          ? sql<number>`greatest(${sql.join(
              [sql`0::real`, ...fuzzyTerms.map(
                (term) => sql`word_similarity(${term}, lower(${documents.title}))`,
              )],
              sql`, `,
            )})`
          : sql<number>`0::real`;
      const titlePhrase = sql`${titleVector} @@ ${phraseQuery}`;
      const phraseMatch = sql`${documents.searchVector} @@ ${phraseQuery}`;
      const strictMatch = sql`${documents.searchVector} @@ ${strictQuery}`;
      const normalizedRank = sql<number>`ts_rank_cd(${documents.searchVector}, ${broadQuery}, 32)`;
      const rank = sql<number>`(
        CASE WHEN ${titlePhrase} THEN 8.0 ELSE 0.0 END
        + CASE WHEN ${phraseMatch} THEN 4.0 ELSE 0.0 END
        + CASE WHEN ${strictMatch} THEN 2.0 ELSE 0.0 END
        + (2.0 * ${matchedCount}::double precision / ${terms.length})
        + ${normalizedRank}::double precision
        + (0.5 * ${bestTitleSimilarity}::double precision)
      )`;
      const matchKind = sql<SearchMatchKind>`CASE
        WHEN ${titlePhrase} THEN 'title_phrase'
        WHEN ${phraseMatch} THEN 'phrase'
        WHEN ${strictMatch} THEN 'all_terms'
        WHEN ${matchedCount} > 0 THEN 'partial_terms'
        ELSE 'fuzzy_title'
      END`;
      // Highlight delimiters are control chars (chr 2/3): impossible in the
      // text itself, so clients can mark fragments without parsing HTML.
      const snippet = sql<string>`ts_headline('simple', ${documents.contentMd}, ${broadQuery}, 'MaxFragments=2, MaxWords=16, MinWords=6, StartSel=' || chr(2) || ', StopSel=' || chr(3))`;
      const rows = await db
        .select({
          ...DocumentService.metaColumns,
          rank,
          snippet,
          matchedTerms,
          fuzzyTitleTerms,
          totalTerms: sql<number>`${terms.length}::integer`,
          matchKind,
          collectionName: collections.name,
        })
        .from(documents)
        .innerJoin(collections, eq(collections.id, documents.collectionId))
        .where(
          and(
            base,
            sql`(${documents.searchVector} @@ ${broadQuery} OR ${fuzzyFilter})`,
          ),
        )
        .orderBy(desc(rank), desc(documents.updatedAt), asc(documents.id))
        .limit(opts.limit ?? 20);
      return this.withPaths(db, rows);
    });
  }

  /** Every distinct tag across the documents this actor can read (RLS-scoped)
   * with how many active documents carry it, sorted by name — for tag
   * autocomplete and agent-side browsing. Excludes archived/deleted. */
  async listTags(): Promise<TagCount[]> {
    const result = await this.exec((db) =>
      db.execute(sql`
        SELECT t.tag, count(DISTINCT d.id)::int AS count
        FROM documents d, unnest(d.tags) AS t(tag)
        WHERE d.deleted_at IS NULL AND d.archived_at IS NULL
        GROUP BY t.tag
      `),
    );
    return rowsOf<TagCount>(result).sort((a, b) =>
      a.tag.toLowerCase().localeCompare(b.tag.toLowerCase()),
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
