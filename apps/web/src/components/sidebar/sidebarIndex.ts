import type { Collection, DocNode } from "./types.js";

export const ROOT_ID = "tandem:sidebar-root";
/** Collection and document uuids, plus synthetic ids for the root and groups. */
export type NodeId = string;
export type GroupKind = "archived" | "trash";
export type GroupId = `${GroupKind}:${string}`;
/** idle = the collection is collapsed, so its tree isn't queried. */
export type LoadState = "idle" | "loading" | "error" | "ready";

/** Every row the tree can show, keyed by its headless-tree item id. */
export type SidebarNode =
  | { kind: "root"; id: typeof ROOT_ID; childIds: readonly NodeId[] }
  | {
      kind: "collection";
      id: string;
      collection: Collection;
      load: LoadState;
      childIds: readonly NodeId[];
    }
  | {
      kind: "doc";
      id: string;
      collectionId: string;
      parentDocumentId: string | null;
      title: string;
      position: number;
      writable: boolean;
      childIds: readonly NodeId[];
    }
  | { kind: "group"; id: GroupId; group: GroupKind; collectionId: string; childIds: readonly NodeId[] }
  | { kind: "archived"; id: string; collectionId: string; title: string; writable: boolean; childIds: readonly [] }
  | { kind: "trash"; id: string; collectionId: string; title: string; childIds: readonly [] }
  /** Stands in for an id headless-tree still holds after the data dropped it
   * (an in-flight drag); never rendered. */
  | { kind: "gone"; id: NodeId; childIds: readonly [] };

export interface SidebarIndex {
  readonly nodes: ReadonlyMap<NodeId, SidebarNode>;
}

/** The slice of a react-query result the index needs. */
export interface Loaded<T> {
  status: "pending" | "error" | "success";
  data: T | undefined;
}
export interface ArchivedDoc {
  id: string;
  title: string;
}

export interface IndexInput {
  /** Already filtered to the workspace, in server order. */
  collections: readonly Collection[];
  /** Only expanded collections have entries. */
  trees: ReadonlyMap<string, Loaded<DocNode[]>>;
  archived: ReadonlyMap<string, Loaded<ArchivedDoc[]>>;
  /** Writers only. */
  trash: ReadonlyMap<string, Loaded<ArchivedDoc[]>>;
}

export const groupId = (group: GroupKind, collectionId: string): GroupId =>
  `${group}:${collectionId}`;

/** The only constructor of SidebarIndex. Always returns a new object: the tree
 * hook derives expandedItems from it, and a new array is what makes
 * headless-tree rebuild its flat item list in the same render. */
export function buildSidebarIndex(input: IndexInput): SidebarIndex {
  const nodes = new Map<NodeId, SidebarNode>();
  nodes.set(ROOT_ID, { kind: "root", id: ROOT_ID, childIds: input.collections.map((c) => c.id) });

  for (const c of input.collections) {
    const tree = input.trees.get(c.id);
    const addDocs = (docs: readonly DocNode[], parentDocumentId: string | null): NodeId[] => {
      const ids: NodeId[] = [];
      for (const d of docs) {
        // A server race can list a doc twice; keeping the first keeps a tree.
        if (nodes.has(d.id)) continue;
        const childIds: NodeId[] = [];
        nodes.set(d.id, {
          kind: "doc",
          id: d.id,
          collectionId: c.id,
          parentDocumentId,
          title: d.title,
          position: d.position,
          writable: c.writable,
          childIds,
        });
        childIds.push(...addDocs(d.children, d.id));
        ids.push(d.id);
      }
      return ids;
    };
    const childIds = addDocs(tree?.data ?? [], null);

    const archived = input.archived.get(c.id)?.data ?? [];
    if (archived.length > 0) {
      const id = groupId("archived", c.id);
      nodes.set(id, {
        kind: "group",
        id,
        group: "archived",
        collectionId: c.id,
        childIds: archived.map((d) => d.id),
      });
      for (const d of archived) {
        nodes.set(d.id, { kind: "archived", id: d.id, collectionId: c.id, title: d.title, writable: c.writable, childIds: [] });
      }
      childIds.push(id);
    }

    const trash = input.trash.get(c.id)?.data ?? [];
    if (trash.length > 0) {
      const id = groupId("trash", c.id);
      nodes.set(id, { kind: "group", id, group: "trash", collectionId: c.id, childIds: trash.map((d) => d.id) });
      for (const d of trash) {
        nodes.set(d.id, { kind: "trash", id: d.id, collectionId: c.id, title: d.title, childIds: [] });
      }
      childIds.push(id);
    }

    const load: LoadState = !tree
      ? "idle"
      : tree.status === "pending"
        ? "loading"
        : tree.status === "error"
          ? "error"
          : "ready";
    nodes.set(c.id, { kind: "collection", id: c.id, collection: c, load, childIds });
  }
  return { nodes };
}

/** Parent chain (outermost first) leading to docId, excluding docId itself;
 * null when the doc isn't in this tree. */
export function ancestorPath(nodes: readonly DocNode[], docId: string): string[] | null {
  for (const node of nodes) {
    if (node.id === docId) return [];
    const inChild = ancestorPath(node.children, docId);
    if (inChild) return [node.id, ...inChild];
  }
  return null;
}

/** Accessible name, also headless-tree's item name. */
export function nodeLabel(node: SidebarNode): string {
  switch (node.kind) {
    case "collection":
      return node.collection.name;
    case "doc":
    case "archived":
    case "trash":
      return node.title || "Untitled";
    case "group":
      return `${node.group === "archived" ? "Archived" : "Trash"} (${node.childIds.length})`;
    case "root":
    case "gone":
      return "";
  }
}

/** Collections, groups and the root always fold; docs only with children. */
export function isFolderNode(node: SidebarNode): boolean {
  switch (node.kind) {
    case "root":
    case "collection":
    case "group":
      return true;
    case "doc":
      return node.childIds.length > 0;
    case "archived":
    case "trash":
    case "gone":
      return false;
  }
}

export const goneNode = (id: NodeId): SidebarNode => ({ kind: "gone", id, childIds: [] });
