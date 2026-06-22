import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createDatabase } from "@realtime/db";
import { CollectionService } from "./services/collections.js";
import { DocumentService } from "./services/documents.js";
import { normalizeMarkdown } from "./markdown.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL required to run core tests");

const db = createDatabase(url);
const collections = new CollectionService(db);
const documents = new DocumentService(db);

before(async () => {
  await db.$client`truncate table documents, collections cascade`;
});

after(async () => {
  await db.$client.end();
});

test("markdown round-trips through the document model", () => {
  const md = "# Title\n\nSome **bold** and a list:\n\n* one\n* two";
  const normalized = normalizeMarkdown(md);
  assert.match(normalized, /# Title/);
  assert.match(normalized, /\*\*bold\*\*/);
  assert.match(normalized, /\* one/);
});

test("collection + document CRUD, tree, and search", async () => {
  const col = await collections.create({ name: "Handbook", slug: "handbook" });
  assert.ok(col.id);

  const parent = await documents.create({
    collectionId: col.id,
    title: "Onboarding",
    markdown: "# Onboarding\n\nWelcome to the team.",
  });
  const child = await documents.create({
    collectionId: col.id,
    parentDocumentId: parent.id,
    title: "Laptop setup",
    markdown: "Install **pnpm** and clone the monorepo.",
  });

  // content_md is the canonical (re-serialized) markdown read model
  assert.match(parent.contentMd, /Welcome to the team/);
  assert.ok(parent.contentJson, "content_json derived");

  // tree nests child under parent
  const tree = await documents.tree(col.id);
  assert.equal(tree.length, 1);
  assert.equal(tree[0]!.id, parent.id);
  assert.equal(tree[0]!.children[0]!.id, child.id);

  // full-text search finds by body text, scoped to collection
  const hits = await documents.search("pnpm monorepo", { collectionId: col.id });
  assert.ok(hits.some((h) => h.id === child.id), "search finds child by body");

  // update changes the read model + search
  await documents.update(parent.id, { markdown: "# Onboarding\n\nNow mentions kubernetes." });
  const afterUpdate = await documents.search("kubernetes", { collectionId: col.id });
  assert.ok(afterUpdate.some((h) => h.id === parent.id), "search reflects update");

  // move child to top level
  const moved = await documents.move(child.id, { parentDocumentId: null });
  assert.equal(moved!.parentDocumentId, null);
  const tree2 = await documents.tree(col.id);
  assert.equal(tree2.length, 2, "child is now a root");

  // archive + soft delete remove from listings
  await documents.archive(parent.id);
  assert.ok((await documents.get(parent.id))!.archivedAt, "archived");
  await documents.softDelete(child.id);
  assert.equal(await documents.get(child.id), null, "soft-deleted is hidden");
});
