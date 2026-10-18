import { ROOT_ID, type NodeId, type SidebarIndex, type SidebarNode } from "./sidebarIndex.js";

/** A library-neutral drop position. `index` counts the parent's children with
 * the dragged node removed. */
export type DropSlot =
  | { kind: "into"; targetId: NodeId }
  | { kind: "between"; parentId: NodeId; index: number };

export type MovePlan =
  | {
      kind: "doc";
      id: string;
      collectionId: string;
      title: string;
      /** No position: the server appends. */
      to: { parentDocumentId: string | null; position?: number };
      /** Where Undo puts it back. */
      from: { parentDocumentId: string | null; position: number };
      /** A doc folder to unfold so the drop stays visible. */
      reveal: string | null;
    }
  | { kind: "collection"; id: string; position: number };

type DocNode = Extract<SidebarNode, { kind: "doc" }>;
type CollectionNode = Extract<SidebarNode, { kind: "collection" }>;

/** Sparse float positions: the midpoint between neighbours, or one past the
 * only neighbour. undefined = no neighbours, so the server appends. */
export function positionBetween(prev: number | undefined, next: number | undefined): number | undefined {
  if (prev !== undefined && next !== undefined) return (prev + next) / 2;
  if (prev !== undefined) return prev + 1;
  if (next !== undefined) return next - 1;
  return undefined;
}

export function canDragNode(node: SidebarNode): boolean {
  if (node.kind === "doc") return node.writable;
  if (node.kind === "collection") return node.collection.writable;
  return false;
}

/**
 * The one drop rulebook: the tree's canDrop asks whether this returns a plan,
 * and onDrop executes the plan it returns.
 *
 * A doc moves within its own collection (the server refuses other parents):
 * into its collection or a doc there (appended), or between docs there, never
 * below the Archived/Trash rows. A collection moves between collections.
 * "Into the dragged node's parent" must stay legal even when it changes
 * nothing: headless-tree asks it before allowing any sibling slot.
 */
export function planDrop(index: SidebarIndex, draggedId: NodeId, slot: DropSlot): MovePlan | null {
  const dragged = index.nodes.get(draggedId);
  if (dragged?.kind === "doc") return dragged.writable ? planDocDrop(index, dragged, slot) : null;
  if (dragged?.kind === "collection" && dragged.collection.writable) {
    return planCollectionDrop(index, dragged, slot);
  }
  return null;
}

function planDocDrop(index: SidebarIndex, d: DocNode, slot: DropSlot): MovePlan | null {
  const plan = (to: { parentDocumentId: string | null; position?: number }, reveal: string | null): MovePlan => ({
    kind: "doc",
    id: d.id,
    collectionId: d.collectionId,
    title: d.title,
    to,
    from: { parentDocumentId: d.parentDocumentId, position: d.position },
    reveal,
  });

  if (slot.kind === "into") {
    const target = index.nodes.get(slot.targetId);
    if (target?.kind === "collection") {
      return target.id === d.collectionId ? plan({ parentDocumentId: null }, null) : null;
    }
    if (target?.kind === "doc" && target.collectionId === d.collectionId && !isSelfOrDescendant(index, target, d.id)) {
      return plan({ parentDocumentId: target.id }, target.id);
    }
    return null;
  }

  const parent = index.nodes.get(slot.parentId);
  const inThisCollection =
    (parent?.kind === "collection" && parent.id === d.collectionId) ||
    (parent?.kind === "doc" && parent.collectionId === d.collectionId && !isSelfOrDescendant(index, parent, d.id));
  if (!parent || !inThisCollection) return null;

  const all = parent.childIds.flatMap((id) => {
    const n = index.nodes.get(id);
    return n?.kind === "doc" ? [n] : [];
  });
  const siblings = all.filter((n) => n.id !== d.id);
  if (slot.index < 0 || slot.index > siblings.length) return null;
  const parentDocumentId = parent.kind === "doc" ? parent.id : null;
  if (parentDocumentId === d.parentDocumentId && all.findIndex((n) => n.id === d.id) === slot.index) {
    return null;
  }
  const position = positionBetween(siblings[slot.index - 1]?.position, siblings[slot.index]?.position);
  return plan(position === undefined ? { parentDocumentId } : { parentDocumentId, position }, null);
}

function planCollectionDrop(index: SidebarIndex, k: CollectionNode, slot: DropSlot): MovePlan | null {
  const root = index.nodes.get(ROOT_ID);
  if (root?.kind !== "root") return null;
  const others = root.childIds.flatMap((id) => {
    const n = index.nodes.get(id);
    return n?.kind === "collection" && n.id !== k.id ? [n.collection] : [];
  });

  if (slot.kind === "into") {
    if (slot.targetId !== ROOT_ID) return null;
    const last = others.at(-1);
    return { kind: "collection", id: k.id, position: last ? last.position + 1 : k.collection.position };
  }

  if (slot.parentId !== ROOT_ID || slot.index < 0 || slot.index > others.length) return null;
  if (root.childIds.indexOf(k.id) === slot.index) return null;
  const position = positionBetween(others[slot.index - 1]?.position, others[slot.index]?.position);
  return { kind: "collection", id: k.id, position: position ?? k.collection.position };
}

/** Walks up from `node` through parent docs; true if it meets `draggedId`. */
function isSelfOrDescendant(index: SidebarIndex, node: DocNode, draggedId: string): boolean {
  for (let cur: SidebarNode | undefined = node; cur?.kind === "doc"; ) {
    if (cur.id === draggedId) return true;
    cur = cur.parentDocumentId ? index.nodes.get(cur.parentDocumentId) : undefined;
  }
  return false;
}
