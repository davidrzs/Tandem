import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import type { Extensions } from "@tiptap/core";
import type { Schema } from "@tiptap/pm/model";

/**
 * The single source of truth for the document model. Both the client editor
 * and the server (Hocuspocus persistence, MCP writes) build their ProseMirror
 * schema from THIS extension list, so Y.Doc <-> JSON <-> markdown all align.
 *
 * `history` is left enabled here (it doesn't affect the schema); the client
 * disables it when the Collaboration extension is active (Yjs owns undo).
 */
export const baseExtensions: Extensions = [StarterKit];

/** ProseMirror schema derived from the shared extensions (no DOM required). */
export const schema: Schema = getSchema(baseExtensions);

/** The Yjs XML fragment field name — must match on client and server. */
export const COLLAB_FIELD = "default";
