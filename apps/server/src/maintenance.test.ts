import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { eq, sql } from "drizzle-orm";
import {
  createDatabase,
  documentSnapshots,
  documents,
  images,
  migrateDatabase,
  runAsActor,
  SYSTEM,
} from "@tandem/db";
import {
  CollectionService,
  DocumentService,
  DocumentTreeService,
  WorkspaceService,
} from "@tandem/core";
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
    assert.deepEqual(again, { trashPurged: 0, snapshotsPruned: 0, imagesPruned: 0 });
  } finally {
    delete process.env.UPLOADS_DIR;
    await db.$dispose();
  }
});

test("maintenance thins snapshots older than a week to one per day, keeping pre-restore ones", async () => {
  const db = createDatabase("memory://");
  await migrateDatabase(db);
  try {
    const ws = await new WorkspaceService(db, SYSTEM).provisionForUser("u1", { name: "U1", slug: "u1" });
    const col = await new CollectionService(db, { kind: "user", userId: "u1" }).create({ name: "C", slug: "c" });
    const doc = await new DocumentService(db, { kind: "user", userId: "u1" }).create({
      collectionId: col.id,
      title: "Busy",
    });
    // (age in days, hour, kind): three auto captures on day 30, one pre-restore
    // on day 30, two auto on day 2 (recent: all kept).
    const rows: Array<[number, number, string]> = [
      [30, 9, "auto"],
      [30, 10, "auto"],
      [30, 11, "auto"],
      [30, 10, "pre-restore"],
      [2, 9, "auto"],
      [2, 10, "auto"],
    ];
    await runAsActor(db, SYSTEM, async (d) => {
      for (const [i, [days, hour, kind]] of rows.entries()) {
        const [row] = await d
          .insert(documentSnapshots)
          .values({ documentId: doc.id, workspaceId: ws.id, ydocState: new Uint8Array([i]), kind, authors: [] })
          .returning({ id: documentSnapshots.id });
        await d.execute(
          sql`UPDATE document_snapshots SET created_at = date_trunc('day', now()) - (${days} * interval '1 day') + (${hour} * interval '1 hour') WHERE id = ${row!.id}`,
        );
      }
    });

    const result = await runMaintenance(db, { retentionDays: 180, keepPerDoc: 0, fullDays: 7 });
    assert.equal(result.snapshotsPruned, 2, "two older auto captures on day 30 go");
    const left = await runAsActor(db, SYSTEM, (d) =>
      d
        .select({ kind: documentSnapshots.kind, createdAt: documentSnapshots.createdAt })
        .from(documentSnapshots)
        .where(eq(documentSnapshots.documentId, doc.id)),
    );
    assert.equal(left.length, 4);
    assert.equal(left.filter((r) => r.kind === "pre-restore").length, 1, "pre-restore survives");
    const old = left.filter((r) => r.kind === "auto" && Date.now() - r.createdAt.getTime() > 7 * 86_400_000);
    assert.equal(old.length, 1, "one auto snapshot per old day");
  } finally {
    await db.$dispose();
  }
});

test("maintenance keeps a trashed document's images until the trash is purged", async () => {
  const db = createDatabase("memory://");
  await migrateDatabase(db);
  const dir = await mkdtemp(join(tmpdir(), "tandem-uploads-"));
  process.env.UPLOADS_DIR = dir;
  try {
    const u1 = { kind: "user", userId: "u1" } as const;
    const ws = await new WorkspaceService(db, SYSTEM).provisionForUser("u1", { name: "U1", slug: "u1" });
    const col = await new CollectionService(db, u1).create({ name: "C", slug: "c" });
    const [image] = await runAsActor(db, SYSTEM, async (d) => {
      const rows = await d
        .insert(images)
        .values({ workspaceId: ws.id, uploadedBy: "u1", mime: "image/png", size: 3 })
        .returning({ id: images.id });
      await d.execute(sql`UPDATE images SET created_at = now() - interval '400 days'`);
      return rows;
    });
    await writeFile(join(dir, image!.id), "png");
    const doc = await new DocumentService(db, u1).create({
      collectionId: col.id,
      title: "Trashed",
      markdown: `![shot](/api/images/${image!.id})`,
    });
    await new DocumentTreeService(db, u1).softDelete(doc.id);

    const inTrash = await runMaintenance(db, { trashDays: 30 });
    assert.equal(inTrash.trashPurged, 0);
    assert.equal(inTrash.imagesPruned, 0, "image of a trashed doc survives");

    await runAsActor(db, SYSTEM, (d) =>
      d
        .update(documents)
        .set({ deletedAt: new Date(Date.now() - 40 * 86_400_000) })
        .where(eq(documents.id, doc.id)),
    );
    const expired = await runMaintenance(db, { trashDays: 30 });
    assert.equal(expired.trashPurged, 1);
    assert.equal(expired.imagesPruned, 1, "collected once the document is purged");
    assert.deepEqual(await readdir(dir), []);
  } finally {
    delete process.env.UPLOADS_DIR;
    await db.$dispose();
  }
});
