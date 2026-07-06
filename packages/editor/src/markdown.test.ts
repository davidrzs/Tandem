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

test("task lists round-trip as GitHub-style checkboxes", () => {
  const md = "- [ ] @alice ship the thing\n- [x] done item with **bold**";
  const roundTripped = normalizeMarkdown(md);
  assert.equal(roundTripped, md);
  // And the JSON carries real taskItem nodes with checked state.
  const json = markdownToJSON(md) as {
    content: Array<{ type: string; content: Array<{ type: string; attrs: { checked: boolean } }> }>;
  };
  assert.equal(json.content[0]!.type, "taskList");
  assert.equal(json.content[0]!.content[0]!.type, "taskItem");
  assert.equal(json.content[0]!.content[0]!.attrs.checked, false);
  assert.equal(json.content[0]!.content[1]!.attrs.checked, true);
});

test("a mixed list is NOT a task list; markers stay literal", () => {
  const md = "* [x] looks like a task\n* but this is not";
  const json = markdownToJSON(md) as { content: Array<{ type: string }> };
  assert.equal(json.content[0]!.type, "bulletList");
  // The marker survives as (escaped) literal text, not as a checkbox.
  assert.match(normalizeMarkdown(md), /looks like a task/);
  assert.equal(normalizeMarkdown(normalizeMarkdown(md)), normalizeMarkdown(md));
});

test("nested task lists round-trip", () => {
  const md = "- [ ] parent task\n\n  - [ ] child task";
  const normalized = normalizeMarkdown(md);
  assert.match(normalized, /- \[ \] parent task/);
  assert.match(normalized, /- \[ \] child task/);
  assert.equal(normalizeMarkdown(normalized), normalized, "stable after one pass");
});

test("GFM tables round-trip and build a real table node tree", () => {
  const md = "| Name | Role |\n| --- | --- |\n| Ada | Lead |\n| Bo | Eng |";
  assert.equal(normalizeMarkdown(md), md, "canonical GFM round-trips exactly");

  const json = markdownToJSON(md) as {
    content: Array<{ type: string; content: Array<{ type: string; content: Array<{ type: string }> }> }>;
  };
  const table = json.content[0]!;
  assert.equal(table.type, "table");
  assert.equal(table.content[0]!.type, "tableRow");
  assert.equal(table.content[0]!.content[0]!.type, "tableHeader");
  assert.equal(table.content[1]!.content[0]!.type, "tableCell");
});

test("table cells keep inline marks and escape pipes; alignment is dropped", () => {
  const md = "| A | B |\n| :--- | ---: |\n| **bold** | a \\| b |";
  const out = normalizeMarkdown(md);
  assert.match(out, /\*\*bold\*\*/, "marks survive in cells");
  assert.match(out, /a \\\| b/, "literal pipe stays escaped");
  assert.match(out, /^\| --- \| --- \|$/m, "alignment normalizes to plain ---");
  assert.equal(normalizeMarkdown(out), out, "idempotent");
});

test("math ($…$ / $$…$$) round-trips with its backslashes intact", () => {
  // Math is plain text; the serializer would escape its backslashes, so the
  // pipeline undoes that within delimiters — TeX must survive for export/MCP.
  assert.equal(normalizeMarkdown("Energy $E = mc^2$ and $\\alpha$."), "Energy $E = mc^2$ and $\\alpha$.");
  assert.equal(normalizeMarkdown("$$\\frac{a}{b} = \\sum_i x_i$$"), "$$\\frac{a}{b} = \\sum_i x_i$$");
  // Plain dollar signs in prose aren't mistaken for math and mangled.
  assert.equal(normalizeMarkdown("It cost $5, then $10."), "It cost $5, then $10.");
});

test("an empty table cell round-trips as an empty column", () => {
  const md = "| A | B |\n| --- | --- |\n| x |  |";
  const out = normalizeMarkdown(md);
  assert.match(out, /\| x \|  \|/, "empty cell preserved");
  assert.equal(normalizeMarkdown(out), out, "idempotent");
});

