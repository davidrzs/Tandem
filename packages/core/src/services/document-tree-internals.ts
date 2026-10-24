import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { documents, runAsActor, SYSTEM, typeFields, type Actor, type Database } from "@tandem/db";
import { SYSTEM_AUTHOR, type AuthorIdentity, type AuthorInfo } from "@tandem/editor";

/** Internal helpers shared by DocumentService, DocumentTreeService, and
 * DocumentQueryService. Not exported from the package index. */

/** Rows of a raw `db.execute`, whichever shape the driver hands back. */
export function rowsOf<T>(result: unknown): T[] {
  const rows = Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows;
  return (rows ?? []) as T[];
}

/** Columns safe to ship to clients — excludes content_md/json, ydoc_state, search_vector. */
export const documentMetaColumns = {
  id: documents.id,
  workspaceId: documents.workspaceId,
  collectionId: documents.collectionId,
  parentDocumentId: documents.parentDocumentId,
  position: documents.position,
  title: documents.title,
  tags: documents.tags,
  defaultTemplateId: documents.defaultTemplateId,
  typeId: documents.typeId,
  createdAt: documents.createdAt,
  updatedAt: documents.updatedAt,
  archivedAt: documents.archivedAt,
  deletedAt: documents.deletedAt,
};

/** Ids of every template document and its descendants. Computed at query
 * time from the `templates` rows, so moving a page into or out of a template
 * needs no bookkeeping. Under RLS, only readable templates count; the rest
 * belong to documents the actor cannot see anyway. */
export const templateDocumentIds = sql`(
  WITH RECURSIVE tpl(id) AS (
    SELECT document_id FROM templates
    UNION
    SELECT d.id FROM documents d JOIN tpl ON d.parent_document_id = tpl.id
  )
  SELECT id FROM tpl
)`;

/** Filter for queries over `documents`: drop templates and their subtrees
 * (search, backlinks, recents, tasks, tags). */
export const notTemplate = sql`${documents.id} NOT IN ${templateDocumentIds}`;

/** Actor-scoped base for the document services: same (db, actor, author?)
 * constructor shape, and the RLS exec helpers they all share. */
export abstract class DocumentServiceBase {
  constructor(
    protected readonly db: Database,
    protected readonly actor: Actor = SYSTEM,
    protected readonly author?: AuthorIdentity,
  ) {}

  /** Attribution identity for content this service writes into Yjs state. */
  protected authorInfo(): AuthorInfo {
    const identity =
      this.author ?? (this.actor.kind === "user" ? { userId: this.actor.userId, name: "", ai: false } : SYSTEM_AUTHOR);
    return { ...identity, at: Date.now() };
  }

  protected exec<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    return runAsActor(this.db, this.actor, fn);
  }

  /** exec() that always runs in a transaction (SYSTEM actors otherwise run
   * without one), for work that holds a transaction-scoped lock. Inside an
   * actor transaction this is a savepoint; the lock lasts to the outer commit. */
  protected execTx<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    return this.exec((db) => db.transaction((tx) => fn(tx as unknown as Database)));
  }
}

/** Serialize tree mutations within a collection: without it, two crossing
 * moves both pass the cycle check, and concurrent creates pick the same
 * max()+1 position. */
export async function lockTree(db: Database, collectionId: string): Promise<void> {
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${collectionId}))`);
}

export async function nextPosition(
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

/** The page of a series before another: same collection, parent and type. */
export interface PreviousSibling {
  id: string;
  title: string;
  properties: Record<string, unknown>;
  createdAt: Date;
  /** Its value of the type's first date field, if it has one. */
  date: string | null;
}

/**
 * A series orders its pages by the type's first date field (newest first,
 * undated last), then by creation time, newest first. The previous sibling
 * of the page `self` is the one after it in that order; without `self` it is
 * the first, the page a new sibling at `placement` follows. Null when there
 * is none.
 */
export async function previousSibling(
  db: Database,
  placement: { typeId: string; collectionId: string; parentDocumentId: string | null },
  self?: string,
): Promise<PreviousSibling | null> {
  const [dated] = await db
    .select({ id: typeFields.id })
    .from(typeFields)
    .where(
      and(
        eq(typeFields.typeId, placement.typeId),
        isNull(typeFields.retiredAt),
        inArray(typeFields.kind, ["date", "datetime"]),
      ),
    )
    .orderBy(asc(typeFields.position), asc(typeFields.key))
    .limit(1);
  const date = dated ? sql<string | null>`${documents.properties} ->> ${dated.id}::text` : sql<null>`NULL`;
  const ranked = db.$with("ranked").as(
    db
      .select({
        id: documents.id,
        title: documents.title,
        properties: documents.properties,
        createdAt: documents.createdAt,
        date: date.as("date"),
        rank: sql<number>`row_number() OVER (ORDER BY ${date} DESC NULLS LAST, ${documents.createdAt} DESC, ${documents.id} DESC)`.as("rank"),
      })
      .from(documents)
      .where(
        and(
          eq(documents.collectionId, placement.collectionId),
          placement.parentDocumentId
            ? eq(documents.parentDocumentId, placement.parentDocumentId)
            : isNull(documents.parentDocumentId),
          eq(documents.typeId, placement.typeId),
          isNull(documents.deletedAt),
          isNull(documents.archivedAt),
          notTemplate,
        ),
      ),
  );
  const wanted = self ? sql`(SELECT r.rank FROM ranked r WHERE r.id = ${self}) + 1` : sql`1`;
  const [row] = await db
    .with(ranked)
    .select({
      id: ranked.id,
      title: ranked.title,
      properties: ranked.properties,
      createdAt: ranked.createdAt,
      date: ranked.date,
    })
    .from(ranked)
    .where(sql`${ranked.rank} = ${wanted}`);
  return row ?? null;
}

/** Resolve readable ancestor paths for a bounded set of search hits in one
 * recursive query. The supplied db is the actor-scoped transaction, so RLS
 * applies to ancestors exactly as it does to the hits themselves. */
export async function searchPaths(
  db: Database,
  ids: readonly string[],
): Promise<Map<string, string[]>> {
  if (ids.length === 0) return new Map();
  const result = await db.execute(sql`
    WITH RECURSIVE document_paths AS (
      SELECT
        d.id AS leaf_id,
        d.parent_document_id,
        ARRAY[coalesce(nullif(d.title, ''), 'Untitled')]::text[] AS parts,
        1 AS depth
      FROM documents d
      WHERE d.id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
        AND d.deleted_at IS NULL
        AND d.archived_at IS NULL

      UNION ALL

      SELECT
        path.leaf_id,
        parent.parent_document_id,
        ARRAY[coalesce(nullif(parent.title, ''), 'Untitled')]::text[] || path.parts,
        path.depth + 1
      FROM document_paths path
      JOIN documents parent ON parent.id = path.parent_document_id
      WHERE parent.deleted_at IS NULL
        AND parent.archived_at IS NULL
        -- Backstop: a parent cycle would otherwise recurse forever.
        AND path.depth < 100
    )
    SELECT leaf_id, parts
    FROM document_paths
    WHERE parent_document_id IS NULL
  `);
  return new Map(
    rowsOf<{ leaf_id: string; parts: string[] }>(result).map((row) => [row.leaf_id, row.parts]),
  );
}
