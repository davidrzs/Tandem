import { InvalidInputError, NotFoundError } from "../errors.js";
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { documents, type Database, type Document } from "@tandem/db";
import type { DocumentMeta } from "./documents.js";
import {
  DocumentServiceBase,
  documentMetaColumns,
  lockTree,
  nextPosition,
  rowsOf,
  searchPaths,
} from "./document-tree-internals.js";

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

/** Hard-delete one trash batch. Children outside the batch (restored, or
 * trashed separately) are detached to the root first: the parent FK cascades,
 * and must only take the batch itself with it. */
async function purgeBatch(db: Database, id: string): Promise<boolean> {
  await db.execute(sql`
    WITH RECURSIVE batch AS (
      SELECT id, deleted_at FROM documents WHERE id = ${id} AND deleted_at IS NOT NULL
      UNION
      SELECT d.id, d.deleted_at FROM documents d
      JOIN batch b ON d.parent_document_id = b.id AND d.deleted_at = b.deleted_at
    )
    UPDATE documents SET parent_document_id = NULL
    WHERE parent_document_id IN (SELECT id FROM batch)
      AND id NOT IN (SELECT id FROM batch)
  `);
  const deleted = rowsOf<{ id: string }>(
    await db.execute(sql`
      DELETE FROM documents WHERE id = ${id} AND deleted_at IS NOT NULL RETURNING id
    `),
  );
  return deleted.length > 0;
}

