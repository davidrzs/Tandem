import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createDatabase, migrateDatabase, SYSTEM } from "@tandem/db";
import { COLLAB_FIELD, markdownToJSON, schema } from "@tandem/editor";
import { CollectionService, DocumentService, WorkspaceService } from "@tandem/core";
import { prosemirrorJSONToYXmlFragment } from "y-prosemirror";
import { createAuth } from "./auth.js";
import { createHocuspocus } from "./collab.js";

const db = createDatabase("memory://");
const hocuspocus = createHocuspocus(db, createAuth(db), { debounce: 50 });
const u1 = { kind: "user", userId: "u1" } as const;

let docId = "";

before(async () => {
  await migrateDatabase(db);
  await new WorkspaceService(db, SYSTEM).provisionForUser("u1", { name: "U1", slug: "u1" });
  const col = await new CollectionService(db, u1).create({ name: "C", slug: "c" });
  docId = (await new DocumentService(db, u1).create({ collectionId: col.id, title: "Doc" })).id;
});

after(async () => {
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
