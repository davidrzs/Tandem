import { getSchema, Node } from "@tiptap/core";
import ImageBase from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Table from "@tiptap/extension-table";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";
import TaskItemBase from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import StarterKit from "@tiptap/starter-kit";
import type { Extensions } from "@tiptap/core";
import type { Schema } from "@tiptap/pm/model";
import { liveSectionGuard } from "./live-section-guard.js";

/**
 * Image node with a display `width` attribute (resize is a layout attribute,
 * not a re-encode). Shared by the client editor and the server schema so
 * Y.Doc <-> JSON <-> markdown stay aligned.
 */
export const Image = ImageBase.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (el) => el.getAttribute("width"),
        renderHTML: (attrs) => (attrs.width ? { width: attrs.width } : {}),
      },
    };
  },
});

/**
 * A first-class reference to another document (a live mention chip). The
 * binding is the document ID — moving/reparenting the target never breaks it.
 * `title` is only a snapshot for the derived markdown ("[title](/d/id)"); the
 * editor renders the target's CURRENT title, so renames propagate on view
 * without anyone touching this node (mutating it would create phantom edits
 * attributed to whoever happened to be looking).
 */
export const PageRef = Node.create({
  name: "pageRef",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      docId: { default: null },
      title: { default: "" },
    };
  },
  parseHTML() {
    return [
      {
        tag: "a[data-page-ref]",
        // Structural type: this package compiles without DOM libs (it runs
        // on the server too), and parseHTML only ever sees elements.
        getAttrs: (el) => {
          const node = el as unknown as {
            getAttribute(name: string): string | null;
            textContent: string | null;
          };
          return {
            docId: node.getAttribute("data-page-ref"),
            title: node.textContent ?? "",
          };
        },
      },
    ];
  },
  renderHTML({ node }) {
    return [
      "a",
      {
        "data-page-ref": node.attrs.docId,
        href: `/d/${node.attrs.docId}`,
        class: "page-ref",
      },
      String(node.attrs.title || "Untitled"),
    ];
  },
});

/**
 * A task item with a stable `blockId`, the key of its row in the `tasks`
 * projection. The id lives only in the document model, never in markdown;
 * edits that rebuild the body from markdown carry it over by matching tasks
 * (see withTaskBlockIds). A split leaves the new half without one, and the
 * server assigns ids to items that lack one when it stores the doc. The HTML
 * attribute keeps the id when a task is cut and pasted to another page.
 */
export const TaskItem = TaskItemBase.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      blockId: {
        default: null,
        keepOnSplit: false,
        parseHTML: (el) => {
          // Structural type: see PageRef.
          const node = el as unknown as { getAttribute(name: string): string | null };
          return node.getAttribute("data-block-id");
        },
        renderHTML: (attrs) => (attrs.blockId ? { "data-block-id": attrs.blockId } : {}),
      },
    };
  },
}).configure({ nested: true });

/** The fixed menu of live section queries, resolved against the page that
 * holds the section whenever it renders. */
export const LIVE_SECTION_QUERIES = [
  "open_from_last_time",
  "since_last_meeting",
  "open_tasks_here",
] as const;
export type LiveSectionQuery = (typeof LIVE_SECTION_QUERIES)[number];

export function isLiveSectionQuery(value: unknown): value is LiveSectionQuery {
  return (LIVE_SECTION_QUERIES as readonly unknown[]).includes(value);
}

/**
 * A read-only view computed from the workspace (open tasks of the previous
 * meeting, what changed since it, open tasks under this page, the meetings
 * under this page). Only the query is stored; in markdown it is the comment
 * `<!-- live-section: q -->`, which search and the task scan both ignore.
 */
export const LiveSection = Node.create({
  name: "liveSection",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return { query: { default: "open_tasks_here" } };
  },
  parseHTML() {
    return [
      {
        tag: "div[data-live-section]",
        getAttrs: (el) => {
          const node = el as unknown as { getAttribute(name: string): string | null };
          const query = node.getAttribute("data-live-section");
          return isLiveSectionQuery(query) ? { query } : false;
        },
      },
    ];
  },
  addProseMirrorPlugins() {
    return [liveSectionGuard()];
  },
  renderHTML({ node }) {
    return ["div", { "data-live-section": String(node.attrs.query), class: "live-section" }];
  },
});

