import { useEffect, useRef, useState } from "react";
import { trpc } from "../../trpc.js";
import { storageSet } from "../../storage.js";

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

/** Sidebar fold state for collections and document folders, seeded from
 * localStorage and reconciled once per mount against the server copy. */
export function useFoldState(uid: string, activeCollectionId: string | null) {
  const [expanded, setExpanded] = useState<Set<string>>(() => loadIdSet(EXPANDED_KEY, uid));
  const [collapsedDocs, setCollapsedDocs] = useState<Set<string>>(() =>
    loadIdSet(COLLAPSED_DOCS_KEY, uid),
  );

  useEffect(() => {
    storageSet(`${EXPANDED_KEY}:${uid}`, JSON.stringify([...expanded]));
  }, [expanded, uid]);
  useEffect(() => {
    storageSet(`${COLLAPSED_DOCS_KEY}:${uid}`, JSON.stringify([...collapsedDocs]));
  }, [collapsedDocs, uid]);

  const sidebarState = trpc.settings.sidebar.useQuery(undefined, { staleTime: Infinity });
  const persistFold = trpc.settings.setSidebarNode.useMutation();
  // Fire-and-forget: local state is authoritative for the session; a lost
  // write only costs fold state on the next device. Calls in one tick share
  // one HTTP request (httpBatchLink).
  const persistNode = (kind: "collection" | "doc", id: string, isExpanded: boolean) =>
    persistFold.mutate({ kind, id, expanded: isExpanded });

  // Server fold state wins once per mount (it may carry another device's
  // toggles). Empty server + non-empty local = a user from the
  // localStorage-only era: adopt their local state server-side instead.
  // foldsReconciled tells the ancestor-reveal effects to take one fresh pass
  // in case the server snapshot landed after a tree did (query retry) and
  // re-collapsed the open document's ancestors.
  const reconciled = useRef(false);
  const [foldsReconciled, setFoldsReconciled] = useState(false);
  useEffect(() => {
    const data = sidebarState.data;
    if (!data || reconciled.current) return;
    reconciled.current = true;
    setFoldsReconciled(true);
    if (
      data.expandedCollections.length === 0 &&
      data.collapsedDocs.length === 0 &&
      expanded.size > 0
    ) {
      for (const id of expanded) persistNode("collection", id, true);
      return;
    }
    setCollapsedDocs(new Set(data.collapsedDocs));
    setExpanded(() => {
      const next = new Set(data.expandedCollections);
      // Keep the open document's collection visible regardless.
      if (activeCollectionId) next.add(activeCollectionId);
      return next;
    });
  }, [sidebarState.data]);

  // The open document's collection is always expanded.
  useEffect(() => {
    if (!activeCollectionId) return;
    if (!expanded.has(activeCollectionId)) persistNode("collection", activeCollectionId, true);
    setExpanded((prev) =>
      prev.has(activeCollectionId) ? prev : new Set(prev).add(activeCollectionId),
    );
  }, [activeCollectionId]);

  const toggleDoc = (id: string) => {
    const collapsing = !collapsedDocs.has(id);
    setCollapsedDocs((prev) => {
      const next = new Set(prev);
      if (collapsing) next.add(id);
      else next.delete(id);
      return next;
    });
    persistNode("doc", id, !collapsing);
  };

  /** Expand-only: unfold the given document folders (drop targets, ancestors
   * of the open document). Skips ids that are already unfolded. */
  const revealDocs = (ids: string[]) => {
    const toReveal = ids.filter((id) => collapsedDocs.has(id));
    if (toReveal.length === 0) return;
    setCollapsedDocs((prev) => {
      const next = new Set(prev);
      for (const id of toReveal) next.delete(id);
      return next;
    });
    for (const id of toReveal) persistNode("doc", id, true);
  };

  const toggleCollection = (id: string) => {
    const willExpand = !expanded.has(id);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (willExpand) next.add(id);
      else next.delete(id);
      return next;
    });
    persistNode("collection", id, willExpand);
  };

  return { expanded, collapsedDocs, foldsReconciled, toggleCollection, toggleDoc, revealDocs };
}
