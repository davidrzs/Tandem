import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { runAsActor, SYSTEM, type Database } from "@tandem/db";
import { uploadsDir } from "./images.js";

const DAY_MS = 86_400_000;

export interface MaintenanceResult {
  snapshotsPruned: number;
  imagesPruned: number;
}

export interface MaintenanceOptions {
  /** Version snapshots older than this are pruned (the newest `keepPerDoc`
   * of every document survive regardless of age). */
  retentionDays?: number;
  keepPerDoc?: number;
}

const rowsOf = (r: unknown): unknown[] =>
  Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? []);

/**
 * One maintenance pass, system-scoped:
 *
 * 1. Snapshot retention — without it every version of every document is kept
 *    forever (a full Yjs state copy each).
 * 2. Orphaned-image GC — bytes whose id no live document references. Images
 *    must ALSO be older than the snapshot retention window, so restoring any
 *    still-restorable version can't resurrect a reference to deleted bytes.
 */
export async function runMaintenance(
  db: Database,
  opts: MaintenanceOptions = {},
): Promise<MaintenanceResult> {
  const retentionDays =
    opts.retentionDays ?? Number(process.env.SNAPSHOT_RETENTION_DAYS ?? 180);
  const keepPerDoc = opts.keepPerDoc ?? 10;

  return runAsActor(db, SYSTEM, async (d) => {
    const pruned = rowsOf(
      await d.execute(sql`
        DELETE FROM document_snapshots WHERE id IN (
          SELECT id FROM (
            SELECT id, created_at,
                   row_number() OVER (PARTITION BY document_id ORDER BY created_at DESC) AS rn
            FROM document_snapshots
          ) ranked
          WHERE ranked.rn > ${keepPerDoc}
            AND ranked.created_at < now() - (${retentionDays} * interval '1 day')
        )
        RETURNING id
      `),
    );

    const orphans = rowsOf(
      await d.execute(sql`
        DELETE FROM images i
        WHERE i.created_at < now() - (${retentionDays} * interval '1 day')
          AND NOT EXISTS (
            SELECT 1 FROM documents doc
            WHERE doc.deleted_at IS NULL
              AND doc.content_md LIKE '%' || i.id::text || '%'
          )
        RETURNING i.id
      `),
    ) as Array<{ id: string }>;

    const dir = uploadsDir();
    for (const { id } of orphans) {
      await unlink(join(dir, id)).catch(() => {
        // Bytes already gone — the row was the source of truth to remove.
      });
    }

    return { snapshotsPruned: pruned.length, imagesPruned: orphans.length };
  });
}

/** Daily maintenance: first pass a minute after boot, then every 24h. */
export function startMaintenance(
  db: Database,
  log: (msg: string) => void = console.error,
): () => void {
  const run = () => {
    void runMaintenance(db)
      .then((r) => {
        if (r.snapshotsPruned || r.imagesPruned) {
          log(
            `maintenance: pruned ${r.snapshotsPruned} snapshots, ${r.imagesPruned} orphaned images`,
          );
        }
      })
      .catch((err) => log(`maintenance failed: ${String(err)}`));
  };
  const first = setTimeout(run, 60_000);
  const daily = setInterval(run, DAY_MS);
  first.unref?.();
  daily.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(daily);
  };
}
