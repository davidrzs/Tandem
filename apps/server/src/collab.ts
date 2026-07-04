import { Hocuspocus, isTransactionOrigin } from "@hocuspocus/server";
import type { Database } from "@tandem/db";
import {
  COLLAB_FIELD,
  jsonToMarkdown,
  markdownToJSON,
  sanitizeClientAuthorsWrites,
  seedAttributedDoc,
  stampMissingFromUpdate,
  UNKNOWN_AUTHOR,
} from "@tandem/editor";
import { yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
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
    async onAuthenticate({ requestHeaders, documentName, connectionConfig }) {
      const session = await auth.api.getSession({ headers: requestHeaders });
      if (!session) throw new Error("Unauthorized");
      // Read-only collaborators connect read-only (RLS also blocks persistence).
      const canWrite = await servicesFor(session.user.id).documents.canWrite(
        documentName,
      );
      if (!canWrite) connectionConfig.readOnly = true;
      return { userId: session.user.id, userName: session.user.name };
    },

    async onLoadDocument({ document, documentName, context }) {
      const doc = await servicesFor(context.userId).documents.get(documentName);
      if (!doc) throw new Error("document not found"); // not yours / doesn't exist

      if (doc.ydocState) {
        Y.applyUpdate(document, doc.ydocState);
      } else if (doc.contentMd) {
        // Legacy doc from before Yjs persistence: its original authors are
        // unknowable, so the seed is explicitly attributed as such (and can
        // never be claimed by whichever user happens to load it first).
        const seeded = seedAttributedDoc(markdownToJSON(doc.contentMd), UNKNOWN_AUTHOR);
        Y.applyUpdate(document, Y.encodeStateAsUpdate(seeded));
      }
      return document;
    },

    // The attribution authority: any clientID that shows up in an update and
    // has no author entry yet is stamped with the *authenticated* identity of
    // the connection that sent it. Clients never self-report authorship.
    // Server-side edits (MCP writer, seeding) stamp themselves in the same
    // transaction that writes, so they are never "unknown" here.
    async onChange({ document, context, update, transactionOrigin }) {
      if (!context?.userId) return;
      const identity = () => ({
        userId: context.userId as string,
        name: (context.userName as string) ?? "",
        ai: false,
        at: Date.now(),
      });
      // Carry the connection context as the transaction origin so the store
      // hook this write schedules still persists under the user's identity
      // (a bare transact would blank lastContext and fail the store loud).
      document.transact(
        () => {
          // Only real websocket clients get sanitized: server-side writes
          // ("local" origins — MCP edits, our own stamps) legitimately write
          // the authors map with non-human identities.
          const fromWebsocketClient =
            isTransactionOrigin(transactionOrigin) &&
            transactionOrigin.source === "connection";
          if (fromWebsocketClient) {
            sanitizeClientAuthorsWrites(document, update, identity);
          }
          stampMissingFromUpdate(document, update, identity);
        },
        { source: "local", context },
      );
    },

    async onStoreDocument({ document, documentName, lastContext }) {
      // Persisting runs RLS-scoped to this user; without one the UPDATE would
      // silently match no rows. Fail loud rather than lose the snapshot.
      if (!lastContext?.userId) {
        throw new Error("cannot persist document without a user context");
      }
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
