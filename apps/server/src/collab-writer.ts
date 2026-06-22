import { COLLAB_FIELD, markdownToJSON, schema } from "@realtime/editor";
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import type { Hocuspocus } from "@hocuspocus/server";

type ProseMirrorJSON = { type: string; content?: unknown[] };

/**
 * The agent/server write path. Edits funnel through the SAME live Y.Doc that
 * human editors use (via Hocuspocus openDirectConnection), so there is exactly
 * one write path — no split brain between MCP writes and live sessions.
 */
export function createCollabWriter(hocuspocus: Hocuspocus) {
  async function withDoc(docId: string, mutate: (json: ProseMirrorJSON) => ProseMirrorJSON) {
    const connection = await hocuspocus.openDirectConnection(docId, {
      userId: "mcp",
    });
    try {
      await connection.transact((doc) => {
        const fragment = doc.getXmlFragment(COLLAB_FIELD);
        const current = yXmlFragmentToProsemirrorJSON(fragment) as ProseMirrorJSON;
        const next = mutate(current);
        fragment.delete(0, fragment.length);
        prosemirrorJSONToYXmlFragment(schema, next, fragment);
      });
    } finally {
      await connection.disconnect();
    }
  }

  return {
    /** Replace the whole document body with parsed markdown. */
    async replaceBody(docId: string, markdown: string) {
      await withDoc(docId, () => markdownToJSON(markdown) as ProseMirrorJSON);
    },

    /** Append parsed markdown to the end of the document (block-scoped). */
    async appendSection(docId: string, markdown: string) {
      const added = markdownToJSON(markdown) as ProseMirrorJSON;
      await withDoc(docId, (current) => ({
        ...current,
        content: [...(current.content ?? []), ...(added.content ?? [])],
      }));
    },
  };
}

export type CollabWriter = ReturnType<typeof createCollabWriter>;
