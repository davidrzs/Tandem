import { Hocuspocus } from "@hocuspocus/server";
import type { Database } from "@realtime/db";
import { COLLAB_FIELD, jsonToMarkdown, markdownToJSON, schema } from "@realtime/editor";
import {
  prosemirrorJSONToYDoc,
  yXmlFragmentToProsemirrorJSON,
} from "y-prosemirror";
import * as Y from "yjs";
import type { Auth } from "./auth.js";
import { createServices } from "./services.js";

/**
 * Hocuspocus realtime engine. Yjs is the live WRITE model; on every (debounced)
 * change we persist the binary state AND derive the markdown READ model. Every
 * connection acts as its authenticated user, so persistence runs RLS-scoped —
 * a user can only load/store documents in their own workspaces. All edits
 * (human and MCP/agent) flow through this single Y.Doc: one write path.
 */
export function createHocuspocus(
  db: Database,
  auth: Auth,
  opts: { debounce?: number } = {},
) {
  const servicesFor = (userId: string) =>
    createServices(db, { kind: "user", userId });

  return new Hocuspocus({
    debounce: opts.debounce ?? 2000,
    // Authenticate the socket via the Better Auth session cookie on the
    // handshake; the resulting userId scopes all persistence for this doc.
    async onAuthenticate({ requestHeaders }) {
      const session = await auth.api.getSession({ headers: requestHeaders });
      if (!session) throw new Error("Unauthorized");
      return { userId: session.user.id };
    },

    async onLoadDocument({ document, documentName, context }) {
      const doc = await servicesFor(context.userId).documents.get(documentName);
      if (!doc) throw new Error("document not found"); // not yours / doesn't exist

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

    async onStoreDocument({ document, documentName, lastContext }) {
      const json = yXmlFragmentToProsemirrorJSON(
        document.getXmlFragment(COLLAB_FIELD),
      );
      await servicesFor(lastContext.userId).documents.saveCollabSnapshot(
        documentName,
        {
          ydocState: Y.encodeStateAsUpdate(document),
          contentJson: json,
          contentMd: jsonToMarkdown(json),
        },
      );
    },
  });
}
