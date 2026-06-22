import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createDatabase, migrateDatabase } from "@realtime/db";
import { COLLAB_FIELD, markdownToJSON, schema } from "@realtime/editor";
import { prosemirrorJSONToYXmlFragment } from "y-prosemirror";
import { createHocuspocus } from "./collab.js";
import { createServices } from "./services.js";

const db = createDatabase("memory://");
const services = createServices(db);
const hocuspocus = createHocuspocus(services, { debounce: 50 });

let docId = "";

before(async () => {
  await migrateDatabase(db);
  const col = await services.collections.create({ name: "C", slug: "c" });
  const doc = await services.documents.create({
    collectionId: col.id,
    title: "Doc",
  });
  docId = doc.id;
});

after(async () => {
  await db.$dispose();
});

test("a direct write into the live Y.Doc persists ydoc_state + derived markdown", async () => {
  // This is the uniform write path: an agent/server writing into the shared
  // Y.Doc exactly as a human editor would, via Hocuspocus.
  const connection = await hocuspocus.openDirectConnection(docId, {
    userId: "test",
  });
  await connection.transact((doc) => {
    prosemirrorJSONToYXmlFragment(
      schema,
      markdownToJSON("# Hello\n\nFrom the direct connection."),
      doc.getXmlFragment(COLLAB_FIELD),
    );
  });
  await connection.disconnect();

  // Wait past the 50ms store debounce.
  await new Promise((r) => setTimeout(r, 400));

  const doc = await services.documents.get(docId);
  assert.ok(doc, "doc exists");
  assert.ok(doc!.ydocState && doc!.ydocState.length > 0, "ydoc_state persisted");
  assert.match(doc!.contentMd, /# Hello/, "derived markdown has heading");
  assert.match(doc!.contentMd, /From the direct connection\./, "derived markdown has body");
});
