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

const attr = (html: string, name: string): string | null =>
  new RegExp(`${name}="([^"]*)"`, "i").exec(html)?.[1] ?? null;
const escAttr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

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
    .use(imgHtmlPlugin)
    .use(taskListPlugin)
    .use(pageRefPlugin),
  {
  blockquote: { block: "blockquote" },
  paragraph: { block: "paragraph" },
  list_item: { block: "listItem" },
  bullet_list: { block: "bulletList" },
  taskList: { block: "taskList" },
  taskItem: {
    block: "taskItem",
    getAttrs: (tok) => ({ checked: tok.attrGet("checked") === "true" }),
  },
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

/** Serialize a ProseMirror node (this schema) to canonical markdown. */
export function nodeToMarkdown(node: Node): string {
  // Tight lists: no blank line between items (the GitHub-typical form, and
  // what task lists must look like). Loose/tight isn't represented in the
  // document model, so serialization normalizes it.
  return serializer.serialize(node, { tightLists: true });
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