/** Tree structure: placement, archive/restore/delete of subtrees, listings. */
export class DocumentTreeService extends DocumentServiceBase {
  async move(
    id: string,
    target: { parentDocumentId: string | null; position?: number },
  ): Promise<Document | null> {
    return this.execTx(async (db) => {
      const [doc] = await db
        .select({ collectionId: documents.collectionId })
        .from(documents)
        .where(and(eq(documents.id, id), isNull(documents.deletedAt)));
      if (!doc) return null;
      await lockTree(db, doc.collectionId);

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
            UNION
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
        (await nextPosition(db, doc.collectionId, target.parentDocumentId));
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
    only: SQL = sql`deleted_at IS NULL`,
  ): Promise<void> {
    // Raw-SQL params skip drizzle's column mapping, and postgres-js won't
    // serialize a Date it gets that way (PGlite does — tests alone won't catch
    // it). Bind ISO text; Postgres casts it against the column type.
    const stamp = value ? value.toISOString() : null;
    await db.execute(sql`
      WITH RECURSIVE subtree AS (
        SELECT id FROM documents WHERE id = ${id}
        UNION
        SELECT d.id FROM documents d JOIN subtree s ON d.parent_document_id = s.id
      )
      UPDATE documents
      SET ${sql.raw(column)} = ${stamp}, updated_at = now()
      WHERE id IN (SELECT id FROM subtree) AND ${only}
    `);
  }

  /** Archive a document and its descendants (hidden from the tree/search,
   * recoverable via restore). Returns null if the actor may not write it. */
  async archive(id: string): Promise<Document | null> {
    return this.exec(async (db) => {
      // Leave already-archived descendants alone: their own archive (and its
      // timestamp) must survive this one being restored.
      await this.stampSubtree(
        db,
        id,
        "archived_at",
        new Date(),
        sql`deleted_at IS NULL AND archived_at IS NULL`,
      );
      const [row] = await db
        .select()
        .from(documents)
        .where(and(eq(documents.id, id), isNull(documents.deletedAt)));
      return row?.archivedAt ? row : null;
    });
  }

  /** Un-archive a document and the descendants archived together with it
   * (same timestamp); ones archived separately before stay archived. */
  async restore(id: string): Promise<Document | null> {
    return this.exec(async (db) => {
      await this.stampSubtree(
        db,
        id,
        "archived_at",
        null,
        sql`deleted_at IS NULL AND archived_at = (SELECT archived_at FROM documents WHERE id = ${id})`,
      );
      const [row] = await db
        .select()
        .from(documents)
        .where(and(eq(documents.id, id), isNull(documents.deletedAt)));
      return row && !row.archivedAt ? row : null;
    });
  }

  /** Move a document and its descendants to the trash. Descendants already in
   * the trash keep their own deletion (and timestamp), so restoring this batch
   * doesn't bring them back. Returns false if nothing was deleted (missing or
   * not writable). */
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

  /** Take a trash batch (the document plus descendants deleted with it) out of
   * the trash. If its parent is no longer active the document moves to the
   * collection root, so it can't end up hidden under a dead parent. */
  async restoreFromTrash(id: string): Promise<Document | null> {
    return this.execTx(async (db) => {
      const [doc] = await db
        .select({ collectionId: documents.collectionId, deletedAt: documents.deletedAt })
        .from(documents)
        .where(eq(documents.id, id));
      if (!doc?.deletedAt) return null;
      await lockTree(db, doc.collectionId);
      await this.stampSubtree(
        db,
        id,
        "deleted_at",
        null,
        sql`deleted_at = (SELECT deleted_at FROM documents WHERE id = ${id})`,
      );
      await db.execute(sql`
        UPDATE documents d SET parent_document_id = NULL
        WHERE d.id = ${id} AND d.deleted_at IS NULL AND d.parent_document_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM documents p
            WHERE p.id = d.parent_document_id AND p.deleted_at IS NULL AND p.archived_at IS NULL
          )
      `);
      const [row] = await db
        .select()
        .from(documents)
        .where(and(eq(documents.id, id), isNull(documents.deletedAt)));
      return row ?? null;
    });
  }

  /** Metadata of a trashed document (the doc page shows a restore banner). */
  async getTrashed(id: string): Promise<(DocumentMeta & { deletedAt: Date }) | null> {
    return this.exec(async (db) => {
      const [row] = await db
        .select({ ...documentMetaColumns, deletedAt: documents.deletedAt })
        .from(documents)
        .where(and(eq(documents.id, id), sql`${documents.deletedAt} IS NOT NULL`));
      return (row as (DocumentMeta & { deletedAt: Date }) | undefined) ?? null;
    });
  }

  /** Trash roots in a collection: deleted documents that weren't deleted as
   * part of their parent's batch. Their batch restores or purges with them. */
  async listTrash(collectionId: string): Promise<Array<DocumentMeta & { deletedAt: Date }>> {
    return this.exec(async (db) => {
      const parent = alias(documents, "parent");
      const rows = await db
        .select({ ...documentMetaColumns, deletedAt: documents.deletedAt })
        .from(documents)
        .leftJoin(parent, eq(parent.id, documents.parentDocumentId))
        .where(
          and(
            eq(documents.collectionId, collectionId),
            sql`${documents.deletedAt} IS NOT NULL`,
            sql`${parent.deletedAt} IS DISTINCT FROM ${documents.deletedAt}`,
          ),
        )
        .orderBy(desc(documents.deletedAt));
      return rows as Array<DocumentMeta & { deletedAt: Date }>;
    });
  }

  /** Delete a trash batch for good. Returns false if `id` isn't a trash root
   * this actor may delete. */
  async purge(id: string): Promise<boolean> {
    return this.execTx(async (db) => {
      const [doc] = await db
        .select({ collectionId: documents.collectionId, deletedAt: documents.deletedAt })
        .from(documents)
        .where(eq(documents.id, id));
      if (!doc?.deletedAt) return false;
      await lockTree(db, doc.collectionId);
      return purgeBatch(db, id);
    });
  }

  /** Purge every trash batch deleted more than `days` ago (maintenance). */
  async purgeExpired(days: number): Promise<number> {
    return this.execTx(async (db) => {
      const roots = rowsOf<{ id: string }>(
        await db.execute(sql`
          SELECT d.id FROM documents d
          LEFT JOIN documents p ON p.id = d.parent_document_id
          WHERE d.deleted_at < now() - (${days} * interval '1 day')
            AND p.deleted_at IS DISTINCT FROM d.deleted_at
        `),
      );
      let purged = 0;
      for (const { id } of roots) if (await purgeBatch(db, id)) purged += 1;
      return purged;
    });
  }

  async listByCollection(collectionId: string): Promise<DocumentMeta[]> {
    return this.exec((db) =>
      db
        .select(documentMetaColumns)
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
      .select(documentMetaColumns)
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
        .select(documentMetaColumns)
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
        .select(documentMetaColumns)
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
    return DocumentTreeService.nest(flat, null);
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
        .select(documentMetaColumns)
        .from(documents)
        .where(
          and(eq(documents.id, rootId), isNull(documents.deletedAt), isNull(documents.archivedAt)),
        );
      if (!root) throw new NotFoundError("document not found");
      const ancestry = (await searchPaths(db, [rootId])).get(rootId) ?? [
        root.title || "Untitled",
      ];
      const flat = await this.levels(db, root.collectionId, maxDepth, rootId);
      return { root, ancestry, nodes: DocumentTreeService.nest(flat, rootId) };
    });
  }
}
