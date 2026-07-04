import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { updateYFragment, yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import {
  applyAttributedEdit,
  AUTHORS_KEY,
  blameSpans,
  getAuthors,
  sanitizeClientAuthorsWrites,
  seedAttributedDoc,
  stampAuthor,
  stampMissingFromUpdate,
  type AuthorInfo,
  type BlameSpan,
} from "./authors.js";
import { jsonToMarkdown, markdownToJSON } from "./markdown.js";
import { COLLAB_FIELD, schema } from "./schema.js";

const alice: AuthorInfo = { userId: "alice", name: "Alice", ai: false, at: 1000 };
const aliceAi: AuthorInfo = { userId: "alice", name: "Alice", ai: true, at: 2000 };

/** The PM doc corresponding to the collab fragment (what the editor renders). */
function pmDoc(doc: Y.Doc) {
  return schema.nodeFromJSON(
    yXmlFragmentToProsemirrorJSON(doc.getXmlFragment(COLLAB_FIELD)) as never,
  );
}

/** Text of a span in the rendered doc — proves span positions are PM positions. */
function spanText(doc: Y.Doc, span: BlameSpan): string {
  return pmDoc(doc).textBetween(span.from, span.to, "\n");
}

/** Author info for each span, resolved through the authors map. */
function attributed(doc: Y.Doc): Array<{ text: string; author: AuthorInfo | undefined }> {
  const authors = getAuthors(doc);
  return blameSpans(doc.getXmlFragment(COLLAB_FIELD))
    .map((s) => ({ text: spanText(doc, s), author: authors.get(s.clientId) }))
    .filter((s) => s.text.length > 0);
}

test("seeding attributes all content to the creator", () => {
  const doc = seedAttributedDoc(markdownToJSON("# Title\n\nHello world."), alice);
  const authors = getAuthors(doc);
  assert.equal(authors.size, 1);
  const [entry] = authors.values();
  assert.deepEqual(entry, alice);

  const spans = attributed(doc);
  assert.ok(spans.length > 0);
  for (const span of spans) assert.deepEqual(span.author, alice);
  assert.equal(jsonToMarkdown(yXmlFragmentToProsemirrorJSON(doc.getXmlFragment(COLLAB_FIELD))), "# Title\n\nHello world.");
});

test("a targeted edit only re-attributes the changed span", () => {
  const doc = seedAttributedDoc(markdownToJSON("The quick fox jumps."), alice);

  // Replace one word through the markdown round-trip, as the MCP tools do.
  const currentMd = jsonToMarkdown(yXmlFragmentToProsemirrorJSON(doc.getXmlFragment(COLLAB_FIELD)));
  const nextMd = currentMd.replace("quick", "sluggish");
  applyAttributedEdit(doc, markdownToJSON(nextMd), aliceAi);

  const spans = attributed(doc);
  const aiText = spans.filter((s) => s.author?.ai).map((s) => s.text).join("");
  const humanText = spans.filter((s) => s.author && !s.author.ai).map((s) => s.text).join("");
  assert.ok(aiText.includes("sluggish"), `AI text should be the new word, got "${aiText}"`);
  assert.ok(!aiText.includes("fox"), "unchanged text must keep human attribution");
  assert.ok(humanText.includes("The "), "prefix stays human");
  assert.ok(humanText.includes(" fox jumps."), "suffix stays human");
  assert.equal(getAuthors(doc).size, 2, "edit session got its own author entry");
});

test("appending a section attributes only the new block to the editor", () => {
  const doc = seedAttributedDoc(markdownToJSON("# Notes\n\nHuman paragraph."), alice);
  const currentMd = jsonToMarkdown(yXmlFragmentToProsemirrorJSON(doc.getXmlFragment(COLLAB_FIELD)));
  applyAttributedEdit(doc, markdownToJSON(`${currentMd}\n\n## Appendix\n\nAgent paragraph.`), aliceAi);

  for (const span of attributed(doc)) {
    if (span.text.includes("Human paragraph")) assert.equal(span.author?.ai, false);
    if (span.text.includes("Agent paragraph")) assert.equal(span.author?.ai, true);
    if (span.text.includes("Appendix")) assert.equal(span.author?.ai, true);
  }
});

test("multiple edit sessions stay distinguishable", () => {
  const doc = seedAttributedDoc(markdownToJSON("One."), alice);
  const md1 = jsonToMarkdown(yXmlFragmentToProsemirrorJSON(doc.getXmlFragment(COLLAB_FIELD)));
  applyAttributedEdit(doc, markdownToJSON(`${md1}\n\nTwo.`), { ...aliceAi, at: 2000 });
  const md2 = jsonToMarkdown(yXmlFragmentToProsemirrorJSON(doc.getXmlFragment(COLLAB_FIELD)));
  applyAttributedEdit(doc, markdownToJSON(`${md2}\n\nThree.`), { ...aliceAi, at: 3000 });

  assert.equal(getAuthors(doc).size, 3, "one entry per session");
  const byText = new Map(attributed(doc).map((s) => [s.text, s.author]));
  assert.equal(byText.get("Two.")?.at, 2000);
  assert.equal(byText.get("Three.")?.at, 3000);
});

test("stampAuthor never overwrites an existing entry", () => {
  const doc = new Y.Doc();
  stampAuthor(doc, 42, alice);
  stampAuthor(doc, 42, { userId: "mallory", name: "Mallory", ai: false, at: 9 });
  assert.deepEqual(getAuthors(doc).get(42), alice);
});

test("stampMissingFromUpdate attributes unknown clients from the connection identity", () => {
  // A "browser" doc types content; the "server" doc receives the update and
  // stamps the unknown clientID with the authenticated user.
  const browser = new Y.Doc();
  typeUnattributed(browser, markdownToJSON("Typed in the browser."));
  const update = Y.encodeStateAsUpdate(browser);

  const server = new Y.Doc();
  Y.applyUpdate(server, update);
  const stamped = stampMissingFromUpdate(server, update, () => alice);
  assert.equal(stamped, 1);
  const spans = attributed(server);
  assert.ok(spans.length > 0);
  for (const span of spans) assert.deepEqual(span.author, alice);

  // Idempotent: the same update stamps nothing new.
  assert.equal(stampMissingFromUpdate(server, update, () => alice), 0);
});

test("blame positions line up with ProseMirror across mixed block types", () => {
  const md = "# Head\n\nPara one.\n\n- item a\n- item b\n\n```js\ncode()\n```";
  const doc = seedAttributedDoc(markdownToJSON(md), alice);
  const spans = blameSpans(doc.getXmlFragment(COLLAB_FIELD));
  const rendered = pmDoc(doc);
  // Every span must be within the doc and its text extractable.
  for (const span of spans) {
    assert.ok(span.from >= 0 && span.to <= rendered.nodeSize - 2 + 1, "span in range");
    assert.ok(span.to > span.from);
  }
  const allText = spans.map((s) => rendered.textBetween(s.from, s.to, "\n")).join("");
  assert.ok(allText.includes("Head"));
  assert.ok(allText.includes("item b"));
  assert.ok(allText.includes("code()"));
});

/** Type content as a plain client (no self-stamping — like a real browser). */
function typeUnattributed(doc: Y.Doc, json: unknown) {
  updateYFragment(doc, doc.getXmlFragment(COLLAB_FIELD), schema.nodeFromJSON(json as never), {
    mapping: new Map(),
    isOMark: new Map(),
  });
}

test("sanitize: a session forging its own identity is corrected to the authenticated one", () => {
  // Attacker writes content AND stamps their own clientID as someone else.
  const attacker = new Y.Doc();
  typeUnattributed(attacker, markdownToJSON("Forged content."));
  attacker.getMap(AUTHORS_KEY).set(String(attacker.clientID), {
    userId: "victim",
    name: "Victim",
    ai: false,
    at: 1,
  });
  const update = Y.encodeStateAsUpdate(attacker);

  const server = new Y.Doc();
  Y.applyUpdate(server, update);
  const corrected = sanitizeClientAuthorsWrites(server, update, () => ({
    userId: "attacker",
    name: "Attacker",
    ai: false,
    at: 99,
  }));
  assert.equal(corrected, 1);
  assert.equal(getAuthors(server).get(attacker.clientID)?.userId, "attacker");

  // And blame now shows the truth.
  const spans = blameSpans(server.getXmlFragment(COLLAB_FIELD));
  const authors = getAuthors(server);
  for (const span of spans) {
    assert.equal(authors.get(span.clientId)?.userId, "attacker");
  }
});

test("sanitize: server-stamped entries relayed by another client survive untouched", () => {
  // A doc whose history contains a server-side stamp for client B…
  const origin = new Y.Doc();
  typeUnattributed(origin, markdownToJSON("B's real words."));
  const bClient = origin.clientID;
  const serverStamp = new Y.Doc();
  Y.applyUpdate(serverStamp, Y.encodeStateAsUpdate(origin));
  stampAuthor(serverStamp, bClient, { userId: "bob", name: "Bob", ai: false, at: 5 });

  // …relayed wholesale by client A (id.client of the stamp != the map key).
  const relayed = Y.encodeStateAsUpdate(serverStamp);
  const server = new Y.Doc();
  Y.applyUpdate(server, relayed);
  const corrected = sanitizeClientAuthorsWrites(server, relayed, () => ({
    userId: "alice",
    name: "Alice",
    ai: false,
    at: 9,
  }));
  assert.equal(corrected, 0, "relay is not treated as forgery");
  assert.equal(getAuthors(server).get(bClient)?.userId, "bob");
});
