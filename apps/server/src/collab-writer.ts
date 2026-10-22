import {
  applyAttributedEdit,
  applyAttributedProperties,
  COLLAB_FIELD,
  diffProperties,
  jsonToMarkdown,
  markdownToJSON,
  propertiesToJSON,
  stateProperties,
  stateToJSON,
  type AuthorIdentity,
  type PropertyOp,
} from "@tandem/editor";
import { yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import * as Y from "yjs";
import type { Hocuspocus } from "@hocuspocus/server";
import {
  DocumentWriteDeniedError,
  type DocumentService,
  type SnapshotService,
} from "@tandem/core";

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
  snapshots?: SnapshotService,
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
    ): Promise<number> {
      if (!(await documents.canWrite(docId))) {
        throw new DocumentWriteDeniedError();
      }
      const connection = await hocuspocus.openDirectConnection(docId, {
        userId: author.userId,
      });
      try {
        // Read, transform and apply in ONE transaction: nothing can land on
        // the live doc in between, so the whole-doc diff can't revert a
        // concurrent human edit. A bad target (e.g. old_string not found)
        // throws before any mutation, leaving the doc untouched.
        let clientId = 0;
        await connection.transact((doc) => {
          const fragment = doc.getXmlFragment(COLLAB_FIELD);
          const currentMd =
            fragment.length > 0 ? jsonToMarkdown(yXmlFragmentToProsemirrorJSON(fragment)) : "";
          const nextJson = markdownToJSON(transform(currentMd));
          clientId = applyAttributedEdit(doc, nextJson, { ...author, at: Date.now() });
        });
        return clientId;
      } finally {
        await connection.disconnect();
      }
    },

    /**
     * Apply a property patch to the live doc as one attributed session, the
     * way transform() does for the body. Returns the session's clientID, or
     * null when the patch changed nothing.
     */
    async setProperties(docId: string, ops: readonly PropertyOp[]): Promise<number | null> {
      if (!(await documents.canWrite(docId))) {
        throw new DocumentWriteDeniedError();
      }
      const connection = await hocuspocus.openDirectConnection(docId, {
        userId: author.userId,
      });
      try {
        let clientId: number | null = null;
        await connection.transact((doc) => {
          clientId = applyAttributedProperties(doc, ops, { ...author, at: Date.now() });
        });
        return clientId;
      } finally {
        await connection.disconnect();
      }
    },

    /**
     * Restore a document to a snapshot's state. Applies the snapshot's
     * ProseMirror JSON as an attributed edit (structural diff) and its
     * properties as a per-field patch, so unchanged content keeps its
     * original authorship and only the reverted spans and values are blamed
     * on the restorer. A no-op restore (body and properties already match)
     * makes no edit — avoiding a phantom blame session. Captures the live
     * state first so the restore is itself undoable.
     */
    async restoreTo(
      docId: string,
      snapshot: { ydocState: Uint8Array },
    ): Promise<{ changed: boolean }> {
      if (!(await documents.canWrite(docId))) {
        throw new DocumentWriteDeniedError();
      }
      const targetJson = stateToJSON(snapshot.ydocState);
      const targetProperties = stateProperties(snapshot.ydocState);
      const connection = await hocuspocus.openDirectConnection(docId, {
        userId: author.userId,
      });
      try {
        let currentJson: unknown;
        let propertyOps: PropertyOp[] = [];
        let liveState: Uint8Array = new Uint8Array();
        await connection.transact((doc) => {
          const fragment = doc.getXmlFragment(COLLAB_FIELD);
          currentJson =
            fragment.length > 0 ? yXmlFragmentToProsemirrorJSON(fragment) : markdownToJSON("");
          propertyOps = diffProperties(propertiesToJSON(doc), targetProperties);
          liveState = Y.encodeStateAsUpdate(doc);
        });
        // Already there — don't write (a stampAuthor would add a phantom session).
        if (JSON.stringify(currentJson) === JSON.stringify(targetJson) && propertyOps.length === 0) {
          return { changed: false };
        }
        if (snapshots) {
          const meta = await documents.getMeta(docId);
          if (meta) {
            await snapshots
              .capturePreRestore({
                documentId: docId,
                workspaceId: meta.workspaceId,
                ydocState: liveState,
                author: { userId: author.userId, name: author.name, ai: author.ai },
              })
              .catch((e) => console.error("pre-restore snapshot failed", e));
          }
        }
        await connection.transact((doc) => {
          applyAttributedEdit(doc, targetJson, { ...author, at: Date.now() }, propertyOps);
        });
        return { changed: true };
      } finally {
        await connection.disconnect();
      }
    },
  };
}

export type CollabWriter = ReturnType<typeof createCollabWriter>;