test("callout blockquotes (`> [!type]`) round-trip and carry type/fold attrs", () => {
  const note = "> [!note]\n> Body line.";
  assert.equal(normalizeMarkdown(note), note, "canonical GitHub-alert callout round-trips exactly");

  const json = markdownToJSON(note) as { content: Array<{ type: string; attrs: Record<string, unknown> }> };
  assert.equal(json.content[0]!.type, "callout");
  assert.equal(json.content[0]!.attrs.type, "note");
  assert.equal(json.content[0]!.attrs.collapsible, false);

  // Obsidian fold marker `-` => collapsible + collapsed.
  const folded = markdownToJSON("> [!warning]- careful\n> danger") as {
    content: Array<{ attrs: Record<string, unknown> }>;
  };
  assert.equal(folded.content[0]!.attrs.type, "warning");
  assert.equal(folded.content[0]!.attrs.collapsible, true);
  assert.equal(folded.content[0]!.attrs.collapsed, true);
  assert.match(normalizeMarkdown("> [!warning]- careful\n> danger"), /^> \[!warning\]-$/m);
});

test("an unknown callout type is preserved; a plain blockquote stays a blockquote", () => {
  // Foreign vault types survive verbatim (rendered neutral).
  const bug = markdownToJSON("> [!bug]\n> oops") as { content: Array<{ type: string; attrs: { type: string } }> };
  assert.equal(bug.content[0]!.type, "callout");
  assert.equal(bug.content[0]!.attrs.type, "bug");
  // No marker => ordinary blockquote, not a callout.
  const quote = markdownToJSON("> just a quote") as { content: Array<{ type: string }> };
  assert.equal(quote.content[0]!.type, "blockquote");
});

test("a callout wraps block content and stays idempotent", () => {
  const md = "> [!tip]\n> * one\n> * two";
  assert.equal(normalizeMarkdown(md), md);
  const json = markdownToJSON(md) as {
    content: Array<{ type: string; content: Array<{ type: string }> }>;
  };
  assert.equal(json.content[0]!.type, "callout");
  assert.equal(json.content[0]!.content[0]!.type, "bulletList");
});

test("toggles round-trip as <details> with an editable summary + block content", () => {
  const md = "<details>\n<summary>More detail</summary>\n\nHidden body.\n\n</details>";
  assert.equal(normalizeMarkdown(md), md, "canonical <details> round-trips exactly");

  const json = markdownToJSON(md) as {
    content: Array<{ type: string; content: Array<{ type: string; content: Array<{ type: string; text?: string }> }> }>;
  };
  const toggle = json.content[0]!;
  assert.equal(toggle.type, "toggle");
  assert.equal(toggle.content[0]!.type, "toggleSummary");
  assert.equal(toggle.content[0]!.content[0]!.text, "More detail");
  assert.equal(toggle.content[1]!.type, "toggleContent");
  assert.equal(toggle.content[1]!.content[0]!.type, "paragraph");
});

test("nested toggles round-trip and stay idempotent", () => {
  const md =
    "<details>\n<summary>Outer</summary>\n\n<details>\n<summary>Inner</summary>\n\ndeep\n\n</details>\n\n</details>";
  const once = normalizeMarkdown(md);
  assert.equal(once, md, "nested details round-trip exactly");
  assert.equal(normalizeMarkdown(once), once, "idempotent");
});

test("page references round-trip as [title](/d/<id>) links", () => {
  const id = "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9";
  const md = `See [Reading the river](/d/${id}) for context.`;
  const json = markdownToJSON(md) as {
    content: Array<{ content: Array<{ type: string; attrs?: Record<string, unknown> }> }>;
  };
  const inline = json.content[0]!.content;
  const ref = inline.find((n) => n.type === "pageRef");
  assert.ok(ref, "link to a document URL becomes a pageRef node");
  assert.equal(ref!.attrs!.docId, id);
  assert.equal(ref!.attrs!.title, "Reading the river");
  assert.equal(normalizeMarkdown(md), md, "stable round-trip");
});

test("ordinary links do not become page references", () => {
  const md = "An [external link](https://example.com) and [not a doc](/dashboard).";
  const json = JSON.stringify(markdownToJSON(md));
  assert.ok(!json.includes("pageRef"));
  assert.equal(normalizeMarkdown(md), md);
});
