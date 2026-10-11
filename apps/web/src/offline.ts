import { IndexeddbPersistence } from "y-indexeddb";
import type * as Y from "yjs";

/**
 * Offline persistence for collab documents: each document's Yjs state is
 * mirrored to IndexedDB so edits made without a connection survive a reload
 * and sync when the socket returns. Stores are per user (shared browsers) and
 * dropped on sign-out or when the server refuses the document.
 */

const PREFIX = "tandem-doc";

const storeName = (userId: string, docId: string) => `${PREFIX}:${userId}:${docId}`;

/** null when IndexedDB is unavailable (blocked storage, some private modes). */
export function persistDoc(userId: string, docId: string, ydoc: Y.Doc): IndexeddbPersistence | null {
  try {
    return new IndexeddbPersistence(storeName(userId, docId), ydoc);
  } catch {
    return null;
  }
}

function deleteStore(name: string): void {
  try {
    indexedDB.deleteDatabase(name);
  } catch {
    // Storage unavailable: nothing was stored either.
  }
}

/** Forget one document's local copy (access revoked, document gone). */
export function forgetDoc(userId: string, docId: string): void {
  deleteStore(storeName(userId, docId));
}

/** Forget every document cached for this user (sign-out). */
export async function forgetUserDocs(userId: string): Promise<void> {
  try {
    const dbs = await indexedDB.databases();
    for (const { name } of dbs) {
      if (name?.startsWith(`${PREFIX}:${userId}:`)) deleteStore(name);
    }
  } catch {
    // indexedDB.databases() is missing in old browsers; best effort.
  }
}
