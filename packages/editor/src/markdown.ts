import MarkdownIt from "markdown-it";
import {
  defaultMarkdownSerializer,
  MarkdownParser,
  MarkdownSerializer,
} from "prosemirror-markdown";
import type { Node } from "@tiptap/pm/model";
import { schema } from "./schema.js";

const d = defaultMarkdownSerializer.nodes;
const m = defaultMarkdownSerializer.marks;

type Token = InstanceType<typeof import("markdown-it/lib/token.mjs").default>;

const attr = (html: string, name: string): string | null =>
  new RegExp(`${name}="([^"]*)"`, "i").exec(html)?.[1] ?? null;
const escAttr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const escHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * markdown-it rule: recognize GitHub task lists (`- [ ] …` / `- [x] …`).
 * A bullet list whose direct items ALL start with a checkbox marker becomes a
 * taskList of taskItems (mixed lists stay plain bullet lists and keep the
 * marker as literal text). The marker is stripped from the item's inline
 * content and stored as the item's `checked` attribute.
 */
function taskListPlugin(md: MarkdownIt) {
  md.core.ruler.after("block", "task_lists", (state) => {
    const tokens = state.tokens;

    // 1. Which list_item_open tokens start with a checkbox marker?
    const checkedAt = new Map<number, boolean>();
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i]!.type !== "list_item_open") continue;
      const inline = tokens[i + 2];
      if (tokens[i + 1]?.type === "paragraph_open" && inline?.type === "inline") {
        const marker = /^\[([ xX])\] /.exec(inline.content);
        if (marker) checkedAt.set(i, marker[1] !== " ");
      }
    }
    if (checkedAt.size === 0) return;

    // 2. Bullet lists where every direct item is a task.
    const stack: Array<{ open: number; items: number[]; allTasks: boolean }> = [];
    const taskLists: Array<{ open: number; close: number; items: number[] }> = [];
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i]!;
      const top = stack[stack.length - 1];
      if (tok.type === "bullet_list_open") {
        stack.push({ open: i, items: [], allTasks: true });
      } else if (
        tok.type === "list_item_open" &&
        top &&
        tok.level === tokens[top.open]!.level + 1
      ) {
        top.items.push(i);
        if (!checkedAt.has(i)) top.allTasks = false;
      } else if (
        tok.type === "bullet_list_close" &&
        top &&
        tok.level === tokens[top.open]!.level
      ) {
        stack.pop();
        if (top.items.length > 0 && top.allTasks) {
          taskLists.push({ open: top.open, close: i, items: top.items });
        }
      }
    }

    // 3. Rewrite the qualifying lists' tokens in place.
    for (const list of taskLists) {
      tokens[list.open]!.type = "taskList_open";
      tokens[list.close]!.type = "taskList_close";
      for (const itemOpen of list.items) {
        const item = tokens[itemOpen]!;
        item.type = "taskItem_open";
        item.attrSet("checked", String(checkedAt.get(itemOpen)));
        for (let j = itemOpen + 1; j < tokens.length; j++) {
          if (tokens[j]!.type === "list_item_close" && tokens[j]!.level === item.level) {
            tokens[j]!.type = "taskItem_close";
            break;
          }
        }
        const inline = tokens[itemOpen + 2]!;
        inline.content = inline.content.replace(/^\[[ xX]\] /, "");
        const firstText = inline.children?.find((c) => c.type === "text");
        if (firstText) firstText.content = firstText.content.replace(/^\[[ xX]\] /, "");
      }
    }
  });
}

const DOC_HREF =
  /^\/d\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * markdown-it rule: a plain link whose target is a document URL
 * (`[title](/d/<uuid>)`) becomes a pageRef token, so cross-references
 * round-trip as first-class nodes. Links with styled/nested content are left
 * as ordinary links.
 */
