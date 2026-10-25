import { HocuspocusProvider, type HocuspocusProviderConfiguration } from "@hocuspocus/provider";
import { useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { forgetDoc, persistDoc } from "../../offline.js";
import { trpc } from "../../trpc.js";

function collabUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/collab`;
}

type ConnectionState = "connecting" | "live" | "offline";

/** The document's Y.Doc and collab connection: the Hocuspocus provider (with
 * its stateless-ping routing), local IndexedDB persistence for writers, and
 * the unsent-edits guard on tab close. */
export function useCollabDoc(docId: string, uid: string | undefined, canEdit: boolean) {
  const utils = trpc.useUtils();
  const utilsRef = useRef(utils);
  utilsRef.current = utils;

  // Stable Y.Doc + provider for the editor binding (Editor is keyed by docId).
  // Both are created once; the effect below only manages the connection so
  // StrictMode's mount/unmount/mount cycle doesn't destroy the provider the
  // editor extensions hold on to.
  const [ydoc] = useState(() => new Y.Doc());
  const uidRef = useRef(uid);
  uidRef.current = uid;
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [synced, setSynced] = useState(false);
  const [provider] = useState(
    () =>
      new HocuspocusProvider({
        url: collabUrl(),
        name: docId,
        token: "cookie", // real auth is the session cookie on the handshake
        document: ydoc,
        // autoConnect is a (managed) websocket option the provider forwards at
        // runtime; the narrower provider config type just doesn't declare it.
        autoConnect: false,
        onStatus: ({ status }) =>
          setConnection(
            status === "connected" ? "live" : status === "connecting" ? "connecting" : "offline",
          ),
        onSynced: () => setSynced(true),
        // Refused (access revoked, document gone): drop any local copy.
        onAuthenticationFailed: () => {
          if (uidRef.current) forgetDoc(uidRef.current, docId);
        },
        // Server pushes data-free pings on the doc's channel (e.g. someone
        // commented); refetch through our own RLS-scoped queries.
        onStateless: ({ payload }: { payload: string }) => {
          try {
            const message = JSON.parse(payload) as { topic?: string };
            if (message.topic === "comments") {
              void utilsRef.current.comments.list.invalidate({ documentId: docId });
            } else if (message.topic === "snapshots") {
              void utilsRef.current.documents.listSnapshots.invalidate({ documentId: docId });
            } else if (message.topic === "meta") {
              // Someone renamed the doc (the title lives outside the CRDT).
              void utilsRef.current.documents.getMeta.invalidate({ id: docId });
              void utilsRef.current.documents.tree.invalidate();
            } else if (message.topic === "fields") {
              // A field's kind changed and the server reshaped its value here.
              void utilsRef.current.types.invalidate();
              void utilsRef.current.documents.properties.invalidate({ id: docId });
            }
          } catch {
            // Unknown payloads are ignored.
          }
        },
      } as HocuspocusProviderConfiguration),
  );
  const destroyTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    clearTimeout(destroyTimer.current);
    void provider.connect();
    return () => {
      provider.disconnect();
      // Real unmount destroys the provider (and its managed socket) a tick
      // later; StrictMode's immediate remount cancels this and reconnects.
      destroyTimer.current = setTimeout(() => {
        provider.destroy();
        ydoc.destroy();
      }, 0);
    };
  }, [provider, ydoc]);

  // Mirror the doc to IndexedDB so offline edits survive a reload. Writers
  // only: a reader has nothing to keep, and a cached state from when they
  // could write would just be refused by the server.
  const [persisted, setPersisted] = useState(false);
  useEffect(() => {
    if (!uid || !canEdit) return;
    const local = persistDoc(uid, docId, ydoc);
    if (!local) return;
    setPersisted(true);
    return () => {
      setPersisted(false);
      void local.destroy();
    };
  }, [uid, canEdit, docId, ydoc]);

  // Without a local copy, closing the tab with unsent edits loses them.
  useEffect(() => {
    if (persisted) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (provider.hasUnsyncedChanges) e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [persisted, provider]);

  return { ydoc, provider, connection, synced, persisted };
}
