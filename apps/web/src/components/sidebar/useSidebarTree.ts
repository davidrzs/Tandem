/**
 * The sidebar tree. `<SidebarTree>` renders the Collections section: toolbar,
 * tree and drag-and-drop, as one headless-tree instance over a synthetic root.
 *
 * - Adding a row kind: add a variant to `SidebarNode` (sidebarIndex.ts), emit
 *   it in `buildSidebarIndex`, and add a case to `TreeRow`. The exhaustive
 *   switches make the compiler list every place you missed.
 * - Adding a row action: add a verb to `useSidebarActions` and a menu item in
 *   the row. Rows never import trpc.
 * - Changing what can be dropped where: edit `planDrop` (drop.ts). The
 *   library's canDrop and onDrop both ask it.
 * - Fold state: every expand or collapse goes through `folds.apply`. The
 *   library's expandedItems is derived from it, never stored.
 * - Indent: `INDENT_PX` is the only number; it feeds the library's drop
 *   geometry and the CSS variable `--tree-indent`.
 */
import {
  dragAndDropFeature,
  syncDataLoaderFeature,
  type DragTarget,
  type ItemInstance,
  type TreeInstance,
} from "@headless-tree/core";
import { useTree } from "@headless-tree/react";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { trpc } from "../../trpc.js";
import { canDragNode, planDrop, type DropSlot } from "./drop.js";
import { deriveExpandedItems, diffExpandedItems, revealChanges } from "./folds.js";
import {
  ROOT_ID,
  ancestorPath,
  buildSidebarIndex,
  goneNode,
  groupId,
  isFolderNode,
  nodeLabel,
  type IndexInput,
  type Loaded,
  type SidebarIndex,
  type SidebarNode,
} from "./sidebarIndex.js";
import type { Collection } from "./types.js";
import { useFoldState } from "./useFoldState.js";
import { useSidebarActions, type SidebarActions } from "./useSidebarActions.js";

/** Pixels per tree level. */
export const INDENT_PX = 8;
/** Row padding before level 0; the drag line starts there. */
export const ROW_PAD_PX = 4;

export interface SidebarTreeProps {
  uid: string;
  collections: Collection[];
  activeDocId: string | null;
  activeCollectionId: string | null;
  onShareCollection: (id: string) => void;
  onError: (msg: string) => void;
  setDialog: (node: ReactNode) => void;
}

export interface SidebarTreeModel {
  tree: TreeInstance<SidebarNode>;
  index: SidebarIndex;
  actions: SidebarActions;
  activeDocId: string | null;
  canRevealActive: boolean;
  /** Collapses every expanded collection and every open folder or group
   * inside them, persisted in one batched round of writes. */
  collapseAll(): void;
  /** Expands the active doc's collection and ancestors (or its Archived/Trash
   * group), makes its row the tab stop and scrolls it into view. */
  revealActive(): Promise<void>;
}

export const SidebarTreeContext = createContext<SidebarTreeModel | null>(null);

export function useSidebarTreeContext(): SidebarTreeModel {
  const model = useContext(SidebarTreeContext);
  if (!model) throw new Error("tree rows render inside <SidebarTree>");
  return model;
}

/** Module-level so react-query keeps the combined result referentially stable
 * until a query actually changes. */
function loadedList<T>(results: readonly { status: Loaded<T>["status"]; data: T | undefined }[]): Loaded<T>[] {
  return results.map(({ status, data }) => ({ status, data }));
}

const byCollection = <T>(collections: readonly Collection[], loaded: readonly Loaded<T>[]) =>
  new Map(collections.flatMap((c, i) => (loaded[i] ? [[c.id, loaded[i]] as const] : [])));

/** headless-tree's DragTarget at the library boundary: ordered targets carry
 * an insertion index that already discounts the dragged item. */
function toDropSlot(target: DragTarget<SidebarNode>): DropSlot {
  return "insertionIndex" in target
    ? { kind: "between", parentId: target.item.getId(), index: target.insertionIndex }
    : { kind: "into", targetId: target.item.getId() };
}