function pageRefPlugin(md: MarkdownIt) {
  md.core.ruler.push("page_refs", (state) => {
    for (const block of state.tokens) {
      if (block.type !== "inline" || !block.children) continue;
      const out: (typeof block.children)[number][] = [];
      for (let i = 0; i < block.children.length; i++) {
        const tok = block.children[i]!;
        const next = block.children[i + 1];
        const close = block.children[i + 2];
        const href = tok.type === "link_open" ? (tok.attrGet("href") ?? "") : "";
        const match = DOC_HREF.exec(href);
        if (
          match &&
          next?.type === "text" &&
          close?.type === "link_close"
        ) {
          const ref = new state.Token("pageRef", "a", 0);
          ref.attrs = [
            ["docId", match[1]!.toLowerCase()],
            ["title", next.content],
          ];
          out.push(ref);
          i += 2;
        } else {
          out.push(tok);
        }
      }
      block.children = out;
    }
  });
}

/** markdown-it rule: turn `<img …>` HTML (inline within a paragraph, or block
 * on its own line) into image tokens so display width round-trips. Other HTML
 * is left for the parser to ignore. */
function imgHtmlPlugin(md: MarkdownIt) {
  const makeImage = (state: { Token: typeof import("markdown-it/lib/token.mjs").default }, html: string) => {
    const tok = new state.Token("image", "img", 0);
    tok.attrs = [
      ["src", attr(html, "src") ?? ""],
      ["alt", attr(html, "alt") ?? ""],
    ];
    const title = attr(html, "title");
    const width = attr(html, "width");
    if (title) tok.attrs.push(["title", title]);
    if (width) tok.attrs.push(["width", width]);
    tok.children = [];
    return tok;
  };
  md.core.ruler.push("img_html_to_image", (state) => {
    const out: (typeof state.tokens)[number][] = [];
    for (const block of state.tokens) {
      // Inline `<img>` mixed with text.
      if (block.type === "inline" && block.children) {
        block.children = block.children.map((child) =>
          child.type === "html_inline" && /^<img\b/i.test(child.content) && attr(child.content, "src")
            ? makeImage(state, child.content)
            : child,
        );
      }
      // Block-level `<img>` on its own line -> a paragraph with an inline image.
      if (block.type === "html_block" && /^<img\b/i.test(block.content.trim()) && attr(block.content, "src")) {
        const open = new state.Token("paragraph_open", "p", 1);
        const inline = new state.Token("inline", "", 0);
        inline.children = [makeImage(state, block.content)];
        inline.content = "";
        const close = new state.Token("paragraph_close", "p", -1);
        out.push(open, inline, close);
      } else {
        out.push(block);
      }
    }
    state.tokens = out;
  });
}

/**
 * markdown-it rule: remap GFM table tokens into the shape prosemirror-markdown
 * expects for this schema. markdown-it emits `table/thead/tbody/tr/th/td`; the
 * PM schema wants `table > tableRow > (tableHeader|tableCell) > paragraph`. We
 * drop the thead/tbody wrappers, rename tr/th/td, and wrap each cell's inline
 * content in a paragraph (cells are `block+`). Column alignment isn't modeled,
 * so its attrs are simply ignored downstream.
 */
function tableTokensPlugin(md: MarkdownIt) {
  md.core.ruler.push("tandem_tables", (state) => {
    let touched = false;
    const out: (typeof state.tokens)[number][] = [];
    const paraOpen = () => new state.Token("paragraph_open", "p", 1);
    const paraClose = () => new state.Token("paragraph_close", "p", -1);
    for (const tok of state.tokens) {
      switch (tok.type) {
        case "thead_open":
        case "thead_close":
        case "tbody_open":
        case "tbody_close":
          touched = true;
          continue; // drop structural wrappers
        case "tr_open":
          tok.type = "tableRow_open";
          out.push(tok);
          break;
        case "tr_close":
          tok.type = "tableRow_close";
          out.push(tok);
          break;
        case "th_open":
          tok.type = "tableHeader_open";
          out.push(tok, paraOpen());
          break;
        case "th_close":
          out.push(paraClose());
          tok.type = "tableHeader_close";
          out.push(tok);
          break;
        case "td_open":
          tok.type = "tableCell_open";
          out.push(tok, paraOpen());
          break;
        case "td_close":
          out.push(paraClose());
          tok.type = "tableCell_close";
          out.push(tok);
          break;
        default:
          out.push(tok);
      }
    }
    if (touched) state.tokens = out;
  });
}

