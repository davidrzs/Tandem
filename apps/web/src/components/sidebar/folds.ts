import { ROOT_ID, type GroupId, type SidebarIndex } from "./sidebarIndex.js";

/** Collections default to collapsed and docs to expanded, so each persists
 * only its exceptions. Groups (Archived/Trash) are session-only. */
export interface FoldSnapshot {
  readonly expandedCollections: ReadonlySet<string>;
  readonly collapsedDocs: ReadonlySet<string>;
  readonly openGroups: ReadonlySet<GroupId>;
}

export type FoldChange =
  | { kind: "collection"; id: string; expanded: boolean }
  | { kind: "doc"; id: string; expanded: boolean }
  | { kind: "group"; id: GroupId; expanded: boolean };

/** Exactly the `settings.setSidebarNode` input; groups never produce one. */
export interface FoldWrite {
  kind: "collection" | "doc";
  id: string;
  expanded: boolean;
}

/** Returns the same snapshot object when nothing changed (so React bails out)
 * and one write per persisted bit that ends up different. Changes to one id
 * within a batch coalesce to the last, so a batch never sends two writes for
 * one row (batched requests aren't guaranteed to run in order). */
export function applyFoldChanges(
  s: FoldSnapshot,
  changes: readonly FoldChange[],
): { next: FoldSnapshot; writes: FoldWrite[] } {
  const last = new Map<string, FoldChange>();
  for (const c of changes) last.set(`${c.kind}:${c.id}`, c);

  let expandedCollections: Set<string> | null = null;
  let collapsedDocs: Set<string> | null = null;
  let openGroups: Set<GroupId> | null = null;
  const writes: FoldWrite[] = [];
  for (const c of last.values()) {
    switch (c.kind) {
      case "collection":
        if (s.expandedCollections.has(c.id) === c.expanded) break;
        expandedCollections ??= new Set(s.expandedCollections);
        if (c.expanded) expandedCollections.add(c.id);
        else expandedCollections.delete(c.id);
        writes.push(c);
        break;
      case "doc":
        if (s.collapsedDocs.has(c.id) !== c.expanded) break;
        collapsedDocs ??= new Set(s.collapsedDocs);
        if (c.expanded) collapsedDocs.delete(c.id);
        else collapsedDocs.add(c.id);
        writes.push(c);
        break;
      case "group":
        if (s.openGroups.has(c.id) === c.expanded) break;
        openGroups ??= new Set(s.openGroups);
        if (c.expanded) openGroups.add(c.id);
        else openGroups.delete(c.id);
        break;
    }
  }

  if (!expandedCollections && !collapsedDocs && !openGroups) return { next: s, writes };
  return {
    next: {
      expandedCollections: expandedCollections ?? s.expandedCollections,
      collapsedDocs: collapsedDocs ?? s.collapsedDocs,
      openGroups: openGroups ?? s.openGroups,
    },
    writes,
  };
}

/** headless-tree's `expandedItems`: expanded collections, plus every
 * uncollapsed doc folder and open group inside them, hidden ones included so
 * Collapse all reaches them. Always a fresh array: a new reference is what
 * makes headless-tree rebuild its item list. */
export function deriveExpandedItems(index: SidebarIndex, s: FoldSnapshot): string[] {
  const out: string[] = [];
  const visit = (ids: readonly string[]) => {
    for (const id of ids) {
      const node = index.nodes.get(id);
      if (!node) continue;
      if (node.kind === "doc" && node.childIds.length > 0) {
        if (!s.collapsedDocs.has(id)) out.push(id);
        visit(node.childIds);
      } else if (node.kind === "group" && s.openGroups.has(node.id)) {
        out.push(id);
      }
    }
  };
  for (const id of index.nodes.get(ROOT_ID)?.childIds ?? []) {
    const node = index.nodes.get(id);
    if (node?.kind !== "collection" || !s.expandedCollections.has(id)) continue;
    out.push(id);
    visit(node.childIds);
  }
  return out;
}

/** Translates headless-tree's next `expandedItems` into fold changes. Ids that
 * can't fold in `index` (the root, leaves, vanished ids) are ignored. */
export function diffExpandedItems(
  index: SidebarIndex,
  prev: readonly string[],
  next: readonly string[],
): FoldChange[] {
  const before = new Set(prev);
  const after = new Set(next);
  const changes: FoldChange[] = [];
  const add = (id: string, expanded: boolean) => {
    const node = index.nodes.get(id);
    if (node?.kind === "collection") changes.push({ kind: "collection", id, expanded });
    else if (node?.kind === "doc" && node.childIds.length > 0) changes.push({ kind: "doc", id, expanded });
    else if (node?.kind === "group") changes.push({ kind: "group", id: node.id, expanded });
  };
  for (const id of after) if (!before.has(id)) add(id, true);
  for (const id of before) if (!after.has(id)) add(id, false);
  return changes;
}

export const revealChanges = (docIds: readonly string[]): FoldChange[] =>
  docIds.map((id) => ({ kind: "doc", id, expanded: true }));
