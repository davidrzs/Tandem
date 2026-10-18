import { useState } from "react";
import { Link } from "react-router-dom";
import { Icon } from "../Icon.js";
import { RowMenu } from "../Modal.js";
import { OverflowTooltip } from "../OverflowTooltip.js";
import type { DocNode } from "./types.js";
import type { Folds } from "./useFoldState.js";
import type { DocRef, SidebarActions } from "./useSidebarActions.js";

/** Drop position while dragging: before/after = reorder, into = nest. */
type DropMode = "before" | "after" | "into";
interface TreeProps {
  collectionId: string;
  writable: boolean;
  activeDocId: string | null;
  depth: number;
  folds: Folds;
  actions: SidebarActions;
}

export function DocTree({ nodes, parentId, ...rest }: TreeProps & { nodes: DocNode[]; parentId: string | null }) {
  return (
    <>
      {nodes.map((node, i) => (
        <DocRow key={node.id} node={node} siblings={nodes} index={i} parentId={parentId} {...rest} />
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
  folds,
  actions,
}: TreeProps & { node: DocNode; siblings: DocNode[]; index: number; parentId: string | null }) {
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
    void actions.move({
      kind: "doc",
      id: dragged.id,
      collectionId,
      title: dragged.title,
      to:
        mode === "into"
          ? { parentDocumentId: node.id }
          : { parentDocumentId: parentId, position: positionFor(mode) },
      from: { parentDocumentId: dragged.parentId, position: dragged.position },
      reveal: mode === "into" ? node.id : null,
    });
  };

  const collapsed = folds.snapshot.collapsedDocs.has(node.id);
  const active = node.id === activeDocId;
  const ref: DocRef = { id: node.id, collectionId, title: node.title };

  return (
    <div>
      <Link
        to={`/d/${node.id}`}
        draggable={writable}
        className={"doc-row tree-row" + (active ? " active" : "") + (dropMode ? ` drop-${dropMode}` : "")}
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
              folds.apply([{ kind: "doc", id: node.id, expanded: collapsed }]);
            }}
          >
            <Icon name="chevron" size={12} className={"twist" + (collapsed ? "" : " open")} />
          </button>
        ) : (
          <span className="doc-twist" aria-hidden="true" />
        )}
        <OverflowTooltip text={node.title || "Untitled"}>
          <span className="doc-title">{node.title || "Untitled"}</span>
        </OverflowTooltip>
        {writable && (
          <span className="row-actions">
            <button type="button"
              className="row-action"
              title="New sub-document" aria-label="New sub-document"
              onClick={(e) => {
                e.preventDefault();
                void actions.newDoc(collectionId, node.id);
              }}
            >
              <Icon name="plus" />
            </button>
            <RowMenu
              items={[
                { label: "Duplicate", icon: "page", onClick: () => void actions.duplicateDoc(ref) },
                { label: "Archive", icon: "archive", onClick: () => void actions.archiveDoc(ref, active) },
                {
                  label: "Delete",
                  icon: "trash",
                  danger: true,
                  onClick: () => void actions.deleteDoc(ref, active),
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
          folds={folds}
          actions={actions}
        />
      )}
    </div>
  );
}

export function ArchivedRow({
  doc,
  writable,
  actions,
}: {
  doc: DocRef;
  writable: boolean;
  actions: SidebarActions;
}) {
  return (
    <div className="doc-row archived-row tree-row">
      <OverflowTooltip text={doc.title || "Untitled"}>
        <Link className="doc-title archived-title" to={`/d/${doc.id}`}>
          {doc.title || "Untitled"}
        </Link>
      </OverflowTooltip>
      {writable && (
        <span className="row-actions">
          <button type="button"
            className="row-action"
            title="Restore" aria-label="Restore"
            onClick={() => void actions.restoreArchived(doc)}
          >
            <Icon name="restore" />
          </button>
          <button type="button"
            className="row-action"
            title="Move to trash" aria-label="Move to trash"
            onClick={() => void actions.trashArchived(doc)}
          >
            <Icon name="trash" />
          </button>
        </span>
      )}
    </div>
  );
}

/** A trash root: restore it (with what was deleted together), or delete it
 * for good. Shown to writers only. */
export function TrashRow({ doc, actions }: { doc: DocRef; actions: SidebarActions }) {
  const title = doc.title || "Untitled";
  return (
    <div className="doc-row archived-row trash-row tree-row">
      <OverflowTooltip text={title}>
        <Link className="doc-title archived-title" to={`/d/${doc.id}`}>
          {title}
        </Link>
      </OverflowTooltip>
      <span className="row-actions">
        <button type="button"
          className="row-action"
          title="Restore" aria-label="Restore"
          onClick={() => void actions.restoreTrashed(doc)}
        >
          <Icon name="restore" />
        </button>
        <button type="button"
          className="row-action"
          title="Delete forever" aria-label="Delete forever"
          onClick={() => actions.purgeTrashed(doc)}
        >
          <Icon name="trash" />
        </button>
      </span>
    </div>
  );
}