const CALLOUT_MARKER = /^\[!([A-Za-z][\w-]*)\]([+-]?)[ \t]*/;

/**
 * markdown-it rule: GitHub/Obsidian callout blockquotes (`> [!note] …`,
 * `> [!warning]- …`). A blockquote whose first paragraph opens with a `[!type]`
 * marker becomes a `callout`: the type + optional fold marker (`-` collapsed /
 * `+` open) are lifted into attrs and stripped from the text. Unknown types are
 * kept verbatim (rendered neutral) so foreign vaults import. Runs before inline
 * tokenization, editing `inline.content` (re-tokenized afterwards), like tasks.
 */
function calloutPlugin(md: MarkdownIt) {
  md.core.ruler.after("block", "callouts", (state) => {
    const tokens = state.tokens;
    const dropParagraphAt = new Set<number>();
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i]!.type !== "blockquote_open") continue;
      const inline = tokens[i + 2];
      if (tokens[i + 1]?.type !== "paragraph_open" || inline?.type !== "inline") continue;
      const match = CALLOUT_MARKER.exec(inline.content);
      if (!match) continue;
      const level = tokens[i]!.level;
      let close = -1;
      for (let j = i + 1; j < tokens.length; j++) {
        if (tokens[j]!.type === "blockquote_close" && tokens[j]!.level === level) {
          close = j;
          break;
        }
      }
      if (close === -1) continue;
      const open = tokens[i]!;
      open.type = "callout_open";
      open.attrSet("type", match[1]!.toLowerCase());
      open.attrSet("collapsible", String(match[2] !== ""));
      open.attrSet("collapsed", String(match[2] === "-"));
      tokens[close]!.type = "callout_close";
      // Strip the marker; drop a leading newline so a marker-only first line
      // doesn't open the callout with a blank line.
      inline.content = inline.content.replace(CALLOUT_MARKER, "").replace(/^\n/, "");
      // If that emptied the first paragraph AND the callout has other content,
      // drop the paragraph. Keep it (empty) when it's the callout's only block
      // (content is `block+`).
      if (inline.content === "" && close > i + 4) dropParagraphAt.add(i + 1);
    }
    if (dropParagraphAt.size === 0) return;
    // Remove each emptied first paragraph (open, inline, close at p, p+1, p+2).
    state.tokens = tokens.filter(
      (_t, idx) =>
        !(dropParagraphAt.has(idx) || dropParagraphAt.has(idx - 1) || dropParagraphAt.has(idx - 2)),
    );
  });
}

const SUMMARY_RE = /<summary>([\s\S]*?)<\/summary>/i;
const DETAILS_OPEN = /^\s*<details[\s>]/i;
const DETAILS_CLOSE = /^\s*<\/details>\s*$/i;

/** Recursively remap a run of tokens, converting `<details>…</details>` pairs
 * into toggle nodes. Nesting-aware via the recursion on the inner slice. */
