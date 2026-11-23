import { IndexeddbPersistence } from "y-indexeddb";
import type * as Y from "yjs";
import { storeName } from "./offline-store.js";

// The y-indexeddb half of offline persistence, imported only by the editor.
// Naming and deleting stores lives in offline-store.ts so the app shell
// (sign-out) can forget documents without loading Yjs.

export { forgetDoc, forgetUserDocs } from "./offline-store.js";

/** null when IndexedDB is unavailable (blocked storage, some private modes). */
export function persistDoc(userId: string, docId: string, ydoc: Y.Doc): IndexeddbPersistence | null {
  try {
    return new IndexeddbPersistence(storeName(userId, docId), ydoc);
  } catch {
    return null;
  }
}
