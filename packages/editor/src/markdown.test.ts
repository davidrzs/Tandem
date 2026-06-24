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

test("links and images round-trip; unknown HTML is dropped, not thrown", () => {
  const md = "See [the docs](https://example.com) and ![logo](https://x/i.png).";
  const out = normalizeMarkdown(md);
  assert.match(out, /\[the docs\]\(https:\/\/example\.com\)/, "link preserved");
  assert.match(out, /!\[logo\]\(https:\/\/x\/i\.png\)/, "plain image preserved");
  // stray HTML must not throw
  assert.doesNotThrow(() => normalizeMarkdown("a <span>x</span> b"));
});

test("a resized image round-trips as GitHub-style <img width>", () => {
  const md = '<img src="https://x/i.png" alt="logo" width="320">';
  const out = normalizeMarkdown(md);
  assert.match(out, /<img /, "serialized as HTML img");
  assert.match(out, /src="https:\/\/x\/i\.png"/);
  assert.match(out, /width="320"/, "width preserved");
});

test("code block containing a backtick fence widens the fence (no corruption)", () => {
  const md = "```js\nconst x = '```';\n```";
  // Round-trip twice: a hardcoded ``` fence would corrupt on the second parse.
  const once = normalizeMarkdown(md);
  const twice = normalizeMarkdown(once);
  assert.equal(once, twice, "stable across re-parse");
  assert.match(once, /````/, "fence widened past the inner ```");
  assert.match(once, /const x = '```';/, "code body intact");
});

test("JSON <-> markdown is stable (idempotent)", () => {
  const md = "## Heading\n\nBody with `code`.";
  const json = markdownToJSON(md);
  const once = jsonToMarkdown(json);
  const twice = jsonToMarkdown(markdownToJSON(once));
  assert.equal(once, twice);
});
