import { Hocuspocus } from "@hocuspocus/server";
import { COLLAB_FIELD, jsonToMarkdown, markdownToJSON, schema } from "@realtime/editor";
import {
  prosemirrorJSONToYDoc,
  yXmlFragmentToProsemirrorJSON,
} from "y-prosemirror";
import * as Y from "yjs";
import type { Auth } from "./auth.js";
import type { Services } from "./services.js";

/**
 * Hocuspocus realtime engine. Yjs is the live WRITE model; on every (debounced)
 * change we persist the binary state AND derive the markdown READ model. Auth
 * is enforced per-connection. All edits — human and (Phase 3e) agent — flow
 * through this single Y.Doc, so there is exactly one write path.
 */
export function createHocuspocus(
  services: Services,
  auth: Auth,
  opts: { debounce?: number } = {},
) {
  return new Hocuspocus({
    debounce: opts.debounce ?? 2000,
    // Authenticate the socket via the Better Auth session cookie carried on the
    // WebSocket handshake (same-origin through the dev proxy).
    async onAuthenticate({ requestHeaders }) {
      const session = await auth.api.getSession({ headers: requestHeaders });
      if (!session) throw new Error("Unauthorized");
      return { userId: session.user.id };
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
