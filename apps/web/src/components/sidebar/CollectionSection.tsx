import { useEffect, useRef, useState } from "react";
import { trpc } from "../../trpc.js";
import { Icon } from "../Icon.js";
import { RowMenu } from "../Modal.js";
import { OverflowTooltip } from "../OverflowTooltip.js";
import { ArchivedRow, DocTree, TrashRow } from "./DocTree.js";
import { revealChanges } from "./folds.js";
import { ancestorPath, groupId } from "./sidebarIndex.js";
import type { Collection } from "./types.js";
import type { Folds } from "./useFoldState.js";
import type { SidebarActions } from "./useSidebarActions.js";

/** Drag payload type for collection rows (documents use their own). */
const COLLECTION_MIME = "application/x-tandem-collection";
export function CollectionSection({
  collection,
  siblings,
  index,
  expanded,
  activeDocId,
  folds,
  actions,
}: {
  collection: Collection;
  siblings: Collection[];
  index: number;
  expanded: boolean;
  activeDocId: string | null;
  folds: Folds;
  actions: SidebarActions;
}) {
  const tree = trpc.documents.tree.useQuery(
    { collectionId: collection.id },
    { enabled: expanded },
  );
  const archived = trpc.documents.listArchived.useQuery(
    { collectionId: collection.id },
    { enabled: expanded },
  );
  // Trash is for writers: readers could neither restore nor purge.
  const trash = trpc.documents.listTrash.useQuery(
    { collectionId: collection.id },
    { enabled: expanded && collection.writable },
  );
  const archivedGroup = groupId("archived", collection.id);
  const trashGroup = groupId("trash", collection.id);
  const showArchived = folds.snapshot.openGroups.has(archivedGroup);
  const showTrash = folds.snapshot.openGroups.has(trashGroup);
  const [dropMode, setDropMode] = useState<"before" | "after" | null>(null);

  // Unfold the open document's ancestors once per doc; the user can still
  // re-collapse them afterwards (same UX as the collection force-expand).
  // The marker includes foldsReconciled so a server snapshot that lands after
  // this tree did (query retry) gets one fresh reveal pass — otherwise a
  // cross-device collapse could hide the document being read, permanently.
  const revealedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!activeDocId || !tree.data) return;
    const marker = `${activeDocId}:${folds.foldsReconciled}`;
    if (revealedFor.current === marker) return;
    const path = ancestorPath(tree.data, activeDocId);
    if (!path) return;
    revealedFor.current = marker;
    folds.apply(revealChanges(path));
  }, [activeDocId, tree.data, folds.foldsReconciled]);

  // Where a dropped sibling lands: midway between this collection and its
  // neighbour (same sparse-position scheme as document rows).
  const positionFor = (mode: "before" | "after"): number => {
    if (mode === "before") {
      const prev = siblings[index - 1];
      return prev ? (prev.position + collection.position) / 2 : collection.position - 1;
    }
    const next = siblings[index + 1];
    return next ? (collection.position + next.position) / 2 : collection.position + 1;
  };

  const onDropCollection = (e: React.DragEvent) => {
    e.preventDefault();
    const payload = e.dataTransfer.getData(COLLECTION_MIME);
    const mode = dropMode;
    setDropMode(null);
    if (!payload || !mode) return;
    const dragged = JSON.parse(payload) as { id: string };
    if (dragged.id === collection.id) return;
    void actions.move({ kind: "collection", id: dragged.id, position: positionFor(mode) });
  };

  const menuItems = [
    ...(collection.writable
      ? [
          { label: "New document", icon: "plus" as const, onClick: () => void actions.newDoc(collection.id) },
          { label: "Rename", icon: "pen" as const, onClick: () => actions.renameCollection(collection) },
        ]
      : []),
    { label: "Share & access", icon: "share" as const, onClick: () => actions.shareCollection(collection) },
    { label: "Export", icon: "download" as const, onClick: () => actions.exportCollection(collection) },
    {
      label: "Delete collection",
      icon: "trash" as const,
      danger: true,
      onClick: () => actions.deleteCollection(collection),
    },
  ];

  return (
    <div className="collection">
      <div
        className={
          "collection-row tree-row" +
          (expanded ? " open" : "") +
          (dropMode ? ` drop-${dropMode}` : "")
        }
        draggable={collection.writable}
        onDragStart={(e) => {
          e.dataTransfer.setData(COLLECTION_MIME, JSON.stringify({ id: collection.id }));
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(COLLECTION_MIME)) return;
          e.preventDefault();
          const rect = e.currentTarget.getBoundingClientRect();
          setDropMode(e.clientY - rect.top < rect.height / 2 ? "before" : "after");
        }}
        onDragLeave={() => setDropMode(null)}
        onDrop={onDropCollection}
      >
        <button
          type="button"
          className="collection-name"
          onClick={() => folds.apply([{ kind: "collection", id: collection.id, expanded: !expanded }])}
        >
          <Icon name="chevron" className={"twist" + (expanded ? " open" : "")} />
          <OverflowTooltip text={collection.name}>
            <span className="collection-label">{collection.name}</span>
          </OverflowTooltip>
        </button>
        <span className="row-actions">
          {collection.writable && (
            <button type="button" className="row-action" title="New document" aria-label="New document" onClick={() => void actions.newDoc(collection.id)}>
              <Icon name="plus" />
            </button>
          )}
          <RowMenu items={menuItems} />
        </span>
      </div>
      {expanded && (
        <>
          {tree.error && (
            <div className="side-note">
              Couldn't load documents.{" "}
              <button type="button" className="side-link" onClick={() => void tree.refetch()}>
                Retry
              </button>
            </div>
          )}
          {tree.isLoading && <div className="side-note">Loading…</div>}
          {!tree.isLoading && !tree.error && (tree.data?.length ?? 0) === 0 && (
            <div className="side-note">No documents yet.</div>
          )}
          <div className="doc-branch">
            <DocTree
              nodes={tree.data ?? []}
              parentId={null}
              collectionId={collection.id}
              writable={collection.writable}
              activeDocId={activeDocId}
              depth={0}
              folds={folds}
              actions={actions}
            />
          </div>
          {(archived.data?.length ?? 0) > 0 && (
            <>
              <button type="button"
                className="archived-toggle"
                onClick={() => folds.apply([{ kind: "group", id: archivedGroup, expanded: !showArchived }])}
              >
                <Icon name="chevron" className={"twist" + (showArchived ? " open" : "")} />
                Archived ({archived.data!.length})
              </button>
              {showArchived &&
                archived.data!.map((d) => (
                  <ArchivedRow
                    key={d.id}
                    doc={{ ...d, collectionId: collection.id }}
                    writable={collection.writable}
                    actions={actions}
                  />
                ))}
            </>
          )}
          {(trash.data?.length ?? 0) > 0 && (
            <>
              <button type="button"
                className="archived-toggle"
                onClick={() => folds.apply([{ kind: "group", id: trashGroup, expanded: !showTrash }])}
              >
                <Icon name="chevron" className={"twist" + (showTrash ? " open" : "")} />
                Trash ({trash.data!.length})
              </button>
              {showTrash &&
                trash.data!.map((d) => (
                  <TrashRow key={d.id} doc={{ ...d, collectionId: collection.id }} actions={actions} />
                ))}
            </>
          )}
        </>
      )}
    </div>
  );
}
