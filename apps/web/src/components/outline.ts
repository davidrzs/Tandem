import type { RouterOutputs } from "@tandem/server/trpc";
import { sortValue, type Field } from "./properties.js";

/** A `documents.tree` node, narrowed to what the Contents table and the
 * sidebar read. */
export type DocumentNode = Pick<
  RouterOutputs["documents"]["tree"][number],
  "id" | "title" | "position" | "updatedAt" | "typeId" | "properties"
> & {
  children: DocumentNode[];
};

/** A built-in column, or a property column by field id. */
export type SortKey = "name" | "pages" | "updated" | `field:${string}`;
export interface OutlineSort {
  key: SortKey;
  dir: "asc" | "desc";
}

/** What the reader has done to the table. `sort: null` keeps the documents'
 * own position order, the order the sidebar shows. */
export interface OutlineView {
  expanded: ReadonlySet<string>;
  sort: OutlineSort | null;
  filter: string;
}

export interface OutlineRow {
  node: DocumentNode;
  depth: number;
  hasChildren: boolean;
  descendants: number;
  expanded: boolean;
}

/** The one fallback for a document without a title. */
export const displayTitle = (doc: { title: string }) => doc.title || "Untitled";

export function documentCount(nodes: DocumentNode[]): number {
  return nodes.reduce((count, node) => count + 1 + documentCount(node.children), 0);
}

export function findDocument(nodes: DocumentNode[], id: string): DocumentNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findDocument(node.children, id);
    if (found) return found;
  }
  return null;
}

/** Names and properties read A to Z first; counts and dates read largest
 * and newest first. */
const FIRST_DIR: Record<string, OutlineSort["dir"]> = { pages: "desc", updated: "desc" };

/** The sort after clicking a column header: a new column starts in its natural
 * direction, the active column flips. */
export function nextSort(sort: OutlineSort | null, key: SortKey): OutlineSort {
  if (sort?.key === key) return { key, dir: sort.dir === "asc" ? "desc" : "asc" };
  return { key, dir: FIRST_DIR[key] ?? "asc" };
}

interface Stats {
  descendants: number;
  hit: boolean;
  hitBelow: boolean;
}

/** The visible rows of a document tree, depth-first. Sorting reorders each
 * sibling group and never breaks the hierarchy; pages without a value for a
 * sorted property come last either way. A filter keeps titles that contain
 * it (case-insensitively) plus their ancestors, which open to show the
 * matches regardless of `expanded`. `fields` defines the property columns
 * a `field:` sort can name. */
export function outlineRows(
  nodes: DocumentNode[],
  view: OutlineView,
  fields: ReadonlyArray<Pick<Field, "id" | "kind" | "options">> = [],
): OutlineRow[] {
  const query = view.filter.trim().toLowerCase();
  const stats = new Map<DocumentNode, Stats>();
  const measure = (node: DocumentNode): Stats => {
    const s: Stats = {
      descendants: 0,
      hit: query !== "" && displayTitle(node).toLowerCase().includes(query),
      hitBelow: false,
    };
    for (const child of node.children) {
      const c = measure(child);
      s.descendants += 1 + c.descendants;
      s.hitBelow ||= c.hit || c.hitBelow;
    }
    stats.set(node, s);
    return s;
  };
  nodes.forEach(measure);

  const builtin: Record<string, (node: DocumentNode) => string | number | null> = {
    name: displayTitle,
    pages: (node) => stats.get(node)!.descendants,
    updated: (node) => new Date(node.updatedAt).getTime(),
  };
  const order = (list: DocumentNode[]) => {
    const sort = view.sort;
    if (!sort) return list;
    const field = fields.find((f) => `field:${f.id}` === sort.key);
    const value = field
      ? (node: DocumentNode) => sortValue(field, node.properties[field.id])
      : (builtin[sort.key] ?? (() => null));
    const sign = sort.dir === "asc" ? 1 : -1;
    return [...list].sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      if (va === null || vb === null) return va === vb ? 0 : va === null ? 1 : -1;
      const cmp =
        typeof va === "string" || typeof vb === "string"
          ? String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: "base" })
          : va - vb;
      return sign * cmp;
    });
  };

  const rows: OutlineRow[] = [];
  const walk = (list: DocumentNode[], depth: number) => {
    for (const node of order(list)) {
      const s = stats.get(node)!;
      if (query && !s.hit && !s.hitBelow) continue;
      const hasChildren = node.children.length > 0;
      const expanded = query ? s.hitBelow : hasChildren && view.expanded.has(node.id);
      rows.push({ node, depth, hasChildren, descendants: s.descendants, expanded });
      if (expanded) walk(node.children, depth + 1);
    }
  };
  walk(nodes, 0);
  return rows;
}
