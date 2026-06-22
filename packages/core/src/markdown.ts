import {
  defaultMarkdownParser,
  defaultMarkdownSerializer,
  schema,
} from "prosemirror-markdown";
import type { Node } from "prosemirror-model";

/**
 * The canonical ProseMirror schema for stored content. The TipTap editor
 * (Phase 2) and the Hocuspocus persistence hook (Phase 3) MUST use a schema
 * compatible with this one — it is the single source of truth for the document
 * model so markdown <-> JSON <-> Y.Doc all round-trip.
 */
export { schema };

/** Parse markdown into ProseMirror JSON (for content_json + editor hydration). */
export function markdownToJSON(markdown: string): unknown {
  const doc: Node = defaultMarkdownParser.parse(markdown) ??
    schema.topNodeType.createAndFill()!;
  return doc.toJSON();
}

/** Serialize ProseMirror JSON back to canonical markdown (the read model). */
export function jsonToMarkdown(json: unknown): string {
  const doc = schema.nodeFromJSON(json as Parameters<typeof schema.nodeFromJSON>[0]);
  return defaultMarkdownSerializer.serialize(doc);
}

/** Normalize markdown by round-tripping through the document model. */
export function normalizeMarkdown(markdown: string): string {
  return jsonToMarkdown(markdownToJSON(markdown));
}
