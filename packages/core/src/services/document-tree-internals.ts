import { and, eq, isNull, sql } from "drizzle-orm";
import { documents, runAsActor, SYSTEM, type Actor, type Database } from "@tandem/db";
import type { AuthorIdentity } from "@tandem/editor";

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
  createdAt: documents.createdAt,
  updatedAt: documents.updatedAt,
  archivedAt: documents.archivedAt,
  deletedAt: documents.deletedAt,
};

/** Actor-scoped base for the document services: same (db, actor, author?)
 * constructor shape, and the RLS exec helpers they all share. */
export abstract class DocumentServiceBase {
  constructor(
    protected readonly db: Database,
    protected readonly actor: Actor = SYSTEM,
    protected readonly author?: AuthorIdentity,
  ) {}

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