function convertDetails(
  toks: Token[],
  state: { Token: typeof import("markdown-it/lib/token.mjs").default },
): Token[] {
  const isOpen = (t: Token) => t.type === "html_block" && DETAILS_OPEN.test(t.content);
  const isClose = (t: Token) => t.type === "html_block" && DETAILS_CLOSE.test(t.content);
  const out: Token[] = [];
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i]!;
    if (!isOpen(tok)) {
      out.push(tok);
      continue;
    }
    let depth = 1;
    let close = -1;
    for (let j = i + 1; j < toks.length; j++) {
      if (isOpen(toks[j]!)) depth++;
      else if (isClose(toks[j]!) && --depth === 0) {
        close = j;
        break;
      }
    }
    if (close === -1) {
      out.push(tok);
      continue;
    }
    let inner = toks.slice(i + 1, close);
    let summary = (SUMMARY_RE.exec(tok.content)?.[1] ?? "").trim();
    // Tolerate a `<summary>` emitted as its own html_block (some exporters).
    if (!summary && inner[0]?.type === "html_block" && SUMMARY_RE.test(inner[0].content)) {
      summary = (SUMMARY_RE.exec(inner[0].content)?.[1] ?? "").trim();
      inner = inner.slice(1);
    }
    inner = convertDetails(inner, state);
    // toggleContent is `block+`: guarantee at least one block.
    if (!inner.some((t) => t.nesting === 1)) {
      inner = [
        new state.Token("paragraph_open", "p", 1),
        Object.assign(new state.Token("inline", "", 0), { content: "", children: [] }),
        new state.Token("paragraph_close", "p", -1),
      ];
    }
    const sInline = new state.Token("inline", "", 0);
    sInline.content = summary;
    sInline.children = summary
      ? [Object.assign(new state.Token("text", "", 0), { content: summary })]
      : [];
    out.push(
      new state.Token("toggle_open", "details", 1),
      new state.Token("toggleSummary_open", "summary", 1),
      sInline,
      new state.Token("toggleSummary_close", "summary", -1),
      new state.Token("toggleContent_open", "div", 1),
      ...inner,
      new state.Token("toggleContent_close", "div", -1),
      new state.Token("toggle_close", "details", -1),
    );
    i = close;
  }
  return out;
}

/**
 * markdown-it rule: `<details><summary>…</summary> … </details>` HTML becomes a
 * `toggle` node. With `html:true`, markdown-it emits the opening `<details>`
 * (with the inline `<summary>`) and the closing `</details>` as separate
 * html_block tokens and parses the markdown between them normally, so we only
 * remap the two ends and wrap the summary + inner blocks.
 */
function detailsPlugin(md: MarkdownIt) {
  md.core.ruler.push("tandem_details", (state) => {
    if (!state.tokens.some((t) => t.type === "html_block" && DETAILS_OPEN.test(t.content))) return;
    state.tokens = convertDetails(state.tokens, state);
  });
}

/** Serialize a table cell's blocks to a single inline string (marks kept),
 * safe to drop into a `| … |` row. Reuses the full serializer at call time. */
function cellToInline(cell: Node): string {
  if (cell.content.size === 0) return "";
  const md = serializer.serialize(schema.node("doc", null, cell.content), {
    tightLists: true,
  });
  return md.trim().replace(/\n+/g, " ").replace(/\|/g, "\\|");
}

