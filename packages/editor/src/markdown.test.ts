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

/** The text and marks of every inline node, in order: what a round trip must keep. */
function inlineShape(json: unknown): string[] {
  const out: string[] = [];
  const walk = (n: { type: string; text?: string; marks?: Array<{ type: string }>; content?: unknown[] }) => {
    if (n.text !== undefined) out.push(`${(n.marks ?? []).map((m) => m.type).join("+")}:${n.text}`);
    for (const c of n.content ?? []) walk(c as never);
  };
  walk(json as never);
  return out;
}

test("dollar signs never change code, escapes or marks on a round trip", () => {
  const cases = [
    '```sh\necho "$HOME\\n$PATH"\n```',
    "Run `echo $HOME\\n$PATH` first.",
    "Pay $5 \\*per\\* seat, $6 total",
    "Budget $5 and $10, `a$b` and $x_1$.",
    "Escaped \\$5 and \\$6 stay prose.",
    "Math $a*b*c$ keeps its stars and $\\$5$ its dollar.",
    "Display $$a_1 * b_2 * c$$ stays raw.",
    "| a | b |\n| --- | --- |\n| $\\alpha$ | $5 and $6 |",
  ];
  for (const md of cases) {
    const once = normalizeMarkdown(md);
    assert.equal(normalizeMarkdown(once), once, `not stable: ${md}`);
    assert.deepEqual(inlineShape(markdownToJSON(once)), inlineShape(markdownToJSON(md)), `changed: ${md}`);
  }
  assert.equal(normalizeMarkdown('```sh\necho "$HOME\\n$PATH"\n```'), '```sh\necho "$HOME\\n$PATH"\n```');
  assert.equal(normalizeMarkdown("Run `echo $HOME\\n$PATH` first."), "Run `echo $HOME\\n$PATH` first.");
  // A code span binds tighter than math: the `$` inside it closes nothing.
  assert.deepEqual(inlineShape(markdownToJSON("Budget $5 and $10, `a$b` and $x_1$.")), [
    ":Budget $5 and $10, ",
    "code:a$b",
    ": and $x_1$.",
  ]);
  // The document model has no literal dollar pair: `$…$` text is math. So an
  // escaped pair that reads as math comes back as math.
  assert.equal(normalizeMarkdown("\\$\\alpha\\$"), "$\\alpha$");
});

test("math is read as text: markdown inside it is not parsed", () => {
  assert.deepEqual(inlineShape(markdownToJSON("A $a*b*c$ and $$x_1 * y_1$$.")), [":A $a*b*c$ and $$x_1 * y_1$$."]);
  // Not math (space after the opening $, digit after the closing one), so
  // the stars are emphasis as usual.
  assert.deepEqual(inlineShape(markdownToJSON("$ 5 *per* seat$1")), [":$ 5 ", "italic:per", ": seat$1"]);
});

test("a dollar that would pair with one in a later node is escaped", () => {
  const p = (...content: unknown[]) => ({ type: "doc", content: [{ type: "paragraph", content }] });
  const t = (text: string, ...marks: string[]) => ({ type: "text", text, marks: marks.map((type) => ({ type })) });
  for (const doc of [
    p(t("x $a "), t("b$", "bold")),
    p(t("price $5 "), t("code$", "code"), t(" more")),
    p(t("see $x "), { type: "text", text: "link", marks: [{ type: "link", attrs: { href: "https://a.test/$y" } }] }),
  ]) {
    const md = jsonToMarkdown(doc);
    assert.deepEqual(inlineShape(markdownToJSON(md)), inlineShape(doc), `changed via ${JSON.stringify(md)}`);
  }
});

