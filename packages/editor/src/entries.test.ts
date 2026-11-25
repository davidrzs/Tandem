import assert from "node:assert/strict";
import { test } from "node:test";
import { entriesOf, entriesOfMarkdown, entryDate } from "./entries.js";
import { markdownToNode, nodeToMarkdown, normalizeMarkdown } from "./markdown.js";

const page = normalizeMarkdown(`# Advisor 1:1

<!-- live-section: open_tasks_here -->

## Next

- ask about reviewer 2

## 2026-11-24 **Advisor**

### Notes

- reviewer 2 wants ablations

## Undated

not an entry

## 2026-11-17

\`\`\`
## 2026-11-10 inside a fence
\`\`\`

# Appendix

## 2026-02-30 impossible

### 2026-11-03 level three

> ## 2026-11-02 in a quote
`);

/** Both readings of the same page: the markdown text of each entry and its
 * heading and date. */
function viaMarkdown(md: string) {
  return entriesOfMarkdown(md).map((e) => ({ date: e.date, heading: e.heading, body: md.slice(e.from, e.to).trim() }));
}
function viaNode(md: string) {
  const doc = markdownToNode(md);
  return entriesOf(doc).map((e) => ({
    date: e.date,
    heading: e.heading,
    body: nodeToMarkdown(doc.cut(e.from, e.to)).trim(),
  }));
}

test("an entry is a valid dated level-2 heading up to the next level-1 or level-2 heading", () => {
  assert.deepEqual(viaMarkdown(page), [
    {
      date: "2026-11-24",
      heading: "2026-11-24 **Advisor**",
      body: "## 2026-11-24 **Advisor**\n\n### Notes\n\n* reviewer 2 wants ablations",
    },
    {
      date: "2026-11-17",
      heading: "2026-11-17",
      body: "## 2026-11-17\n\n```\n## 2026-11-10 inside a fence\n```",
    },
  ]);
});

test("the document and its markdown agree on every entry", () => {
  assert.deepEqual(viaNode(page), viaMarkdown(page));
});

test("the pinned top is everything before the first entry", () => {
  const [first] = entriesOfMarkdown(page);
  assert.match(page.slice(0, first!.from), /<!-- live-section: open_tasks_here -->\n\n## Next\n\n\* ask about reviewer 2\n\n$/);
  const doc = markdownToNode(page);
  assert.equal(doc.childBefore(entriesOf(doc)[0]!.from).node?.textContent, "ask about reviewer 2");
});

test("a page without dated level-2 headings has no entries", () => {
  assert.deepEqual(entriesOfMarkdown("# Plan\n\n## Goals\n\n### 2026-11-24\n"), []);
  assert.deepEqual(entriesOfMarkdown(""), []);
  assert.deepEqual(entriesOf(markdownToNode("")), []);
});

test("the last entry runs to the end of the document", () => {
  const md = "## 2026-11-24\n\nnotes\n\n### Actions\n\n- one";
  assert.deepEqual(entriesOfMarkdown(md), [{ date: "2026-11-24", heading: "2026-11-24", from: 0, to: md.length }]);
  const doc = markdownToNode(md);
  assert.equal(entriesOf(doc)[0]!.to, doc.content.size);
});

test("a heading's date must be a real day and stand on its own", () => {
  assert.equal(entryDate("2026-11-24"), "2026-11-24");
  assert.equal(entryDate("2026-11-24 Advisor"), "2026-11-24");
  assert.equal(entryDate("2026-11-24: kickoff"), "2026-11-24");
  assert.equal(entryDate("2024-02-29 leap day"), "2024-02-29");
  assert.equal(entryDate("2026-02-29"), null);
  assert.equal(entryDate("2026-13-01"), null);
  assert.equal(entryDate("2026-11-00"), null);
  assert.equal(entryDate("2026-11-245"), null);
  assert.equal(entryDate("2026-11-24T10:00"), null);
  assert.equal(entryDate("Meeting 2026-11-24"), null);
  assert.equal(entryDate("26-11-24"), null);
});
