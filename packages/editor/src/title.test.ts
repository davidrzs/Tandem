import assert from "node:assert/strict";
import { test } from "node:test";
import { yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import * as Y from "yjs";
import { applyAttributedTitle, applyEditToState, getAuthors, seedTitle, type AuthorInfo } from "./authors.js";
import { cleanTitle, replaceTitle, TITLE_FIELD, titleOf } from "./title.js";

const ann: AuthorInfo = { userId: "ann", name: "Ann", ai: false, at: 1 };
const bob: AuthorInfo = { userId: "bob", name: "Bob", ai: false, at: 2 };

const copy = (doc: Y.Doc) => {
  const out = new Y.Doc();
  Y.applyUpdate(out, Y.encodeStateAsUpdate(doc));
  return out;
};
const merge = (a: Y.Doc, b: Y.Doc) => Y.applyUpdate(a, Y.encodeStateAsUpdate(b));

test("a doc holds no title until one is written", () => {
  assert.equal(titleOf(new Y.Doc()), null);
});

test("seeds made by separate loads merge into one title", () => {
  // Two loads of a page from before titles lived in the doc, each seeding it,
  // and a browser that kept the first one offline.
  const stored = Y.encodeStateAsUpdate(new Y.Doc());
  const first = new Y.Doc();
  Y.applyUpdate(first, stored);
  seedTitle(first, "Advisor 1:1");
  const second = new Y.Doc();
  Y.applyUpdate(second, stored);
  seedTitle(second, "Advisor 1:1");
  merge(second, first);
  assert.equal(titleOf(second), "Advisor 1:1");
  assert.equal(second.getXmlFragment(TITLE_FIELD).length, 1);
  assert.deepEqual(getAuthors(second).size, 1);
  assert.equal([...getAuthors(second).values()][0]!.name, "Unknown");
});

test("a seed never replaces a title the doc holds, even an empty one", () => {
  const doc = new Y.Doc();
  applyAttributedTitle(doc, "Kept", ann);
  seedTitle(doc, "Column");
  assert.equal(titleOf(doc), "Kept");
  applyAttributedTitle(doc, "", ann);
  seedTitle(doc, "Column");
  assert.equal(titleOf(doc), "");
  const empty = new Y.Doc();
  seedTitle(empty, "  ");
  assert.equal(titleOf(empty), null);
});

test("the title is one paragraph, the shape the title editor binds to", () => {
  const doc = new Y.Doc();
  seedTitle(doc, "Advisor 1:1");
  assert.deepEqual(yXmlFragmentToProsemirrorJSON(doc.getXmlFragment(TITLE_FIELD)), {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "Advisor 1:1" }] }],
  });
});

test("setting a title keeps a concurrent edit to the rest of it", () => {
  const base = new Y.Doc();
  applyAttributedTitle(base, "Advisor sync", ann);
  const a = copy(base);
  const b = copy(base);
  applyAttributedTitle(a, "Weekly advisor sync", bob);
  b.transact(() => replaceTitle(b, "Advisor sync notes"));
  merge(a, b);
  merge(b, a);
  assert.equal(titleOf(a), "Weekly advisor sync notes");
  assert.equal(titleOf(b), "Weekly advisor sync notes");
});

test("an unchanged title is no edit and stamps no session", () => {
  const doc = new Y.Doc();
  applyAttributedTitle(doc, "Plan", ann);
  assert.equal(applyAttributedTitle(doc, "Plan", bob), null);
  assert.deepEqual([...getAuthors(doc).values()].map((a) => a.userId), ["ann"]);
});

test("titles are one trimmed line of at most 500 characters", () => {
  assert.equal(cleanTitle("  Advisor\n1:1\r\n notes "), "Advisor 1:1 notes");
  assert.equal(cleanTitle("x".repeat(600)).length, 500);
  const doc = new Y.Doc();
  applyAttributedTitle(doc, "two\nlines", ann);
  assert.equal(titleOf(doc), "two lines");
});

test("the non-live path seeds the row's title and applies a new one", () => {
  const legacy = applyEditToState(null, { body: () => "Body" }, ann, { title: "Old" });
  assert.equal(legacy.title, "Old");
  const renamed = applyEditToState(legacy.ydocState, { title: "New" }, bob, { title: "Old" });
  assert.equal(renamed.title, "New");
  assert.equal(renamed.contentMd, "Body");
  const untitled = applyEditToState(null, { body: () => "Body" }, ann);
  assert.equal(untitled.title, null);
});