export function useSidebarTree(p: SidebarTreeProps): SidebarTreeModel {
  const utils = trpc.useUtils();
  const folds = useFoldState(p.uid, p.activeCollectionId);
  const actions = useSidebarActions({
    folds,
    onError: p.onError,
    setDialog: p.setDialog,
    onShareCollection: p.onShareCollection,
  });

  // Same query keys as before, so every existing invalidate() keeps working.
  const expanded = p.collections.filter((c) => folds.snapshot.expandedCollections.has(c.id));
  // Trash is for writers: readers could neither restore nor purge.
  const writable = expanded.filter((c) => c.writable);
  const trees = trpc.useQueries((t) => expanded.map((c) => t.documents.tree({ collectionId: c.id })), {
    combine: loadedList,
  });
  const archived = trpc.useQueries((t) => expanded.map((c) => t.documents.listArchived({ collectionId: c.id })), {
    combine: loadedList,
  });
  const trash = trpc.useQueries((t) => writable.map((c) => t.documents.listTrash({ collectionId: c.id })), {
    combine: loadedList,
  });

  const input = useMemo<IndexInput>(
    () => ({
      collections: p.collections,
      trees: byCollection(expanded, trees),
      archived: byCollection(expanded, archived),
      trash: byCollection(writable, trash),
    }),
    [p.collections, folds.snapshot.expandedCollections, trees, archived, trash],
  );
  const index = useMemo(() => buildSidebarIndex(input), [input]);
  // A new array whenever data or folds change: headless-tree rebuilds its
  // flat item list synchronously when expandedItems changes by reference, so
  // a deleted doc is never rendered from a stale list.
  const expandedItems = useMemo(() => deriveExpandedItems(index, folds.snapshot), [index, folds.snapshot]);
  const indexRef = useRef(index);
  indexRef.current = index;

  // A focused id that vanished would leave the tree without a tab stop.
  const [focusRaw, setFocusRaw] = useState<string | null>(null);
  const focusedItem = focusRaw && index.nodes.has(focusRaw) ? focusRaw : null;

  const tree = useTree<SidebarNode>({
    rootItemId: ROOT_ID,
    dataLoader: {
      getItem: (id) => indexRef.current.nodes.get(id) ?? goneNode(id),
      getChildren: (id) => [...(indexRef.current.nodes.get(id)?.childIds ?? [])],
    },
    getItemName: (item) => nodeLabel(item.getItemData()),
    isItemFolder: (item) => isFolderNode(item.getItemData()),
    state: { expandedItems, focusedItem },
    setExpandedItems: (next) =>
      folds.apply(
        diffExpandedItems(indexRef.current, expandedItems, typeof next === "function" ? next(expandedItems) : next),
      ),
    setFocusedItem: (next) => setFocusRaw(typeof next === "function" ? next(focusedItem) : next),
    indent: INDENT_PX,
    reorderAreaPercentage: 0.25,
    canDrag: (items) => items.length === 1 && canDragNode(items[0]!.getItemData()),
    canDrop: (items, target) => planDrop(indexRef.current, items[0]!.getId(), toDropSlot(target)) !== null,
    onDrop: (items, target) => {
      const plan = planDrop(indexRef.current, items[0]!.getId(), toDropSlot(target));
      if (plan) void actions.move(plan);
    },
    // Firefox only starts a drag from a non-link element when dragstart sets
    // data; nothing reads this payload.
    createForeignDragObject: (items) => ({
      format: "application/x-tandem-node",
      data: items[0]!.getId(),
      effectAllowed: "move",
    }),
    features: [syncDataLoaderFeature, dragAndDropFeature],
  });

  // Unfold the open document's ancestors once per doc; the user can still
  // re-collapse them afterwards. The marker includes foldsReconciled so a
  // server snapshot that lands after the tree did (query retry) gets one
  // fresh pass; otherwise a cross-device collapse could hide the document
  // being read, permanently.
  const revealedFor = useRef<string | null>(null);
  const activeTree = p.activeCollectionId ? input.trees.get(p.activeCollectionId)?.data : undefined;
  useEffect(() => {
    if (!p.activeDocId || !activeTree) return;
    const marker = `${p.activeDocId}:${folds.foldsReconciled}`;
    if (revealedFor.current === marker) return;
    const path = ancestorPath(activeTree, p.activeDocId);
    if (!path) return;
    revealedFor.current = marker;
    folds.apply(revealChanges(path));
  }, [p.activeDocId, activeTree, folds.foldsReconciled]);

  const revealActive = async () => {
    const { activeDocId: docId, activeCollectionId: cid } = p;
    const collection = cid ? index.nodes.get(cid) : undefined;
    if (!docId || !cid || collection?.kind !== "collection") return;
    folds.apply([{ kind: "collection", id: cid, expanded: true }]);
    // ensureData shares the in-flight request with the tree's own query.
    const path = ancestorPath(await utils.documents.tree.ensureData({ collectionId: cid }), docId);
    if (path) {
      folds.apply(revealChanges(path));
    } else {
      // Not in the live tree: an archived or trashed doc opened directly.
      const archived = await utils.documents.listArchived.ensureData({ collectionId: cid });
      const trashed =
        collection.collection.writable && !archived.some((d) => d.id === docId)
          ? await utils.documents.listTrash.ensureData({ collectionId: cid })
          : [];
      const group = archived.some((d) => d.id === docId)
        ? groupId("archived", cid)
        : trashed.some((d) => d.id === docId)
          ? groupId("trash", cid)
          : null;
      if (!group) return;
      folds.apply([{ kind: "group", id: group, expanded: true }]);
    }
    setFocusRaw(docId);
    (await waitForRowElement(tree, docId))?.scrollIntoView({ block: "nearest" });
  };

  return {
    tree,
    index,
    actions,
    activeDocId: p.activeDocId,
    canRevealActive: !!p.activeDocId && !!p.activeCollectionId && index.nodes.has(p.activeCollectionId),
    collapseAll: () => folds.apply(diffExpandedItems(index, expandedItems, [])),
    revealActive,
  };
}

/** Polls frames (about a second) until the library has registered the row's
 * element. The library's own item.scrollTo() can't be used: its poll treats
 * an unregistered (undefined) element as found and scrolls nothing. */
async function waitForRowElement(tree: TreeInstance<SidebarNode>, id: string): Promise<HTMLElement | null> {
  for (let frame = 0; frame < 60; frame++) {
    const el = tree.getItemInstance(id).getElement();
    if (el) return el;
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  return null;
}

/** Folds through the library so focus and state stay coherent; the change
 * comes back through setExpandedItems. */
export function toggle(item: ItemInstance<SidebarNode>): void {
  item.setFocused();
  if (item.isExpanded()) item.collapse();
  else item.expand();
}

/** The library's row props minus its click-to-toggle: doc rows navigate, and
 * collections and groups toggle through their own button. */
export function treeRowProps(item: ItemInstance<SidebarNode>, draggable: boolean) {
  const { onClick: _toggles, ...props } = item.getProps();
  return {
    ...props,
    draggable,
    onClick: () => item.setFocused(),
    style: { "--level": item.getItemMeta().level } as CSSProperties,
  };
}
