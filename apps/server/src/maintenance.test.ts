import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { eq, sql } from "drizzle-orm";
import {
  createDatabase,
  documentSnapshots,
  images,
  migrateDatabase,
  runAsActor,
  SYSTEM,
} from "@tandem/db";
import { CollectionService, DocumentService, WorkspaceService } from "@tandem/core";
import { runMaintenance } from "./maintenance.js";

test("maintenance prunes old snapshots (keeping the newest) and orphaned images", async () => {
  const db = createDatabase("memory://");
  await migrateDatabase(db);
  const dir = await mkdtemp(join(tmpdir(), "tandem-uploads-"));
  process.env.UPLOADS_DIR = dir;

  try {
    const ws = await new WorkspaceService(db, SYSTEM).provisionForUser("u1", {
      name: "U1",
      slug: "u1",
    });
    const col = await new CollectionService(db, { kind: "user", userId: "u1" }).create({
      name: "C",
      slug: "c",
    });
    const docs = new DocumentService(db, { kind: "user", userId: "u1" });

    // One image referenced by a live document, one orphan. Both old.
    const [referenced, orphan] = await runAsActor(db, SYSTEM, async (d) => {
      const mk = () =>
        d
          .insert(images)
          .values({ workspaceId: ws.id, uploadedBy: "u1", mime: "image/png", size: 3 })
          .returning({ id: images.id });
      const [a] = await mk();
      const [b] = await mk();
      await d.execute(sql`UPDATE images SET created_at = now() - interval '400 days'`);
      return [a!.id, b!.id];
    });
    await writeFile(join(dir, referenced!), "png");
    await writeFile(join(dir, orphan!), "png");

    const doc = await docs.create({
      collectionId: col.id,
      title: "Has image",
      markdown: `![shot](/api/images/${referenced})`,
    });

    // 12 snapshots, all ancient: retention keeps the newest 10.
    await runAsActor(db, SYSTEM, async (d) => {
      for (let i = 0; i < 12; i++) {
        await d.insert(documentSnapshots).values({
          documentId: doc.id,
          workspaceId: ws.id,
          ydocState: new Uint8Array([i]),
          kind: "auto",
          authors: [],
        });
      }
      await d.execute(
        sql`UPDATE document_snapshots SET created_at = now() - interval '400 days'`,
      );
    });

    const result = await runMaintenance(db, { retentionDays: 180, keepPerDoc: 10 });
    assert.equal(result.snapshotsPruned, 2, "keeps the newest 10 per document");
    assert.equal(result.imagesPruned, 1, "only the unreferenced image goes");

    const left = await runAsActor(db, SYSTEM, (d) =>
      d.select({ id: images.id }).from(images),
    );
    assert.deepEqual(
      left.map((r) => r.id),
      [referenced],
      "referenced image row survives",
    );
    const files = await readdir(dir);
    assert.deepEqual(files, [referenced], "orphan bytes unlinked");

    const snaps = await runAsActor(db, SYSTEM, (d) =>
      d.select({ id: documentSnapshots.id }).from(documentSnapshots).where(eq(documentSnapshots.documentId, doc.id)),
    );
    assert.equal(snaps.length, 10);

    // A second pass is a no-op.
    const again = await runMaintenance(db, { retentionDays: 180, keepPerDoc: 10 });
    assert.deepEqual(again, { snapshotsPruned: 0, imagesPruned: 0 });
  } finally {
    delete process.env.UPLOADS_DIR;
    await db.$dispose();
  }
});