test("math in task text and table cells keeps its backslashes", () => {
  assert.equal(normalizeMarkdown("- [ ] check $\\alpha_1$"), "- [ ] check $\\alpha_1$");
  assert.match(normalizeMarkdown("| a |\n| --- |\n| $\\beta$ |"), /\| \$\\beta\$ \|/);
  // A pipe in math is escaped for the row and comes back as a pipe.
  const cell = (text: string) => ({ type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
  const row = (text: string) => ({ type: "tableRow", content: [cell(text)] });
  const table = { type: "doc", content: [{ type: "table", content: [row("h"), row("$|x|$")] }] };
  assert.deepEqual(inlineShape(markdownToJSON(jsonToMarkdown(table))), inlineShape(table));
});

test("multi-line table cells keep their line structure via <br>", () => {
  // Two paragraphs in one cell survive as a <br>, not a flattened space.
  const md = "| A |\n| --- |\n| one<br>two |";
  assert.equal(normalizeMarkdown(md), md, "canonical <br> cell round-trips exactly");

  const json = markdownToJSON(md) as {
    content: Array<{
      content: Array<{ content: Array<{ content: Array<{ content: Array<{ type: string }> }> }> }>;
    }>;
  };
  const cellPara = json.content[0]!.content[1]!.content[0]!.content[0]!;
  assert.ok(
    cellPara.content.some((n) => n.type === "hardBreak"),
    "<br> parses to a hard break inside the cell",
  );
});

test("a <br> outside a table also becomes a hard break (not silently dropped)", () => {
  const json = markdownToJSON("line one<br>line two") as {
    content: Array<{ content: Array<{ type: string }> }>;
  };
  assert.ok(json.content[0]!.content.some((n) => n.type === "hardBreak"));
});

test("an empty table cell round-trips as an empty column", () => {
  const md = "| A | B |\n| --- | --- |\n| x |  |";
  const out = normalizeMarkdown(md);
  assert.match(out, /\| x \| {2}\|/, "empty cell preserved");
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

test("toggle summaries keep inline marks through the round trip", () => {
  const md = "<details>\n<summary>The **plan**, with `code`</summary>\n\nbody\n\n</details>";
  assert.equal(normalizeMarkdown(md), md, "marked-up summary round-trips exactly");

  const json = markdownToJSON(md) as {
    content: Array<{
      content: Array<{ content: Array<{ text?: string; marks?: Array<{ type: string }> }> }>;
    }>;
  };
  const summary = json.content[0]!.content[0]!.content;
  assert.ok(
    summary.some((n) => n.text === "plan" && n.marks?.some((m) => m.type === "bold")),
    "bold mark survives in the summary",
  );
  assert.ok(
    summary.some((n) => n.text === "code" && n.marks?.some((m) => m.type === "code")),
    "code mark survives in the summary",
  );
});

test("literal angle brackets in a toggle summary survive as entities", () => {
  const src = "<details>\n<summary>Use &lt;renamed&gt; here</summary>\n\nbody\n\n</details>";
  const out = normalizeMarkdown(src);
  assert.equal(out, src, "entity-escaped summary is stable");
  const json = markdownToJSON(src) as {
    content: Array<{ content: Array<{ content: Array<{ text?: string }> }> }>;
  };
  assert.equal(json.content[0]!.content[0]!.content[0]!.text, "Use <renamed> here");
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

test("a live section round-trips as an HTML comment; unknown queries are dropped", () => {
  const md = "## Actions\n\n<!-- live-section: open_from_last_time -->\n\nNotes";
  assert.deepEqual(JSON.parse(JSON.stringify(markdownToJSON(md))).content[1], {
    type: "liveSection",
    attrs: { query: "open_from_last_time" },
  });
  assert.equal(normalizeMarkdown(md), md);
  assert.equal(normalizeMarkdown("<!-- live-section: everything -->\n\nNotes"), "Notes");
  const series = "## Meetings\n\n<!-- live-section: meeting_series -->\n";
  assert.deepEqual(JSON.parse(JSON.stringify(markdownToJSON(series))).content[1], {
    type: "liveSection",
    attrs: { query: "meeting_series" },
  });
  assert.equal(normalizeMarkdown(series), series.trimEnd());
});

test("image and link destinations with spaces or parentheses survive", () => {
  const p = (...content: unknown[]) => ({ type: "doc", content: [{ type: "paragraph", content }] });
  for (const src of ["my image (1).png", "a(.png", "back\\slash.png", "plain.png"]) {
    const doc = p({ type: "image", attrs: { src, alt: "a" } });
    const back = markdownToJSON(jsonToMarkdown(doc)) as { content: [{ content: [{ type: string; attrs: { src: string } }] }] };
    const node = back.content[0].content[0];
    assert.equal(node.type, "image", `image lost for ${src}`);
    assert.equal(decodeURI(node.attrs.src), src);
  }
  const link = p({ type: "text", text: "doc", marks: [{ type: "link", attrs: { href: "notes/my file (draft).md" } }] });
  const md = jsonToMarkdown(link);
  assert.equal(md, "[doc](<notes/my file (draft).md>)");
  assert.deepEqual(inlineShape(markdownToJSON(md)), ["link:doc"]);
  assert.equal(normalizeMarkdown("[x](https://a.test/b_(c))"), "[x](https://a.test/b_\\(c\\))");
});

test("footnotes stay footnotes: markers and definitions are written back raw", () => {
  for (const md of ["Text[^1] here.\n\n[^1]: Note", "See[^long-name].\n\n[^long-name]: https://example.com"]) {
    assert.equal(normalizeMarkdown(md), md);
    assert.ok(!JSON.stringify(markdownToJSON(md)).includes('"link"'), `became a link: ${md}`);
  }
  // A marker that starts a real link is a link, not a footnote.
  assert.deepEqual(inlineShape(markdownToJSON("[^1](https://a.test)")), ["link:^1"]);
  assert.equal(normalizeMarkdown("[^1](https://a.test)"), "[^1](https://a.test)");
});

test("lists in table cells round-trip as lists", () => {
  const md = (cell: string) => `| h |\n| --- |\n| ${cell} |`;
  const cellBlocks = (markdown: string) => {
    const json = markdownToJSON(markdown) as { content: [{ content: Array<{ content: [{ content: Array<{ type: string; attrs?: Record<string, unknown> }> }] }> }] };
    return json.content[0].content[1]!.content[0].content.map((b) => b.type + (b.attrs?.start ? `@${b.attrs.start}` : ""));
  };
  for (const [cell, blocks] of [
    ["* one<br>* two", ["bulletList"]],
    ["3. one<br>4. two", ["orderedList@3"]],
    ["- [ ] open<br>- [x] done", ["taskList"]],
    ["intro<br>* one<br>* two<br>after", ["paragraph", "bulletList", "paragraph"]],
    ["\\* not a list<br>text", ["paragraph"]],
  ] as const) {
    assert.deepEqual(cellBlocks(md(cell)), blocks, cell);
    const once = normalizeMarkdown(md(cell));
    assert.equal(normalizeMarkdown(once), once, `not stable: ${cell}`);
    assert.deepEqual(cellBlocks(once), blocks, `changed on a round trip: ${cell}`);
  }
  assert.equal(normalizeMarkdown(md("* one<br>* two")), md("* one<br>* two"));
  assert.equal(normalizeMarkdown(md("- [ ] open<br>- [x] done")), md("- [ ] open<br>- [x] done"));
  // A task's checkbox state and an item's marks survive.
  const tasks = JSON.stringify(markdownToJSON(md("- [x] **done**")));
  assert.match(tasks, /"checked":true/);
  assert.match(tasks, /"bold"/);
});
