import { Hocuspocus } from "@hocuspocus/server";
import { session } from "@realtime/db";
import { COLLAB_FIELD, jsonToMarkdown, markdownToJSON, schema } from "@realtime/editor";
import { eq } from "drizzle-orm";
import {
  prosemirrorJSONToYDoc,
  yXmlFragmentToProsemirrorJSON,
} from "y-prosemirror";
import * as Y from "yjs";
import type { Services } from "./services.js";

/**
 * Hocuspocus realtime engine. Yjs is the live WRITE model; on every (debounced)
 * change we persist the binary state AND derive the markdown READ model. Auth
 * is enforced per-connection. All edits — human and (Phase 3e) agent — flow
 * through this single Y.Doc, so there is exactly one write path.
 */
export function createHocuspocus(services: Services, opts: { debounce?: number } = {}) {
  return new Hocuspocus({
    debounce: opts.debounce ?? 2000,
    // Verify the Better Auth session token the provider sends (it equals the
    // value in the session table — same token the auth cookie carries).
    async onAuthenticate({ token }) {
      const [row] = await services.db
        .select({ userId: session.userId, expiresAt: session.expiresAt })
        .from(session)
        .where(eq(session.token, token));
      if (!row || row.expiresAt.getTime() < Date.now()) {
        throw new Error("Unauthorized");
      }
      return { userId: row.userId };
    },

    // Hydrate the Y.Doc: restore CRDT state, or seed once from stored markdown.
    async onLoadDocument({ document, documentName }) {
      const doc = await services.documents.get(documentName);
      if (!doc) throw new Error("document not found");

      if (doc.ydocState) {
        Y.applyUpdate(document, doc.ydocState);
      } else if (doc.contentMd) {
        const seeded = prosemirrorJSONToYDoc(
          schema,
          markdownToJSON(doc.contentMd),
          COLLAB_FIELD,
        );
        Y.applyUpdate(document, Y.encodeStateAsUpdate(seeded));
      }
      return document;
    },

    // The single durable write: persist binary state + derived markdown.
    async onStoreDocument({ document, documentName }) {
      const json = yXmlFragmentToProsemirrorJSON(
        document.getXmlFragment(COLLAB_FIELD),
      );
      await services.documents.saveCollabSnapshot(documentName, {
        ydocState: Y.encodeStateAsUpdate(document),
        contentJson: json,
        contentMd: jsonToMarkdown(json),
      });
    },
  });
}
