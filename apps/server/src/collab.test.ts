import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createDatabase, documents, migrateDatabase, SYSTEM, tasks, workspaceMembers } from "@tandem/db";
import { eq } from "drizzle-orm";
import { COLLAB_FIELD, jsonToMarkdown, markdownToJSON, PROPERTIES_KEY, schema } from "@tandem/editor";
import { CollectionService, DocumentService, WorkspaceService } from "@tandem/core";
import { type Connection, OutgoingMessage } from "@hocuspocus/server";
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import * as Y from "yjs";
import { createAuth } from "./auth.js";
import { createHocuspocus } from "./collab.js";

const db = createDatabase("memory://");
const hocuspocus = createHocuspocus(db, createAuth(db), { debounce: 50 });
const u1 = { kind: "user", userId: "u1" } as const;

let docId = "";
let collectionId = "";

before(async () => {
  await migrateDatabase(db);
  await new WorkspaceService(db, SYSTEM).provisionForUser("u1", { name: "U1", slug: "u1" });
  const col = await new CollectionService(db, u1).create({ name: "C", slug: "c" });
  collectionId = col.id;
  await db.insert(workspaceMembers).values({ workspaceId: col.workspaceId, userId: "u2", role: "member" });
  docId = (await new DocumentService(db, u1).create({ collectionId: col.id, title: "Doc" })).id;
});

after(async () => {
  await new Promise((r) => setTimeout(r, 300)); // let fire-and-forget captures finish
  await db.$dispose();
});