// Serializer keyed to TipTap StarterKit node/mark names. We reuse the default
// implementations where the logic is identical, and override the two that read
// TipTap-specific attrs (codeBlock.language, orderedList.start).
const serializer = new MarkdownSerializer(
  {
    text: d.text!,
    paragraph: d.paragraph!,
    heading: d.heading!,
    blockquote: d.blockquote!,
    horizontalRule: d.horizontal_rule!,
    hardBreak: d.hard_break!,
    bulletList: d.bullet_list!,
    listItem: d.list_item!,
    // GitHub-style task list: `- [ ] open` / `- [x] done`.
    taskList(state, node) {
      state.renderList(node, "  ", () => "- ");
    },
    taskItem(state, node) {
      state.write(node.attrs.checked ? "[x] " : "[ ] ");
      state.renderContent(node);
    },
    codeBlock(state, node) {
      const lang = (node.attrs.language as string) ?? "";
      // Widen the fence past any run of backticks in the body so code
      // containing ``` doesn't terminate the fence early.
      const longest = (node.textContent.match(/`+/g) ?? [])
        .reduce((m, run) => Math.max(m, run.length), 0);
      const fence = "`".repeat(Math.max(3, longest + 1));
      state.write(fence + lang + "\n");
      state.text(node.textContent, false);
      state.ensureNewLine();
      state.write(fence);
      state.closeBlock(node);
    },
    orderedList(state, node) {
      const start = (node.attrs.start as number) ?? 1;
      const maxW = String(start + node.childCount - 1).length;
      const space = state.repeat(" ", maxW + 2);
      state.renderList(node, space, (i) => {
        const nStr = String(start + i);
        return state.repeat(" ", maxW - nStr.length) + nStr + ". ";
      });
    },
    pageRef(state, node) {
      const title = String(node.attrs.title || "Untitled");
      state.write(`[${state.esc(title)}](/d/${node.attrs.docId})`);
    },
    // GFM pipe table. The first row is written as the header (the editor always
    // inserts one). Cells hold inline content only: we serialize each cell's
    // blocks, then flatten newlines to spaces and escape pipes so the row can't
    // break. Column alignment and cell block structure aren't representable.
    table(state, node) {
      const rows: string[][] = [];
      node.forEach((row) => {
        const cells: string[] = [];
        row.forEach((cell) => cells.push(cellToInline(cell)));
        rows.push(cells);
      });
      if (rows.length === 0) {
        state.closeBlock(node);
        return;
      }
      const cols = Math.max(...rows.map((r) => r.length));
      const line = (cells: string[]) => {
        const padded = [...cells];
        while (padded.length < cols) padded.push("");
        return `| ${padded.join(" | ")} |`;
      };
      const lines = [line(rows[0]!), `| ${Array(cols).fill("---").join(" | ")} |`];
      for (let i = 1; i < rows.length; i++) lines.push(line(rows[i]!));
      state.write(lines.join("\n"));
      state.closeBlock(node);
    },
    // GitHub/Obsidian callout: `> [!type]` (+ fold marker) then blockquoted body.
    callout(state, node) {
      const type = String(node.attrs.type ?? "note");
      const fold = node.attrs.collapsible ? (node.attrs.collapsed ? "-" : "+") : "";
      state.wrapBlock("> ", null, node, () => {
        state.write(`[!${type}]${fold}`);
        state.ensureNewLine();
        state.renderContent(node);
      });
    },
    // Collapsible section as standard <details> HTML (portable, foldable on
    // GitHub). Blank lines around the body let markdown-it parse it as markdown.
    toggle(state, node) {
      const summary = node.child(0).textContent;
      state.write("<details>\n");
      state.write(`<summary>${escHtml(summary)}</summary>\n\n`);
      state.renderContent(node.child(1));
      state.ensureNewLine();
      state.write("</details>");
      state.closeBlock(node);
    },
    image(state, node) {
      const { src, alt, title, width } = node.attrs as {
        src: string;
        alt?: string;
        title?: string;
        width?: string | null;
      };
      if (width) {
        // GitHub-style HTML so the display width survives in markdown.
        const parts = [`src="${escAttr(src)}"`];
        if (alt) parts.push(`alt="${escAttr(alt)}"`);
        if (title) parts.push(`title="${escAttr(title)}"`);
        parts.push(`width="${escAttr(String(width))}"`);
        state.write(`<img ${parts.join(" ")}>`);
      } else {
        state.write(
          `![${state.esc(alt ?? "")}](${src}${title ? ` ${JSON.stringify(title)}` : ""})`,
        );
      }
    },
  },
  {
    bold: m.strong!,
    italic: m.em!,
    code: m.code!,
    link: m.link!,
    strike: {
      open: "~~",
      close: "~~",
      mixable: true,
      expelEnclosingWhitespace: true,
    },
  },
);

// Parser mapping markdown-it tokens to TipTap node/mark names.
const parser = new MarkdownParser(
  schema,
  MarkdownIt("commonmark", { html: true })
    .enable("strikethrough")
    .enable("table")
    .use(imgHtmlPlugin)
    .use(taskListPlugin)
    .use(tableTokensPlugin)
    .use(pageRefPlugin)
    .use(calloutPlugin)
    .use(detailsPlugin),
  {
  blockquote: { block: "blockquote" },
  callout: {
    block: "callout",
    getAttrs: (tok) => ({
      type: tok.attrGet("type") ?? "note",
      collapsible: tok.attrGet("collapsible") === "true",
      collapsed: tok.attrGet("collapsed") === "true",
    }),
  },
  toggle: { block: "toggle" },
  toggleSummary: { block: "toggleSummary" },
  toggleContent: { block: "toggleContent" },
  paragraph: { block: "paragraph" },
  list_item: { block: "listItem" },
  bullet_list: { block: "bulletList" },
  taskList: { block: "taskList" },
  taskItem: {
    block: "taskItem",
    getAttrs: (tok) => ({ checked: tok.attrGet("checked") === "true" }),
  },
  table: { block: "table" },
  tableRow: { block: "tableRow" },
  tableHeader: { block: "tableHeader" },
  tableCell: { block: "tableCell" },
  ordered_list: {
    block: "orderedList",
    getAttrs: (tok) => ({ start: +(tok.attrGet("start") ?? 1) || 1 }),
  },
  heading: {
    block: "heading",
    getAttrs: (tok) => ({ level: +tok.tag.slice(1) }),
  },
  code_block: { block: "codeBlock", noCloseToken: true },
  fence: {
    block: "codeBlock",
    getAttrs: (tok) => ({ language: tok.info || "" }),
    noCloseToken: true,
  },
  hr: { node: "horizontalRule" },
  hardbreak: { node: "hardBreak" },
  em: { mark: "italic" },
  strong: { mark: "bold" },
  s: { mark: "strike" },
  code_inline: { mark: "code", noCloseToken: true },
  link: {
    mark: "link",
    getAttrs: (tok) => ({
      href: tok.attrGet("href"),
      title: tok.attrGet("title") || null,
    }),
  },
  pageRef: {
    node: "pageRef",
    getAttrs: (tok) => ({
      docId: tok.attrGet("docId"),
      title: tok.attrGet("title") ?? "",
    }),
  },
  image: {
    node: "image",
    getAttrs: (tok) => ({
      src: tok.attrGet("src"),
      alt: tok.attrGet("alt") || tok.children?.[0]?.content || null,
      title: tok.attrGet("title") || null,
      width: tok.attrGet("width") || null,
    }),
  },
  // Other inline/block HTML (non-img) is dropped rather than throwing.
  html_inline: { ignore: true, noCloseToken: true },
  html_block: { ignore: true, noCloseToken: true },
});

/**
 * Reverse markdown escaping inside math spans (`$…$`, `$$…$$`). Math is stored
 * as plain text, so the serializer escapes its backslashes/underscores/etc.;
 * that would leave `$\\frac{a}{b}$` in the derived markdown, which breaks TeX
 * for export and MCP reads. Undo the escaping within delimiters so the source
 * stays clean. (Block first so `$$…$$` isn't split by the inline pass.)
 */
function unescapeMath(md: string): string {
  const undo = (tex: string) => tex.replace(/\\(.)/g, "$1");
  return md
    .replace(/\$\$([^$]+?)\$\$/g, (_m, tex: string) => `$$${undo(tex)}$$`)
    .replace(/(?<!\$)\$([^\n$]+?)\$(?!\$)/g, (_m, tex: string) => `$${undo(tex)}$`);
}

/** Serialize a ProseMirror node (this schema) to canonical markdown. */
export function nodeToMarkdown(node: Node): string {
  // Tight lists: no blank line between items (the GitHub-typical form, and
  // what task lists must look like). Loose/tight isn't represented in the
  // document model, so serialization normalizes it.
  return unescapeMath(serializer.serialize(node, { tightLists: true }));
}

/** Serialize ProseMirror JSON to markdown. */
export function jsonToMarkdown(json: unknown): string {
  return nodeToMarkdown(schema.nodeFromJSON(json as never));
}

/** Parse markdown into a ProseMirror node of this schema. */
export function markdownToNode(markdown: string): Node {
  return parser.parse(markdown) ?? schema.topNodeType.createAndFill()!;
}

/** Parse markdown into ProseMirror JSON. */
export function markdownToJSON(markdown: string): unknown {
  return markdownToNode(markdown).toJSON();
}

/** Round-trip markdown through the document model (normalization). */
export function normalizeMarkdown(markdown: string): string {
  return jsonToMarkdown(markdownToJSON(markdown));
}
