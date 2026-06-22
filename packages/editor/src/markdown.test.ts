import assert from "node:assert/strict";
import { test } from "node:test";
import { schema } from "./schema.js";
import { jsonToMarkdown, markdownToJSON, normalizeMarkdown } from "./markdown.js";

test("schema has the expected StarterKit nodes/marks", () => {
  for (const n of [
    "doc",
    "paragraph",
    "heading",
    "bulletList",
    "orderedList",
    "listItem",
    "codeBlock",
    "blockquote",
    "horizontalRule",
    "hardBreak",
    "text",
  ]) {
    assert.ok(schema.nodes[n], `missing node ${n}`);
  }
  for (const mk of ["bold", "italic", "code", "strike"]) {
    assert.ok(schema.marks[mk], `missing mark ${mk}`);
  }
});

test("markdown round-trips through the shared schema", () => {
  const md = [
    "# Title",
    "",
    "A paragraph with **bold**, *italic*, ~~strike~~ and `code`.",
    "",
    "* one",
    "* two",
    "",
    "1. first",
    "2. second",
    "",
    "> a quote",
    "",
    "```ts",
    "const x = 1;",
    "```",
  ].join("\n");

  const normalized = normalizeMarkdown(md);
  assert.match(normalized, /# Title/);
  assert.match(normalized, /\*\*bold\*\*/);
  assert.match(normalized, /\*italic\*/);
  assert.match(normalized, /~~strike~~/);
  assert.match(normalized, /`code`/);
  assert.match(normalized, /\* one/);
  assert.match(normalized, /1\. first/);
  assert.match(normalized, /> a quote/);
  assert.match(normalized, /```ts\nconst x = 1;\n```/);
});

test("JSON <-> markdown is stable (idempotent)", () => {
  const md = "## Heading\n\nBody with `code`.";
  const json = markdownToJSON(md);
  const once = jsonToMarkdown(json);
  const twice = jsonToMarkdown(markdownToJSON(once));
  assert.equal(once, twice);
});
