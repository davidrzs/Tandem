import { useEffect, useMemo, useSyncExternalStore } from "react";
import { storageGet, storageSet } from "../storage.js";
import { trpc } from "../trpc.js";

/**
 * Recently viewed documents. Only ids and visit times live in this browser
 * (reading a doc leaves no server-side trace); title, workspace and whether
 * the viewer can still open the document come from the server whenever the
 * list is shown, so a rename, the trash or revoked access never leaves a
 * stale entry behind.
 */

interface RecentEntry {
  id: string;
  at: number;
}

const KEY = "tandem.recents";
/** Across all workspaces (callers filter to the active one). Stays under the
 * server's metadata batch limit (INPUT_LIMITS.metaBatch, 50). */
const MAX = 30;

const listeners = new Set<() => void>();
let cache: RecentEntry[] | null = null;

function parse(raw: string | null): RecentEntry[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? "[]");
    if (!Array.isArray(parsed)) return [];
    // Entries written before this format also carried a title and workspace;
    // only the id and visit time are kept.
    return parsed.flatMap((entry: { id?: unknown; at?: unknown }) =>
      typeof entry?.id === "string"
        ? [{ id: entry.id, at: typeof entry.at === "number" ? entry.at : 0 }]
        : [],
    );
  } catch {
    return [];
  }
}

/** Stable between writes, as useSyncExternalStore requires. */
function read(): RecentEntry[] {
  cache ??= parse(storageGet(KEY));
  return cache;
}

function write(next: RecentEntry[]): void {
  cache = next;
  storageSet(KEY, JSON.stringify(next));
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab recorded a visit.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY) return;
    cache = null;
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function recordRecent(id: string): void {
  write([{ id, at: Date.now() }, ...read().filter((r) => r.id !== id)].slice(0, MAX));
}

function forget(ids: Set<string>): void {
  if (ids.size === 0) return;
  write(read().filter((r) => !ids.has(r.id)));
}

/** The viewer's recently viewed documents in `workspaceId`, newest first,
 * with current metadata. Empty until the server has answered. */
export function useRecentDocs(workspaceId: string | null, limit: number) {
  const entries = useSyncExternalStore(subscribe, read);
  const ids = useMemo(() => entries.map((e) => e.id), [entries]);
  const meta = trpc.documents.getMetaMany.useQuery(
    { ids },
    { enabled: ids.length > 0, placeholderData: (prev) => prev },
  );

  // Whatever the server didn't return is gone for this viewer (trashed,
  // archived, deleted, access revoked): drop it, but only from an answer
  // for exactly the current ids, never from placeholder data.
  useEffect(() => {
    if (!meta.data || meta.isPlaceholderData) return;
    const live = new Set(meta.data.map((d) => d.id));
    forget(new Set(ids.filter((id) => !live.has(id))));
  }, [meta.data, meta.isPlaceholderData, ids]);

  return useMemo(() => {
    if (ids.length === 0 || !meta.data) return [];
    const byId = new Map(meta.data.map((d) => [d.id, d]));
    return entries
      .flatMap((e) => {
        const doc = byId.get(e.id);
        return doc && doc.workspaceId === workspaceId ? [doc] : [];
      })
      .slice(0, limit);
  }, [entries, ids.length, meta.data, workspaceId, limit]);
}
