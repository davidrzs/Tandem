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
const parser = new MarkdownParser(schema, MarkdownIt("commonmark", { html: false }).enable("strikethrough"), {
  blockquote: { block: "blockquote" },
  paragraph: { block: "paragraph" },
  list_item: { block: "listItem" },
  bullet_list: { block: "bulletList" },
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
  // No image node in the schema — drop image syntax rather than throw.
  // image is a single (self-closing) token, so noCloseToken registers the no-op.
  image: { ignore: true, noCloseToken: true },
});

/** Serialize a ProseMirror node (this schema) to canonical markdown. */
export function nodeToMarkdown(node: Node): string {
  return serializer.serialize(node);
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
