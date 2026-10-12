import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { friendlyError } from "../../errors.js";
import { trpc } from "../../trpc.js";
import { Icon } from "../Icon.js";
import { ConfirmDialog, PromptDialog, RowMenu } from "../Modal.js";
import { ArchivedRow, DocTree, ancestorPath, TrashRow } from "./DocTree.js";
import type { Collection } from "./types.js";

/** Drag payload type for collection rows (documents use their own). */
const COLLECTION_MIME = "application/x-tandem-collection";
export function CollectionSection({
  collection,
  siblings,
  index,
  expanded,
  activeDocId,
  collapsedDocs,
  foldsReconciled,
  onToggle,
  onToggleDoc,
  onRevealDocs,
  onShare,
  onError,
  setDialog,
}: {
  collection: Collection;
  siblings: Collection[];
  index: number;
  expanded: boolean;
  activeDocId: string | null;
  collapsedDocs: Set<string>;
  foldsReconciled: boolean;
  onToggle: () => void;
  onToggleDoc: (id: string) => void;
  onRevealDocs: (ids: string[]) => void;
  onShare: () => void;
  onError: (msg: string) => void;
  setDialog: (node: ReactNode) => void;
}) {
  const utils = trpc.useUtils();
  const navigate = useNavigate();
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
  const createDoc = trpc.documents.create.useMutation();
  const renameCollection = trpc.collections.update.useMutation();
  const deleteCollection = trpc.collections.delete.useMutation();
  const moveCollection = trpc.collections.move.useMutation();
  const [showArchived, setShowArchived] = useState(false);
  const [showTrash, setShowTrash] = useState(false);
  const [dropMode, setDropMode] = useState<"before" | "after" | null>(null);

  // Unfold the open document's ancestors once per doc; the user can still
  // re-collapse them afterwards (same UX as the collection force-expand).
  // The marker includes foldsReconciled so a server snapshot that lands after
  // this tree did (query retry) gets one fresh reveal pass — otherwise a
  // cross-device collapse could hide the document being read, permanently.
  const revealedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!activeDocId || !tree.data) return;
    const marker = `${activeDocId}:${foldsReconciled}`;
    if (revealedFor.current === marker) return;
    const path = ancestorPath(tree.data, activeDocId);
    if (!path) return;
    revealedFor.current = marker;
    if (path.length > 0) onRevealDocs(path);
  }, [activeDocId, tree.data, foldsReconciled]);

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
    void (async () => {
      try {
        await moveCollection.mutateAsync({ id: dragged.id, position: positionFor(mode) });
        await utils.collections.list.invalidate();
      } catch (err) {
        onError(friendlyError(err));
      }
    })();
  };

  const refresh = () =>
    Promise.all([
      utils.documents.tree.invalidate({ collectionId: collection.id }),
      utils.documents.listArchived.invalidate({ collectionId: collection.id }),
      utils.documents.listTrash.invalidate({ collectionId: collection.id }),
      utils.documents.getTrashed.invalidate(),
      // Archive/restore change a document's archivedAt; a stale getMeta would
      // render the doc page without its archived banner (or with a stale one).
      utils.documents.getMeta.invalidate(),
    ]);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await refresh();
    } catch (e) {
      onError(friendlyError(e));
    }
  };

  const newDoc = (parentDocumentId?: string) =>
    run(async () => {
      const doc = await createDoc.mutateAsync({
        collectionId: collection.id,
        title: "",
        ...(parentDocumentId ? { parentDocumentId } : {}),
      });
      if (!expanded) onToggle();
      if (parentDocumentId) onRevealDocs([parentDocumentId]);
      navigate(`/d/${doc.id}`);
    });

  const closeDialog = () => setDialog(null);
  const menuItems = [
    ...(collection.writable
      ? [
          { label: "New document", icon: "plus" as const, onClick: () => void newDoc() },
          {
            label: "Rename",
            icon: "pen" as const,
            onClick: () =>
              setDialog(
                <PromptDialog
                  title="Rename collection"
                  label="Name"
                  submitLabel="Rename"
                  initialValue={collection.name}
                  onClose={closeDialog}
                  onSubmit={(name) =>
                    void run(async () => {
                      await renameCollection.mutateAsync({ id: collection.id, name });
                      await utils.collections.list.invalidate();
                    })
                  }
                />,
              ),
          },
        ]
      : []),
    { label: "Share & access", icon: "share" as const, onClick: onShare },
    {
      label: "Export",
      icon: "download" as const,
      onClick: () => {
        window.location.href = `/api/export?collection=${collection.id}`;
      },
    },
    {
      label: "Delete collection",
      icon: "trash" as const,
      danger: true,
      onClick: () =>
        setDialog(
          <ConfirmDialog
            title="Delete collection"
            body={`"${collection.name}" and every document in it will be deleted. Only a workspace owner or admin can do this.`}
            confirmLabel="Delete collection"
            onClose={closeDialog}
            onConfirm={() =>
              void run(async () => {
                await deleteCollection.mutateAsync({ id: collection.id });
                await utils.collections.list.invalidate();
                navigate("/");
              })
            }
          />,
        ),
    },
  ];

  return (
    <div className="collection">
      <div
        className={
          "collection-row" +
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
        <button type="button" className="collection-name" onClick={onToggle}>
          <Icon name="chevron" className={"twist" + (expanded ? " open" : "")} />
          <span className="collection-label">{collection.name}</span>
        </button>
        <span className="row-actions">
          {collection.writable && (
            <button type="button" className="row-action" title="New document" aria-label="New document" onClick={() => void newDoc()}>
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
              collapsedDocs={collapsedDocs}
              onToggleDoc={onToggleDoc}
              onRevealDocs={onRevealDocs}
              onNewChild={(id) => void newDoc(id)}
              run={run}
              setDialog={setDialog}
            />
          </div>
          {(archived.data?.length ?? 0) > 0 && (
            <>
              <button type="button"
                className="archived-toggle"
                onClick={() => setShowArchived((s) => !s)}
              >
                <Icon name="chevron" className={"twist" + (showArchived ? " open" : "")} />
                Archived ({archived.data!.length})
              </button>
              {showArchived &&
                archived.data!.map((d) => (
                  <ArchivedRow
                    key={d.id}
                    doc={d}
                    writable={collection.writable}
                    run={run}
                  />
                ))}
            </>
          )}
          {(trash.data?.length ?? 0) > 0 && (
            <>
              <button type="button"
                className="archived-toggle"
                onClick={() => setShowTrash((s) => !s)}
              >
                <Icon name="chevron" className={"twist" + (showTrash ? " open" : "")} />
                Trash ({trash.data!.length})
              </button>
              {showTrash &&
                trash.data!.map((d) => (
                  <TrashRow key={d.id} doc={d} run={run} setDialog={setDialog} />
                ))}
            </>
          )}
        </>
      )}
    </div>
  );
}
