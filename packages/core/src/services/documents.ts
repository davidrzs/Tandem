import { ForbiddenError, InvalidInputError, NotFoundError } from "../errors.js";
import { and, eq, gt, inArray, isNull, notInArray, sql } from "drizzle-orm";
import {
  collections,
  documents,
  instanceSettings,
  tasks,
  type Database,
  type Document,
  type DocumentOrigin,
} from "@tandem/db";
import {
  applyEditToState,
  diffProperties,
  stateProperties,
  type AuthorInfo,
  type ProjectedTask,
  type PropertiesJSON,
  type PropertyOp,
  type StateEdit,
} from "@tandem/editor";
import { jsonToMarkdown, markdownToJSON } from "../markdown.js";
import {
  DocumentServiceBase,
  documentMetaColumns,
  lockTree,
  nextPosition,
  notTemplate,
} from "./document-tree-internals.js";
import { projectionColumns } from "./types.js";

export interface CreateDocumentInput {
  collectionId: string;
  parentDocumentId?: string | null;
  title?: string;
  markdown?: string;
  tags?: string[];
  /** Validated by TypeService.planCreate. */
  typeId?: string | null;
  /** Initial values as a patch (TypeService.planCreate builds it). */
  properties?: readonly PropertyOp[];
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
  | "defaultTemplateId"
  | "typeId"
  | "createdAt"
  | "updatedAt"
  | "archivedAt"
  | "deletedAt"
>;

/** Make the page's `tasks` rows match `rows`: insert new items, update the
 * changed ones (stamping `closed_at` when one is first seen done), delete the
 * rest. New rows are stamped `at`: now for a save, the page's last save for
 * the backfill. Runs inside the transaction that writes the page. */
export async function writeTaskRows(
  db: Database,
  documentId: string,
  rows: readonly ProjectedTask[],
  at = new Date(),
): Promise<void> {
  if (rows.length > 0) {
    const now = new Date();
    await db
      .insert(tasks)
      .values(
        rows.map((row) => ({
          documentId,
          blockId: row.blockId,
          text: row.text,
          done: row.done,
          handles: row.handles,
          position: row.position,
          createdBy: row.createdBy,
          ai: row.ai,
          createdAt: at,
          updatedAt: now,
          closedAt: row.done ? at : null,
        })),
      )
      .onConflictDoUpdate({
        target: [tasks.documentId, tasks.blockId],
        set: {
          text: sql`excluded.text`,
          done: sql`excluded.done`,
          handles: sql`excluded.handles`,
          position: sql`excluded.position`,
          createdBy: sql`excluded.created_by`,
          ai: sql`excluded.ai`,
          updatedAt: now,
          closedAt: sql`CASE WHEN NOT excluded.done THEN NULL WHEN ${tasks.done} THEN ${tasks.closedAt} ELSE excluded.closed_at END`,
        },
        setWhere: sql`(${tasks.text}, ${tasks.done}, ${tasks.handles}, ${tasks.position}, ${tasks.createdBy}, ${tasks.ai}) IS DISTINCT FROM (excluded.text, excluded.done, excluded.handles, excluded.position, excluded.created_by, excluded.ai)`,
      });
  }
  await db.delete(tasks).where(
    and(
      eq(tasks.documentId, documentId),
      rows.length > 0 ? notInArray(tasks.blockId, rows.map((row) => row.blockId)) : undefined,
    ),
  );
}

const BACKFILL_BATCH = 200;

/**
 * Project the tasks of pages last saved before the `tasks` table existed:
 * pages with a task-like line and no rows. Their items get block ids, written
 * back into ydoc_state, so later saves keep the same rows, and are stamped
 * with the page's last save so they don't read as new or newly closed. Runs
 * once per instance, at boot, before any live session can hold one of these
 * pages; a page that fails is logged and left for its next save. Returns the
 * pages projected.
 */
export async function backfillTaskRows(
  db: Database,
  log: (message: string) => void = console.error,
): Promise<number> {
  const [settings] = await db.select({ done: instanceSettings.tasksBackfilledAt }).from(instanceSettings);
  if (settings?.done) return 0;
  let projected = 0;
  let after: string | null = null;
  for (;;) {
    const batch: Array<{ id: string }> = await db
      .select({ id: documents.id })
      .from(documents)
      .where(
        and(
          after ? gt(documents.id, after) : undefined,
          sql`${documents.contentMd} ~ '\\[[ xX]\\] '`,
          sql`NOT EXISTS (SELECT 1 FROM tasks t WHERE t.document_id = ${documents.id})`,
        ),
      )
      .orderBy(documents.id)
      .limit(BACKFILL_BATCH);
    for (const { id } of batch) {
      try {
        if (await backfillPage(db, id)) projected++;
      } catch (err) {
        log(`task backfill skipped page ${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (batch.length < BACKFILL_BATCH) break;
    after = batch[batch.length - 1]!.id;
  }
  const doneAt = new Date();
  await db
    .insert(instanceSettings)
    .values({ id: true, tasksBackfilledAt: doneAt })
    .onConflictDoUpdate({ target: instanceSettings.id, set: { tasksBackfilledAt: doneAt } });
  return projected;
}

/** One page in its own short transaction, its row locked so a save from
 * another instance waits instead of being overwritten. */
function backfillPage(db: Database, id: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const page = tx as unknown as Database;
    const [doc] = await page
      .select({ ydocState: documents.ydocState, contentMd: documents.contentMd, updatedAt: documents.updatedAt })
      .from(documents)
      .where(eq(documents.id, id))
      .for("update");
    if (!doc) return false;
    const author = { userId: "system", name: "System", ai: true, at: Date.now() };
    const edited = applyEditToState(doc.ydocState, {}, author, doc.contentMd);
    if (edited.tasks.length === 0) return false;
    await page.update(documents).set({ ydocState: edited.ydocState }).where(eq(documents.id, id));
    await writeTaskRows(page, id, edited.tasks, doc.updatedAt);
    return true;
  });
}

/** Derive the persisted read-model fields (content_md + content_json) from markdown. */
function deriveContent(markdown: string): { contentMd: string; contentJson: unknown } {
  const contentJson = markdownToJSON(markdown);
  return { contentMd: jsonToMarkdown(contentJson), contentJson };
}

/** create() plus the fields only template instantiation sets. */
export interface InsertDocumentInput extends CreateDocumentInput {
  defaultTemplateId?: string | null;
  origin?: DocumentOrigin;
}

/** Insert one document inside the caller's actor-scoped transaction, its body
 * seeded into Yjs as `author`'s writing. */
export async function insertDocument(
  db: Database,
  input: InsertDocumentInput,
  author: AuthorInfo,
): Promise<Document> {
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
  await lockTree(db, input.collectionId);
  const position = await nextPosition(db, input.collectionId, parentId);
  // Seed the Yjs write model at creation so the initial content is
  // attributed to its creator (not to whoever opens the doc first).
  const body = input.markdown?.trim() ? () => input.markdown! : undefined;
  const seeded =
    body || input.properties?.length
      ? applyEditToState(null, { body, properties: input.properties }, author)
      : null;
  const { contentMd, contentJson } = seeded ?? deriveContent("");
  const projected = await projectionColumns(db, col.workspaceId, seeded?.properties ?? {});
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
      defaultTemplateId: input.defaultTemplateId ?? null,
      origin: input.origin ?? null,
      typeId: input.typeId ?? null,
      ...projected,
    })
    .returning();
  await writeTaskRows(db, row!.id, seeded?.tasks ?? []);
  return row!;
}

export class DocumentService extends DocumentServiceBase {
  /** Columns safe to ship to clients — excludes content_md/json, ydoc_state, search_vector. */
  static readonly metaColumns = documentMetaColumns;

  /** Metadata of the live (not trashed, not archived, not template) documents
   * among `ids` that this actor can read; the rest are simply absent. Order is
   * not preserved — callers key by id. */
  async getMetaMany(ids: string[]): Promise<DocumentMeta[]> {
    if (ids.length === 0) return [];
    return this.exec((db) =>
      db
        .select(documentMetaColumns)
        .from(documents)
        .where(
          and(
            inArray(documents.id, ids),
            isNull(documents.deletedAt),
            isNull(documents.archivedAt),
            notTemplate,
          ),
        ),
    );
  }

  /** Metadata only (no body/binary) — for the editor header. */
  async getMeta(id: string): Promise<DocumentMeta | null> {
    return this.exec(async (db) => {
      const [row] = await db
        .select(documentMetaColumns)
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

  async create(input: CreateDocumentInput): Promise<Document> {
    return this.execTx((db) => insertDocument(db, input, this.authorInfo()));
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

  /** Copy a document's current content, type and properties into a new
   * sibling ("Title (copy)"), created as — and fully attributed to — the
   * acting user. Children are not copied; the RLS write check on create()
   * authorizes the whole operation. */
  async duplicate(id: string): Promise<Document> {
    const doc = await this.get(id);
    if (!doc) throw new NotFoundError("document not found");
    return this.create({
      collectionId: doc.collectionId,
      parentDocumentId: doc.parentDocumentId,
      title: `${doc.title || "Untitled"} (copy)`,
      markdown: this.toMarkdown(doc),
      tags: doc.tags ?? undefined,
      typeId: doc.typeId,
      properties: diffProperties({}, doc.ydocState ? stateProperties(doc.ydocState) : {}),
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
    return this.editState(id, { body: transform });
  }

  /** Property patch for writers without a live collaboration session; the
   * same contract as editBody. */
  async editProperties(id: string, ops: readonly PropertyOp[]): Promise<Document> {
    return this.editState(id, { properties: ops });
  }

  private async editState(id: string, edit: StateEdit): Promise<Document> {
    // Read, transform and write under one row lock: two concurrent fallback
    // edits would otherwise both start from the same state and the second
    // write would silently drop the first.
    return this.execTx(async (db) => {
      const [doc] = await db
        .select({
          workspaceId: documents.workspaceId,
          ydocState: documents.ydocState,
          contentMd: documents.contentMd,
        })
        .from(documents)
        .where(and(eq(documents.id, id), isNull(documents.deletedAt)))
        .for("update");
      if (!doc) {
        // FOR UPDATE only sees rows the actor may update: tell "read-only"
        // apart from "not there / not yours".
        const [readable] = await db
          .select({ id: documents.id })
          .from(documents)
          .where(and(eq(documents.id, id), isNull(documents.deletedAt)));
        if (readable) throw new DocumentWriteDeniedError();
        throw new NotFoundError("document not found");
      }
      const edited = applyEditToState(doc.ydocState, edit, this.authorInfo(), doc.contentMd);
      const [row] = await db
        .update(documents)
        .set({
          ydocState: edited.ydocState,
          contentMd: edited.contentMd,
          contentJson: edited.contentJson,
          ...(await projectionColumns(db, doc.workspaceId, edited.properties)),
          updatedAt: new Date(),
        })
        .where(and(eq(documents.id, id), isNull(documents.deletedAt)))
        .returning();
      if (!row) throw new DocumentWriteDeniedError();
      await writeTaskRows(db, id, edited.tasks);
      return row;
    });
  }

  /** Give a document with no Yjs state (legacy, markdown-only) its first one.
   * First writer wins and the winner is returned, so every load agrees on one
   * canonical state: re-seeding per load would hand out unrelated CRDT
   * histories, and a client merging an old one back duplicates the content.
   * Only ydoc_state is set; the read model already matches the markdown. */
  async adoptInitialState(id: string, state: Uint8Array): Promise<Uint8Array> {
    return this.execTx(async (db) => {
      const [won] = await db
        .update(documents)
        .set({ ydocState: state })
        .where(and(eq(documents.id, id), isNull(documents.ydocState)))
        .returning({ ydocState: documents.ydocState });
      if (won?.ydocState) return won.ydocState;
      const [row] = await db
        .select({ ydocState: documents.ydocState })
        .from(documents)
        .where(eq(documents.id, id));
      return row?.ydocState ?? state;
    });
  }

  /** Persist the live Yjs state + derived read model (Hocuspocus onStoreDocument).
   * Returns the markdown/title this write replaced, read under the same row
   * lock, so a caller diffing old vs new (task notifications) sees exactly the
   * state its own write superseded even when stores race. */
  async saveCollabSnapshot(
    id: string,
    snapshot: {
      ydocState: Uint8Array;
      contentMd: string;
      contentJson: unknown;
      properties: PropertiesJSON;
      tasks: readonly ProjectedTask[];
    },
  ): Promise<{ workspaceId: string; previousMd: string; title: string } | null> {
    return this.execTx(async (db) => {
      // FOR UPDATE: only rows this actor may write. Don't let a debounced
      // store resurrect a soft-deleted document.
      const [prev] = await db
        .select({
          workspaceId: documents.workspaceId,
          contentMd: documents.contentMd,
          title: documents.title,
        })
        .from(documents)
        .where(and(eq(documents.id, id), isNull(documents.deletedAt)))
        .for("update");
      if (!prev) {
        // Deleted docs are intentionally skipped. Anything else means RLS
        // filtered the write (read-only actor) — fail loud, don't drop data.
        const [existing] = await db
          .select({ id: documents.id })
          .from(documents)
          .where(and(eq(documents.id, id), isNull(documents.deletedAt)));
        if (existing) throw new DocumentWriteDeniedError();
        return null;
      }
      const rows = await db
        .update(documents)
        .set({
          ydocState: snapshot.ydocState,
          contentMd: snapshot.contentMd,
          contentJson: snapshot.contentJson,
          ...(await projectionColumns(db, prev.workspaceId, snapshot.properties)),
          updatedAt: new Date(),
        })
        .where(and(eq(documents.id, id), isNull(documents.deletedAt)))
        .returning({ id: documents.id });
      if (rows.length === 0) throw new DocumentWriteDeniedError();
      await writeTaskRows(db, id, snapshot.tasks);
      return { workspaceId: prev.workspaceId, previousMd: prev.contentMd, title: prev.title };
    });
  }
}
