import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { trpc } from "../../trpc.js";
import { Icon } from "../Icon.js";
import { ConfirmDialog, RowMenu } from "../Modal.js";
import { useToast } from "../toast.js";
import type { DocNode } from "./types.js";

/** Parent chain (outermost first) leading to docId, excluding docId itself;
 * null when the doc isn't in this tree. */
export function ancestorPath(nodes: DocNode[], docId: string): string[] | null {
  for (const node of nodes) {
    if (node.id === docId) return [];
    const inChild = ancestorPath(node.children, docId);
    if (inChild) return [node.id, ...inChild];
  }
  return null;
}

/** Drop position while dragging: before/after = reorder, into = nest. */
type DropMode = "before" | "after" | "into";
export function DocTree({
  nodes,
  parentId,
  collectionId,
  writable,
  activeDocId,
  depth,
  collapsedDocs,
  onToggleDoc,
  onRevealDocs,
  onNewChild,
  run,
  setDialog,
}: {
  nodes: DocNode[];
  parentId: string | null;
  collectionId: string;
  writable: boolean;
  activeDocId: string | null;
  depth: number;
  collapsedDocs: Set<string>;
  onToggleDoc: (id: string) => void;
  onRevealDocs: (ids: string[]) => void;
  onNewChild: (parentId: string) => void;
  run: (fn: () => Promise<unknown>) => Promise<void>;
  setDialog: (node: ReactNode) => void;
}) {
  return (
    <>
      {nodes.map((node, i) => (
        <DocRow
          key={node.id}
          node={node}
          siblings={nodes}
          index={i}
          parentId={parentId}
          collectionId={collectionId}
          writable={writable}
          activeDocId={activeDocId}
          depth={depth}
          collapsedDocs={collapsedDocs}
          onToggleDoc={onToggleDoc}
          onRevealDocs={onRevealDocs}
          onNewChild={onNewChild}
          run={run}
          setDialog={setDialog}
        />
      ))}
    </>
  );
}
function DocRow({
  node,
  siblings,
  index,
  parentId,
  collectionId,
  writable,
  activeDocId,
  depth,
  collapsedDocs,
  onToggleDoc,
  onRevealDocs,
  onNewChild,
  run,
  setDialog,
}: {
  node: DocNode;
  siblings: DocNode[];
  index: number;
  parentId: string | null;
  collectionId: string;
  writable: boolean;
  activeDocId: string | null;
  depth: number;
  collapsedDocs: Set<string>;
  onToggleDoc: (id: string) => void;
  onRevealDocs: (ids: string[]) => void;
  onNewChild: (parentId: string) => void;
  run: (fn: () => Promise<unknown>) => Promise<void>;
  setDialog: (node: ReactNode) => void;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const move = trpc.documents.move.useMutation();
  const archive = trpc.documents.archive.useMutation();
  const restore = trpc.documents.restore.useMutation();
  const softDelete = trpc.documents.delete.useMutation();
  const duplicate = trpc.documents.duplicate.useMutation();
  const [dropMode, setDropMode] = useState<DropMode | null>(null);

  // Where a sibling drop lands: midway between this node and its neighbour.
  const positionFor = (mode: "before" | "after"): number => {
    if (mode === "before") {
      const prev = siblings[index - 1];
      return prev ? (prev.position + node.position) / 2 : node.position - 1;
    }
    const next = siblings[index + 1];
    return next ? (node.position + next.position) / 2 : node.position + 1;
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const payload = e.dataTransfer.getData("application/x-tandem-doc");
    const mode = dropMode;
    setDropMode(null);
    if (!payload || !mode) return;
    const dragged = JSON.parse(payload) as {
      id: string;
      collectionId: string;
      title: string;
      parentId: string | null;
      position: number;
    };
    // Moves stay within one collection (the backend enforces this too).
    if (dragged.collectionId !== collectionId || dragged.id === node.id) return;
    // Nesting into a folded folder unfolds it so the drop stays visible.
    if (mode === "into") onRevealDocs([node.id]);
    void run(async () => {
      await (mode === "into"
        ? move.mutateAsync({ id: dragged.id, parentDocumentId: node.id })
        : move.mutateAsync({
            id: dragged.id,
            parentDocumentId: parentId,
            position: positionFor(mode),
          }));
      toast(`Moved "${dragged.title || "Untitled"}"`, "ok", {
        label: "Undo",
        onClick: () =>
          void run(() =>
            move.mutateAsync({
              id: dragged.id,
              parentDocumentId: dragged.parentId,
              position: dragged.position,
            }),
          ),
      });
    });
  };

  const collapsed = collapsedDocs.has(node.id);

  return (
    <div>
      <Link
        to={`/d/${node.id}`}
        draggable={writable}
        className={
          "doc-row" +
          (node.id === activeDocId ? " active" : "") +
          (dropMode ? ` drop-${dropMode}` : "")
        }
        style={{ paddingLeft: 9 + depth * 14 }}
        onDragStart={(e) => {
          e.dataTransfer.setData(
            "application/x-tandem-doc",
            JSON.stringify({
              id: node.id,
              collectionId,
              title: node.title,
              // Where it came from, so the move can be undone.
              parentId,
              position: node.position,
            }),
          );
        }}
        onDragOver={(e) => {
          if (!writable || !e.dataTransfer.types.includes("application/x-tandem-doc")) return;
          e.preventDefault();
          const rect = e.currentTarget.getBoundingClientRect();
          const y = (e.clientY - rect.top) / rect.height;
          setDropMode(y < 0.25 ? "before" : y > 0.75 ? "after" : "into");
        }}
        onDragLeave={() => setDropMode(null)}
        onDrop={onDrop}
      >
        {node.children.length > 0 ? (
          <button type="button"
            className="doc-twist"
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Expand" : "Collapse"}
            onClick={(e) => {
              e.preventDefault();
              onToggleDoc(node.id);
            }}
          >
            <Icon name="chevron" size={12} className={"twist" + (collapsed ? "" : " open")} />
          </button>
        ) : (
          <span className="doc-twist" aria-hidden="true" />
        )}
        <span className="doc-title">{node.title || "Untitled"}</span>
        {writable && (
          <span className="row-actions">
            <button type="button"
              className="row-action"
              title="New sub-document" aria-label="New sub-document"
              onClick={(e) => {
                e.preventDefault();
                onNewChild(node.id);
              }}
            >
              <Icon name="plus" />
            </button>
            <RowMenu
              items={[
                {
                  label: "Duplicate",
                  icon: "page",
                  onClick: () =>
                    void run(async () => {
                      const created = await duplicate.mutateAsync({ id: node.id });
                      toast("Duplicated");
                      navigate(`/d/${created.id}`);
                    }),
                },
                {
                  label: "Archive",
                  icon: "archive",
                  onClick: () =>
                    void run(async () => {
                      await archive.mutateAsync({ id: node.id });
                      const wasActive = node.id === activeDocId;
                      toast(`Archived "${node.title || "Untitled"}"`, "ok", {
                        label: "Undo",
                        onClick: () =>
                          void run(async () => {
                            await restore.mutateAsync({ id: node.id });
                            if (wasActive) navigate(`/d/${node.id}`);
                          }),
                      });
                      if (wasActive) navigate("/");
                    }),
                },
                {
                  label: "Delete",
                  icon: "trash",
                  danger: true,
                  onClick: () =>
                    setDialog(
                      <ConfirmDialog
                        title="Delete document"
                        body={`"${node.title || "Untitled"}" and its sub-documents will be deleted.`}
                        confirmLabel="Delete"
                        onClose={() => setDialog(null)}
                        onConfirm={() =>
                          void run(async () => {
                            await softDelete.mutateAsync({ id: node.id });
                            toast("Deleted");
                            if (node.id === activeDocId) navigate("/");
                          })
                        }
                      />,
                    ),
                },
              ]}
            />
          </span>
        )}
      </Link>
      {node.children.length > 0 && !collapsed && (
        <DocTree
          nodes={node.children}
          parentId={node.id}
          collectionId={collectionId}
          writable={writable}
          activeDocId={activeDocId}
          depth={depth + 1}
          collapsedDocs={collapsedDocs}
          onToggleDoc={onToggleDoc}
          onRevealDocs={onRevealDocs}
          onNewChild={onNewChild}
          run={run}
          setDialog={setDialog}
        />
      )}
    </div>
  );
}
export function ArchivedRow({
  doc,
  writable,
  run,
  setDialog,
}: {
  doc: { id: string; title: string };
  writable: boolean;
  run: (fn: () => Promise<unknown>) => Promise<void>;
  setDialog: (node: ReactNode) => void;
}) {
  const restore = trpc.documents.restore.useMutation();
  const softDelete = trpc.documents.delete.useMutation();
  const toast = useToast();
  return (
    <div className="doc-row archived-row">
      <Link className="doc-title archived-title" to={`/d/${doc.id}`}>
        {doc.title || "Untitled"}
      </Link>
      {writable && (
        <span className="row-actions">
          <button type="button"
            className="row-action"
            title="Restore" aria-label="Restore"
            onClick={() =>
              void run(async () => {
                await restore.mutateAsync({ id: doc.id });
                toast(`Restored "${doc.title || "Untitled"}"`);
              })
            }
          >
            <Icon name="restore" />
          </button>
          <button type="button"
            className="row-action"
            title="Delete permanently" aria-label="Delete permanently"
            onClick={() =>
              setDialog(
                <ConfirmDialog
                  title="Delete document"
                  body={`"${doc.title || "Untitled"}" will be deleted permanently.`}
                  confirmLabel="Delete"
                  onClose={() => setDialog(null)}
                  onConfirm={() => void run(() => softDelete.mutateAsync({ id: doc.id }))}
                />,
              )
            }
          >
            <Icon name="trash" />
          </button>
        </span>
      )}
    </div>
  );
}