test("a direct write into the live Y.Doc persists ydoc_state + derived markdown", async () => {
  // The uniform write path: an agent writing into the shared Y.Doc as the user.
  const connection = await hocuspocus.openDirectConnection(docId, { userId: "u1" });
  await connection.transact((doc) => {
    prosemirrorJSONToYXmlFragment(
      schema,
      markdownToJSON("# Hello\n\nFrom the direct connection."),
      doc.getXmlFragment(COLLAB_FIELD),
    );
  });
  await connection.disconnect();

  await new Promise((r) => setTimeout(r, 400)); // past the 50ms store debounce

  const doc = await new DocumentService(db, u1).get(docId);
  assert.ok(doc, "doc exists");
  assert.ok(doc!.ydocState && doc!.ydocState.length > 0, "ydoc_state persisted");
  assert.match(doc!.contentMd, /# Hello/, "derived markdown has heading");
  assert.match(doc!.contentMd, /From the direct connection\./, "derived markdown has body");
});

test("a properties map written by a client is validated when the live doc is stored", async () => {
  const connection = await hocuspocus.openDirectConnection(docId, { userId: "u1" });
  await connection.transact((doc) => {
    doc.getMap(PROPERTIES_KEY).set("f_ghost", { v: "boo" });
  });
  await connection.disconnect();

  const [row] = await db
    .select({ properties: documents.properties, issues: documents.propertyIssues })
    .from(documents)
    .where(eq(documents.id, docId));
  assert.deepEqual(row, {
    properties: {},
    issues: [{ fieldId: "f_ghost", code: "unknown_field", message: "no field has this id", value: "boo" }],
  });
});

test("a legacy markdown-only doc gets one canonical Yjs state across read-only loads", async () => {
  // A writer's visit persists the seed via the store on disconnect; a reader's
  // store is denied, so only an explicit adoption makes the seed stick.
  const cols = new CollectionService(db, u1);
  const ro = await cols.create({ name: "RO", slug: "ro-legacy" });
  await cols.setDefaultRole(ro.id, "read");
  const id = (await new DocumentService(db, u1).create({ collectionId: ro.id, title: "Legacy" })).id;
  await db
    .update(documents)
    .set({ ydocState: null, contentMd: "Legacy body." })
    .where(eq(documents.id, id));

  const snapshotOfLoad = async (): Promise<Uint8Array> => {
    const conn = await hocuspocus.openDirectConnection(id, { userId: "u2" });
    let state: Uint8Array = new Uint8Array();
    await conn.transact((doc) => {
      state = Y.encodeStateAsUpdate(doc);
    });
    await conn.disconnect();
    return state;
  };
  const first = await snapshotOfLoad();
  const second = await snapshotOfLoad();

  // A client that cached the first load (offline persistence) merges it into
  // the second: same history, so nothing is duplicated.
  const merged = new Y.Doc();
  Y.applyUpdate(merged, second);
  Y.applyUpdate(merged, first);
  const md = jsonToMarkdown(yXmlFragmentToProsemirrorJSON(merged.getXmlFragment(COLLAB_FIELD)));
  assert.equal(md.match(/Legacy body\./g)?.length, 1, md);
});

/** A sync-update message as a websocket client would send it. */
function updateMessage(name: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText("t").insert(0, "x");
  return new OutgoingMessage(name).createSyncMessage().writeUpdate(Y.encodeStateAsUpdate(doc)).toUint8Array();
}

test("a writer who loses access mid-session is flipped read-only before their next update", async () => {
  const cols = new CollectionService(db, u1);
  const conn = { readOnly: false } as Connection;
  const hook = (hocuspocus.configuration as any).beforeHandleMessage;
  const payload = { connection: conn, context: { userId: "u2" }, documentName: docId, update: updateMessage(docId) };
  try {
    await hook(payload);
    assert.equal(conn.readOnly, false, "member can write by default");
    await cols.setDefaultRole(collectionId, "read");
    await new Promise((r) => setTimeout(r, 1100)); // past the permission cache
    await hook(payload);
    assert.equal(conn.readOnly, true, "downgraded connection refuses updates");
  } finally {
    await cols.setDefaultRole(collectionId, "read_write");
  }
});

test("store persists via a still-authorized connection when the last editor lost access", async () => {
  const cols = new CollectionService(db, u1);
  const connection = await hocuspocus.openDirectConnection(docId, { userId: "u1" });
  const document = connection.document!;
  try {
    connection.document!.transact(() => {
      prosemirrorJSONToYXmlFragment(
        schema,
        markdownToJSON("Written while u2 could still write."),
        document.getXmlFragment(COLLAB_FIELD),
      );
    });
    await cols.setDefaultRole(collectionId, "read");
    // u1 (owner) still has a live connection on the doc.
    const realGet = document.getConnections.bind(document);
    document.getConnections = () => [{ context: { userId: "u1" } } as Connection];
    try {
      await (hocuspocus.configuration as any).onStoreDocument({
        document,
        documentName: docId,
        lastContext: { userId: "u2", userName: "U2" },
      });
    } finally {
      document.getConnections = realGet;
    }
    const doc = await new DocumentService(db, u1).get(docId);
    assert.match(doc!.contentMd, /Written while u2 could still write\./);
  } finally {
    await cols.setDefaultRole(collectionId, "read_write");
    await connection.disconnect();
  }
});

test("a live store gives new task items block ids in the shared doc and projects their rows", async () => {
  const id = (await new DocumentService(db, u1).create({ collectionId, title: "Live tasks" })).id;
  const rows = () =>
    db
      .select({ blockId: tasks.blockId, text: tasks.text, done: tasks.done, createdBy: tasks.createdBy })
      .from(tasks)
      .where(eq(tasks.documentId, id))
      .orderBy(tasks.position);
  const taskElements = (doc: Y.Doc) =>
    doc
      .getXmlFragment(COLLAB_FIELD)
      .createTreeWalker((el) => el instanceof Y.XmlElement && el.nodeName === "taskItem");

  const typing = await hocuspocus.openDirectConnection(id, { userId: "u1" });
  // As a browser does: its own client writes, the server receives the update.
  const browser = new Y.Doc();
  prosemirrorJSONToYXmlFragment(schema, markdownToJSON("- [ ] @u1 water plants\n- [ ] call Bo"), browser.getXmlFragment(COLLAB_FIELD));
  await typing.transact((doc) => {
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(browser));
  });
  await typing.disconnect();
  await new Promise((r) => setTimeout(r, 400));

  const stored = await rows();
  assert.deepEqual(
    stored.map(({ blockId: _, ...row }) => row),
    [
      { text: "@u1 water plants", done: false, createdBy: "u1" },
      { text: "call Bo", done: false, createdBy: "u1" },
    ],
  );
  const live = new Y.Doc();
  Y.applyUpdate(live, (await new DocumentService(db, u1).get(id))!.ydocState!);
  assert.deepEqual(
    [...taskElements(live)].map((el) => (el as Y.XmlElement).getAttribute("blockId")),
    stored.map((row) => row.blockId),
    "the ids are in the persisted doc, so every client sees the same ones",
  );

  const ticking = await hocuspocus.openDirectConnection(id, { userId: "u1" });
  await ticking.transact((doc) => {
    ([...taskElements(doc)][1] as Y.XmlElement).setAttribute("checked", true as never);
  });
  await ticking.disconnect();
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(
    (await rows()).map((row) => [row.blockId, row.done]),
    [
      [stored[0]!.blockId, false],
      [stored[1]!.blockId, true],
    ],
  );
});
