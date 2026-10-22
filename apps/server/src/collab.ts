import {
  type Connection,
  Hocuspocus,
  IncomingMessage,
  isTransactionOrigin,
  MessageType,
} from "@hocuspocus/server";
import { type Database, SYSTEM } from "@tandem/db";
import {
  COLLAB_FIELD,
  getAuthors,
  jsonToMarkdown,
  markdownToJSON,
  propertiesToJSON,
  sanitizeClientAuthorsWrites,
  scanTaskItems,
  seedAttributedDoc,
  stampMissingFromUpdate,
  UNKNOWN_AUTHOR,
} from "@tandem/editor";
import { yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import * as Y from "yjs";
import { DocumentService } from "@tandem/core";
import type { Auth } from "./auth.js";
import { createServices } from "./services.js";

/** How long a per-connection write-permission check is trusted. Bounds both the
 * DB cost of a typing burst and how long a downgraded writer keeps writing. */
const WRITE_CHECK_TTL_MS = 1000;

// y-protocols sync sub-types that carry document changes (step1 only asks).
const SYNC_STEP2 = 1;
const SYNC_UPDATE = 2;

/** Does this raw Hocuspocus message try to change the document? Awareness,
 * stateless and sync-step-1 messages don't and skip the permission check. */
function isDocumentWrite(raw: Uint8Array): boolean {
  try {
    const message = new IncomingMessage(raw);
    message.readVarString(); // document address
    const type = message.readVarUint();
    if (type !== MessageType.Sync && type !== MessageType.SyncReply) return false;
    const syncType = message.readVarUint();
    return syncType === SYNC_STEP2 || syncType === SYNC_UPDATE;
  } catch {
    return false; // malformed: Hocuspocus rejects it on its own
  }
}

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
  const canWrite = (userId: string, documentName: string) =>
    servicesFor(userId).documents.canWrite(documentName);
  // Last write-permission verdict per live connection (weak: dies with it).
  const writeChecks = new WeakMap<Connection, { ok: boolean; at: number }>();

  return new Hocuspocus({
    debounce: opts.debounce ?? 2000,
    // Authenticate the socket via the Better Auth session cookie on the
    // handshake; the resulting userId scopes all persistence for this doc.
    async onAuthenticate({ requestHeaders, documentName, connectionConfig }) {
      const session = await auth.api.getSession({ headers: requestHeaders });
      if (!session) throw new Error("Unauthorized");
      // Read-only collaborators connect read-only (RLS also blocks persistence).
      if (!(await canWrite(session.user.id, documentName))) {
        connectionConfig.readOnly = true;
      }
      return { userId: session.user.id, userName: session.user.name };
    },

    // Access can change while a socket is open (grant revoked, collection made
    // view-only, member removed). Re-check before every document-changing
    // message — cached briefly per connection — and flip the connection's
    // read-only flag, so Hocuspocus itself refuses the update (and tells the
    // client it wasn't saved) instead of broadcasting edits RLS won't persist.
    // A regained grant flips it back.
    async beforeHandleMessage({ connection, context, documentName, update }) {
      if (!context?.userId || !isDocumentWrite(update)) return;
      const cached = writeChecks.get(connection);
      let ok = cached?.ok;
      if (!cached || Date.now() - cached.at > WRITE_CHECK_TTL_MS) {
        ok = await canWrite(context.userId as string, documentName);
        writeChecks.set(connection, { ok, at: Date.now() });
      }
      connection.readOnly = !ok;
    },

    async onLoadDocument({ document, documentName, context }) {
      const doc = await servicesFor(context.userId).documents.get(documentName);
      if (!doc) throw new Error("document not found"); // not yours / doesn't exist

      if (doc.ydocState) {
        Y.applyUpdate(document, doc.ydocState);
        // Snapshot the end-state of the previous editing session (fire-and-
        // forget; never block the load). The service dedupes if unchanged.
        const state = doc.ydocState;
        void servicesFor(context.userId)
          .snapshots.captureBoundary({
            documentId: documentName,
            workspaceId: doc.workspaceId,
            ydocState: state,
            sessions: [...getAuthors(document).values()],
          })
          .catch((e) => console.error("snapshot boundary capture failed", e));
      } else if (doc.contentMd) {
        // Legacy doc from before Yjs persistence: its original authors are
        // unknowable, so the seed is explicitly attributed as such (and can
        // never be claimed by whichever user happens to load it first).
        const seeded = seedAttributedDoc(markdownToJSON(doc.contentMd), UNKNOWN_AUTHOR);
        // Persist the seed (as SYSTEM: a read-only loader can't write) so later
        // loads reuse it instead of minting an unrelated history.
        const canonical = await new DocumentService(db, SYSTEM).adoptInitialState(
          documentName,
          Y.encodeStateAsUpdate(seeded),
        );
        Y.applyUpdate(document, canonical);
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
      // Persisting runs RLS-scoped to a user who can still write. The last
      // editor is the natural choice, but they may have lost access since their
      // (then-authorized) edit — the write gate keeps unauthorized edits out of
      // the doc, so any current writer can persist its state. Fail loud only
      // when nobody connected can: the RLS UPDATE would match no rows.
      const candidates = [lastContext, ...document.getConnections().map((c) => c.context)];
      let storeContext: { userId: string; userName?: string } | null = null;
      for (const ctx of candidates) {
        if (!ctx?.userId) continue;
        if (await canWrite(ctx.userId as string, documentName)) {
          storeContext = ctx;
          break;
        }
      }
      if (!storeContext) {
        throw new Error("cannot persist document without a user context that can write");
      }
      const json = yXmlFragmentToProsemirrorJSON(
        document.getXmlFragment(COLLAB_FIELD),
      );
      const state = Y.encodeStateAsUpdate(document);
      const services = servicesFor(storeContext.userId);
      const contentMd = jsonToMarkdown(json);
      const saved = await services.documents.saveCollabSnapshot(documentName, {
        ydocState: state,
        contentJson: json,
        contentMd,
        properties: propertiesToJSON(document),
      });
      // Long-session version capture (fire-and-forget; deduped + rate-limited).
      if (saved) {
        void services.snapshots
          .captureInterval({
            documentId: documentName,
            workspaceId: saved.workspaceId,
            ydocState: state,
            sessions: [...getAuthors(document).values()],
          })
          .catch((e) => console.error("snapshot interval capture failed", e));
        // Newly-written `- [ ] @handle` tasks land in the assignee's inbox.
        void services.notifications
          .onDocumentStored({
            documentId: documentName,
            workspaceId: saved.workspaceId,
            // Baseline = the row this very write replaced (read under its
            // row lock), so racing stores can't diff against the same state.
            documentTitle: saved.title,
            oldMarkdown: saved.previousMd,
            newMarkdown: contentMd,
            actor: {
              // The task's writer is whoever edited last, even when another
              // writer's context persisted the state.
              userId: (lastContext?.userId as string) ?? storeContext.userId,
              name: ((lastContext?.userId ? lastContext.userName : storeContext.userName) as string) ?? "",
              ai: false,
            },
            scan: scanTaskItems,
          })
          .catch((e) => console.error("task notification failed", e));
      }
    },
  });
}
