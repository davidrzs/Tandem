import assert from "node:assert/strict";
import { test } from "node:test";
import { markdownToHtml, markdownToText } from "./markdown-html.js";

test("markdownToHtml renders inline formatting, code and lists", () => {
  const html = markdownToHtml("**bold** and `code`\n\n- one\n- two\n\n```js\nlet x = 1;\n```");
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<ul>\s*<li>one<\/li>\s*<li>two<\/li>\s*<\/ul>/);
  assert.match(html, /<pre><code class="language-js">let x = 1;\n<\/code><\/pre>/);
});

test("markdownToHtml keeps single newlines as line breaks", () => {
  assert.match(markdownToHtml("line one\nline two"), /line one<br>\nline two/);
});

test("markdownToHtml escapes raw HTML instead of passing it through", () => {
  const html = markdownToHtml('<script>alert(1)</script> <img src=x onerror="alert(1)">');
  assert.doesNotMatch(html, /<script|<img/);
  assert.match(html, /&lt;script&gt;/);
});

test("markdownToHtml refuses javascript: links and opens the rest in a new tab", () => {
  assert.doesNotMatch(markdownToHtml("[x](javascript:alert(1))"), /<a /);
  assert.match(
    markdownToHtml("[docs](https://example.com/a)"),
    /<a href="https:\/\/example.com\/a" target="_blank" rel="noopener noreferrer">docs<\/a>/,
  );
});

test("markdownToHtml linkifies bare URLs", () => {
  assert.match(
    markdownToHtml("see https://example.com/x"),
    /<a href="https:\/\/example.com\/x"[^>]*>https:\/\/example.com\/x<\/a>/,
  );
});

test("markdownToHtml never emits images", () => {
  const html = markdownToHtml("![pixel](https://example.com/p.png)");
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /<a href="https:\/\/example.com\/p.png"/);
});

test("markdownToText flattens formatting to one line and keeps link text and code", () => {
  assert.equal(
    markdownToText(
      "**1. Search** — fixed\n\nSee [the spec](https://example.com) and `depth`.\n\n- one\n- two\n\n```\nlet x;\n```",
    ),
    "1. Search — fixed See the spec and depth. one two let x;",
  );
  assert.equal(markdownToText("cc @ben\nplease"), "cc @ben please");
  assert.equal(markdownToText("<b>literal</b>"), "<b>literal</b>");
});
