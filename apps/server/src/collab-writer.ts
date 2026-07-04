import {
  applyAttributedEdit,
  COLLAB_FIELD,
  jsonToMarkdown,
  markdownToJSON,
  type AuthorIdentity,
} from "@tandem/editor";
import { yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import type { Hocuspocus } from "@hocuspocus/server";
import { DocumentWriteDeniedError, type DocumentService } from "@tandem/core";

/**
 * The agent/server write path. Edits funnel through the SAME live Y.Doc that
 * human editors use (via Hocuspocus openDirectConnection), so there is exactly
 * one write path — no split brain between MCP writes and live sessions. Every
 * edit is applied as an attributed transform (fresh clientID + author stamp),
 * so blame ties each AI-written span to the human whose session invoked it.
 */
export function createCollabWriter(
  hocuspocus: Hocuspocus,
  documents: DocumentService,
  author: AuthorIdentity,
) {
  return {
    /**
     * Read the live markdown, apply `transform` to it, and write the result
     * back as a minimal attributed edit (structural diff — unchanged content
     * keeps its authorship). Throws DocumentWriteDeniedError for read-only
     * docs BEFORE touching the live doc: mutating it would broadcast content
     * to connected editors that RLS would then refuse to persist.
     */
    async transform(
      docId: string,
      transform: (currentMd: string) => string,
    ): Promise<void> {
      if (!(await documents.canWrite(docId))) {
        throw new DocumentWriteDeniedError();
      }
      const connection = await hocuspocus.openDirectConnection(docId, {
        userId: author.userId,
      });
      try {
        let currentMd = "";
        await connection.transact((doc) => {
          const fragment = doc.getXmlFragment(COLLAB_FIELD);
          currentMd =
            fragment.length > 0
              ? jsonToMarkdown(yXmlFragmentToProsemirrorJSON(fragment))
              : "";
        });
        // Run the transform outside the transaction: a bad target (e.g.
        // old_string not found) must abort cleanly with the doc untouched.
        const nextJson = markdownToJSON(transform(currentMd));
        await connection.transact((doc) => {
          applyAttributedEdit(doc, nextJson, { ...author, at: Date.now() });
        });
      } finally {
        await connection.disconnect();
      }
    },
  };
}

export type CollabWriter = ReturnType<typeof createCollabWriter>;
