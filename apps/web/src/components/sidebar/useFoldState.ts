import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { trpc } from "../../trpc.js";
import { storageSet } from "../../storage.js";
import { applyFoldChanges, type FoldChange, type FoldSnapshot, type FoldWrite } from "./folds.js";

/** Fold state: the DB is the durable cross-device copy; localStorage is a
 * synchronous per-user seed cache so the first paint doesn't flash.
 * Collections remember the EXPANDED set (they default collapsed), document
 * folders the COLLAPSED set (they default expanded). */
const EXPANDED_KEY = "tandem.sidebar.expanded";
const COLLAPSED_DOCS_KEY = "tandem.sidebar.collapsedDocs";

/** Read the user's cached id set. Adopts the pre-scoping unscoped key once so
 * existing single-profile browsers keep their state; in a shared browser the
 * first account to load claims it (bounded, one-time). */
function loadIdSet(base: string, userId: string): Set<string> {
  const key = `${base}:${userId}`;
  try {
    let raw = localStorage.getItem(key);
    if (raw === null) {
      raw = localStorage.getItem(base);
      if (raw !== null) {
        localStorage.setItem(key, raw);
        localStorage.removeItem(base);
      }
    }
    const parsed = JSON.parse(raw ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

export interface Folds {
  readonly snapshot: FoldSnapshot;
  /** True once the server copy has been applied (or local state adopted)
   * this mount. */
  readonly foldsReconciled: boolean;
  /** The only way to change folds: idempotent, and persists each real flip. */
  apply(changes: readonly FoldChange[]): void;
}

/** apply() works on the store's latest snapshot rather than a render's
 * closure, so back-to-back calls in one tick (key repeat, Collapse all then
 * Reveal) can't lose an update or write twice. */
function createFoldStore(seed: FoldSnapshot) {
  let snapshot = seed;
  let persist: (w: FoldWrite) => void = () => {};
  const listeners = new Set<() => void>();
  const set = (next: FoldSnapshot) => {
    if (next === snapshot) return;
    snapshot = next;
    for (const l of listeners) l();
  };
  return {
    get: () => snapshot,
    subscribe: (cb: () => void) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    apply: (changes: readonly FoldChange[]) => {
      const { next, writes } = applyFoldChanges(snapshot, changes);
      set(next);
      for (const w of writes) persist(w);
    },
    /** Server state wins wholesale, without writing anything back. */
    replacePersisted: (server: { expandedCollections: string[]; collapsedDocs: string[] }, forceExpand: string | null) => {
      const expandedCollections = new Set(server.expandedCollections);
      if (forceExpand) expandedCollections.add(forceExpand);
      set({ expandedCollections, collapsedDocs: new Set(server.collapsedDocs), openGroups: snapshot.openGroups });
    },
    setPersist: (fn: (w: FoldWrite) => void) => {
      persist = fn;
    },
  };
}

/** Sidebar fold state for collections, document folders and the Archived/Trash
 * groups, seeded from localStorage and reconciled once per mount against the
 * server copy. */
export function useFoldState(uid: string, activeCollectionId: string | null): Folds {
  const [store] = useState(() =>
    createFoldStore({
      expandedCollections: loadIdSet(EXPANDED_KEY, uid),
      collapsedDocs: loadIdSet(COLLAPSED_DOCS_KEY, uid),
      openGroups: new Set(),
    }),
  );
  const snapshot = useSyncExternalStore(store.subscribe, store.get);

  const persistFold = trpc.settings.setSidebarNode.useMutation();
  // Fire-and-forget: local state is authoritative for the session; a lost
  // write only costs fold state on the next device. Calls in one tick share
  // one HTTP request (httpBatchLink).
  store.setPersist((w) => persistFold.mutate(w));

  useEffect(() => {
    storageSet(`${EXPANDED_KEY}:${uid}`, JSON.stringify([...snapshot.expandedCollections]));
  }, [snapshot.expandedCollections, uid]);
  useEffect(() => {
    storageSet(`${COLLAPSED_DOCS_KEY}:${uid}`, JSON.stringify([...snapshot.collapsedDocs]));
  }, [snapshot.collapsedDocs, uid]);

  // Server fold state wins once per mount (it may carry another device's
  // toggles). Empty server + non-empty local = a user from the
  // localStorage-only era: adopt their local state server-side instead.
  // foldsReconciled tells the ancestor-reveal effects to take one fresh pass
  // in case the server snapshot landed after a tree did (query retry) and
  // re-collapsed the open document's ancestors.
  const sidebarState = trpc.settings.sidebar.useQuery(undefined, { staleTime: Infinity });
  const reconciled = useRef(false);
  const [foldsReconciled, setFoldsReconciled] = useState(false);
  useEffect(() => {
    const data = sidebarState.data;
    if (!data || reconciled.current) return;
    reconciled.current = true;
    setFoldsReconciled(true);
    const local = store.get().expandedCollections;
    if (data.expandedCollections.length === 0 && data.collapsedDocs.length === 0 && local.size > 0) {
      for (const id of local) persistFold.mutate({ kind: "collection", id, expanded: true });
      return;
    }
    // Keep the open document's collection visible regardless.
    store.replacePersisted(data, activeCollectionId);
  }, [sidebarState.data]);

  // The open document's collection is always expanded.
  useEffect(() => {
    if (activeCollectionId) store.apply([{ kind: "collection", id: activeCollectionId, expanded: true }]);
  }, [activeCollectionId]);

  return { snapshot, foldsReconciled, apply: store.apply };
}
