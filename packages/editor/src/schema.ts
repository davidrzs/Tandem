import { getSchema, Node } from "@tiptap/core";
import ImageBase from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Table from "@tiptap/extension-table";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import StarterKit from "@tiptap/starter-kit";
import type { Extensions } from "@tiptap/core";
import type { Schema } from "@tiptap/pm/model";

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
 * A first-class reference to another document (Outline-style mention). The
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
  TaskItem.configure({ nested: true }),
  PageRef,
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
