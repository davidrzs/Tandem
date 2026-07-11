/** Recently-viewed documents, stored locally (reading a doc should leave no
 * server-side trace). Titles are refreshed on each visit. */

export interface RecentDoc {
  id: string;
  title: string;
  workspaceId: string;
  at: number;
}

const KEY = "tandem.recents";
const MAX = 12;

export function recordRecent(doc: { id: string; title: string; workspaceId: string }): void {
  try {
    const next: RecentDoc[] = [
      { id: doc.id, title: doc.title, workspaceId: doc.workspaceId, at: Date.now() },
      ...listRecents().filter((r) => r.id !== doc.id),
    ].slice(0, MAX);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage may be unavailable (private mode); recents are best-effort.
  }
}

export function listRecents(): RecentDoc[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]") as RecentDoc[];
  } catch {
    return [];
  }
}
