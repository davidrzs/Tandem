import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createDatabase, migrateDatabase, SYSTEM, workspaceMembers } from "@tandem/db";
import { COLLAB_FIELD, blameSpans, getAuthors, jsonToMarkdown, schema, stateToJSON } from "@tandem/editor";
import { CollectionService, DocumentService, SnapshotService, WorkspaceService } from "@tandem/core";
import { yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import * as Y from "yjs";
import { createAuth } from "./auth.js";
import { createCollabWriter } from "./collab-writer.js";
import { createHocuspocus } from "./collab.js";

const db = createDatabase("memory://");
const hocuspocus = createHocuspocus(db, createAuth(db), { debounce: 50 });
const u1 = { kind: "user", userId: "u1" } as const;
const u1Human = { userId: "u1", name: "User One", ai: false };
const documents = new DocumentService(db, u1, u1Human);
const snapshots = new SnapshotService(db, u1);
const writer = createCollabWriter(hocuspocus, documents, u1Human, snapshots);

let docId = "";

async function liveState(id: string): Promise<Uint8Array> {
  const conn = await hocuspocus.openDirectConnection(id, { userId: "u1" });
  let state: Uint8Array = new Uint8Array();
  await conn.transact((doc) => {
    state = Y.encodeStateAsUpdate(doc);
  });
  await conn.disconnect();
  return state;
}

async function liveMarkdown(id: string): Promise<string> {
  const conn = await hocuspocus.openDirectConnection(id, { userId: "u1" });
  let md = "";
  await conn.transact((doc) => {
    md = jsonToMarkdown(yXmlFragmentToProsemirrorJSON(doc.getXmlFragment(COLLAB_FIELD)));
  });
  await conn.disconnect();
  return md;
}

/** Text each author identity is credited with, over the live doc. */
async function liveBlame(id: string): Promise<Map<string, string>> {
  const conn = await hocuspocus.openDirectConnection(id, { userId: "u1" });
  const byAuthor = new Map<string, string>();
  await conn.transact((doc) => {
    const authors = getAuthors(doc as unknown as Y.Doc);
    const fragment = doc.getXmlFragment(COLLAB_FIELD);
    const pm = schema.nodeFromJSON(yXmlFragmentToProsemirrorJSON(fragment) as never);
    for (const span of blameSpans(fragment)) {
      const info = authors.get(span.clientId);
      const key = info ? `${info.userId}:${info.ai ? "ai" : "human"}` : "unknown";
      byAuthor.set(key, (byAuthor.get(key) ?? "") + pm.textBetween(span.from, span.to, "\n"));
    }
  });
  await conn.disconnect();
  return byAuthor;
}

before(async () => {
  await migrateDatabase(db);
  await new WorkspaceService(db, SYSTEM).provisionForUser("u1", { name: "U1", slug: "u1" });
  const col = await new CollectionService(db, u1).create({ name: "C", slug: "c" });
  docId = (await documents.create({ collectionId: col.id, title: "Doc", markdown: "# Spec\n\nFirst body." })).id;
});

after(async () => {
  await db.$dispose();
});

test("restore reverts content by JSON, attributing only the changed spans", async () => {
  // Snapshot the original state, then edit the body.
  const original = await liveState(docId);
  const workspaceId = (await documents.getMeta(docId))!.workspaceId;
  await snapshots.captureBoundary({
    documentId: docId,
    workspaceId,
    ydocState: original,
    sessions: [{ ...u1Human, at: Date.now() }],
  });
  const [v1] = await snapshots.list(docId);

  await writer.transform(docId, (md) => md.replace("First body.", "Second body, revised."));
  assert.match(await liveMarkdown(docId), /Second body, revised\./);

  // Restore to v1: content reverts, and it reports a real change.
  const result = await writer.restoreTo(docId, await snapshots.get(v1!.id).then((s) => s!));
  assert.equal(result.changed, true);
  const md = await liveMarkdown(docId);
  assert.match(md, /First body\./);
  assert.doesNotMatch(md, /Second body/);

  // Blame: the human owns the content; nothing is AI or unknown.
  const blame = await liveBlame(docId);
  assert.ok((blame.get("u1:human") ?? "").includes("First body."), "restored text is the human's");
  assert.equal(blame.get("unknown"), undefined, "no unattributed spans");
  assert.equal(blame.get("u1:ai"), undefined, "restore is not an AI edit");

  // The pre-restore state ("Second body") is captured somewhere — as a
  // pre-restore row, or an equal boundary snapshot it deduped against — so the
  // restore is undoable either way.
  let recoverable = false;
  for (const s of await snapshots.list(docId)) {
    const row = await snapshots.get(s.id);
    if (/Second body/.test(jsonToMarkdown(stateToJSON(row!.ydocState)))) {
      recoverable = true;
      break;
    }
  }
  assert.ok(recoverable, "the pre-restore state is captured (restore is undoable)");
});

test("a no-op restore makes no edit and adds no session", async () => {
  const before = (await snapshots.list(docId)).length;
  const [current] = await snapshots.list(docId);
  // Snapshot the current live state, then restore straight to it.
  const state = await liveState(docId);
  await snapshots.captureBoundary({
    documentId: docId,
    workspaceId: (await documents.getMeta(docId))!.workspaceId,
    ydocState: state,
    sessions: [{ ...u1Human, at: Date.now() }],
  });
  const [snap] = await snapshots.list(docId);
  const sessionsBefore = (await liveBlame(docId)).size;

  const result = await writer.restoreTo(docId, await snapshots.get(snap!.id).then((s) => s!));
  assert.equal(result.changed, false, "identical state → no change");
  assert.equal((await liveBlame(docId)).size, sessionsBefore, "no phantom blame session");
  void before;
  void current;
});

test("a read-only member cannot restore", async () => {
  await db.insert(workspaceMembers).values({
    workspaceId: (await new WorkspaceService(db, u1).listMine())[0]!.id,
    userId: "u2",
    role: "member",
  });
  await new CollectionService(db, u1).setDefaultRole(
    (await documents.getMeta(docId))!.collectionId,
    "read",
  );
  const u2Writer = createCollabWriter(
    hocuspocus,
    new DocumentService(db, { kind: "user", userId: "u2" }, { userId: "u2", name: "Two", ai: false }),
    { userId: "u2", name: "Two", ai: false },
    new SnapshotService(db, { kind: "user", userId: "u2" }),
  );
  const [snap] = await snapshots.list(docId);
  const snapRow = (await snapshots.get(snap!.id))!;
  await assert.rejects(() => u2Writer.restoreTo(docId, snapRow), /write access|denied/i);
});
