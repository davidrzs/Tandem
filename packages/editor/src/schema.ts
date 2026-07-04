import { getSchema } from "@tiptap/core";
import ImageBase from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
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
];

/** ProseMirror schema derived from the shared extensions (no DOM required). */
export const schema: Schema = getSchema(baseExtensions);

/** The Yjs XML fragment field name — must match on client and server. */
export const COLLAB_FIELD = "default";