/**
 * A callout / admonition box (GitHub & Obsidian "alert" blockquotes:
 * `> [!note] …`). `type` picks the flavour (note/tip/warning/important/caution,
 * or any label — unknown types render neutral so foreign vaults import cleanly).
 * `collapsible`/`collapsed` carry Obsidian's fold markers (`-`/`+`); the actual
 * open/closed state a reader sees is local NodeView state, never written back to
 * the document.
 */
export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes() {
    return {
      type: { default: "note" },
      collapsible: { default: false },
      collapsed: { default: false },
    };
  },
  parseHTML() {
    return [
      {
        tag: "div[data-callout]",
        getAttrs: (el) => {
          const node = el as unknown as { getAttribute(name: string): string | null };
          return {
            type: node.getAttribute("data-callout") || "note",
            collapsible: node.getAttribute("data-collapsible") === "true",
            collapsed: node.getAttribute("data-collapsed") === "true",
          };
        },
      },
    ];
  },
  renderHTML({ node }) {
    return [
      "div",
      {
        "data-callout": String(node.attrs.type),
        "data-collapsible": String(node.attrs.collapsible),
        "data-collapsed": String(node.attrs.collapsed),
        class: `callout callout-${node.attrs.type}`,
      },
      0,
    ];
  },
});

/**
 * A collapsible section, serialized as standard `<details><summary>` HTML so it
 * stays foldable on GitHub and portable everywhere. The summary is real inline
 * content (CRDT-merged, blame-tracked); the content is arbitrary blocks. A
 * reader's open/closed toggle is local NodeView state — it never mutates the doc.
 */
export const Toggle = Node.create({
  name: "toggle",
  group: "block",
  content: "toggleSummary toggleContent",
  defining: true,
  parseHTML() {
    return [{ tag: "details" }];
  },
  renderHTML() {
    return ["details", { class: "toggle", open: "open" }, 0];
  },
});

export const ToggleSummary = Node.create({
  name: "toggleSummary",
  content: "inline*",
  defining: true,
  parseHTML() {
    return [{ tag: "summary" }];
  },
  renderHTML() {
    return ["summary", { class: "toggle-summary" }, 0];
  },
});

export const ToggleContent = Node.create({
  name: "toggleContent",
  content: "block+",
  defining: true,
  parseHTML() {
    return [{ tag: "div[data-toggle-content]" }];
  },
  renderHTML() {
    return ["div", { "data-toggle-content": "", class: "toggle-content" }, 0];
  },
});

/**
 * The single source of truth for the document model. Both the client editor
 * and the server (Hocuspocus persistence, MCP writes) build their ProseMirror
 * schema from THIS extension list, so Y.Doc <-> JSON <-> markdown all align.
 *
 * `history` is left enabled here (it doesn't affect the schema); the client
 * disables it when the Collaboration extension is active (Yjs owns undo).
 */
// Inline so a markdown `![alt](src)` parses into a paragraph's inline content.
// Task lists carry the in-document TODOs (`- [ ] @user …`) that feed the
// per-user start page.
export const baseExtensions: Extensions = [
  StarterKit,
  Link,
  Image.configure({ inline: true }),
  TaskList,
  TaskItem,
  PageRef,
  LiveSection,
  Callout,
  Toggle,
  ToggleSummary,
  ToggleContent,
  // Column resize stores a per-cell colwidth that the markdown read model can't
  // carry, so it's off — GFM tables round-trip cleanly, widths don't.
  Table.configure({ resizable: false }),
  TableRow,
  TableHeader,
  TableCell,
];

/** ProseMirror schema derived from the shared extensions (no DOM required). */
export const schema: Schema = getSchema(baseExtensions);

/** The Yjs XML fragment field name — must match on client and server. */
export const COLLAB_FIELD = "default";
