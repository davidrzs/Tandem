import type { ItemInstance } from "@headless-tree/core";
import { useId, type CSSProperties } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Icon } from "../Icon.js";
import { RowMenu } from "../Modal.js";
import { OverflowTooltip } from "../OverflowTooltip.js";
import { displayTitle } from "../outline.js";
import { NewPageMenu } from "../TemplateMenus.js";
import type { SidebarNode } from "./sidebarIndex.js";
import { toggle, treeRowProps, useSidebarTreeContext } from "./useSidebarTree.js";

type RowProps<K extends SidebarNode["kind"]> = {
  item: ItemInstance<SidebarNode>;
  node: Extract<SidebarNode, { kind: K }>;
};

const cx = (...names: (string | false)[]) => names.filter(Boolean).join(" ");

export function TreeRow({ item }: { item: ItemInstance<SidebarNode> }) {
  const node = item.getItemData();
  switch (node.kind) {
    case "collection":
      return <CollectionRow item={item} node={node} />;
    case "doc":
      return <DocRow item={item} node={node} />;
    case "group":
      return <GroupRow item={item} node={node} />;
    case "archived":
      return <ArchivedRow item={item} node={node} />;
    case "trash":
      return <TrashRow item={item} node={node} />;
    case "root":
    case "gone":
      return null;
    default:
      return node satisfies never;
  }
}

function CollectionRow({ item, node }: RowProps<"collection">) {
  const { actions, index, menuFor, setMenuFor } = useSidebarTreeContext();
  const navigate = useNavigate();
  const c = node.collection;
  const expanded = item.isExpanded();
  const hasDocs = node.childIds.some((id) => index.nodes.get(id)?.kind === "doc");
  const note = !expanded
    ? null
    : node.load === "loading"
      ? "Loading…"
      : node.load === "error"
        ? "Couldn't load documents."
        : node.load === "ready" && !hasDocs
          ? "No documents yet."
          : null;
  const noteId = useId();
  return (
    <>
      <div
        {...treeRowProps(item, c.writable)}
        aria-describedby={note ? noteId : undefined}
        className={cx("collection-row tree-row", expanded && "open", item.isUnorderedDragTarget() && "drop-into")}
      >
        <button type="button" className="collection-name" tabIndex={-1} onClick={() => toggle(item)}>
          <Icon name="chevron" size={14} className={"twist" + (expanded ? " open" : "")} />
          <OverflowTooltip text={c.name}>
            <span className="collection-label">{c.name}</span>
          </OverflowTooltip>
        </button>
        <span className="row-actions">
          {c.writable && (
            <button type="button"
              className="row-action"
              tabIndex={-1}
              title="New document" aria-label="New document"
              onClick={() => void actions.newDoc(c.id)}
            >
              <Icon name="plus" />
            </button>
          )}
          {c.writable && (
            <NewPageMenu
              workspaceId={c.workspaceId}
              collectionId={c.id}
              className="row-action"
              tabIndex={-1}
              onPick={(templateId) => void actions.newDoc(c.id, undefined, templateId)}
            />
          )}
          <RowMenu
            open={menuFor === node.id}
            onOpenChange={(open) => setMenuFor(open ? node.id : null)}
            returnFocus={() => item.getElement()?.focus()}
            items={[
              ...(node.load === "error"
                ? [{ label: "Retry loading", icon: "restore" as const, onClick: () => actions.retryTree(c.id) }]
                : []),
              ...(c.writable
                ? [
                    { label: "New document", icon: "plus" as const, onClick: () => void actions.newDoc(c.id) },
                    {
                      label: "New from template…",
                      icon: "page" as const,
                      onClick: () => void actions.newFromTemplate({ collectionId: c.id, workspaceId: c.workspaceId }),
                    },
                    { label: "Rename", icon: "pen" as const, onClick: () => actions.renameCollection(c) },
                    {
                      label: "Default template…",
                      icon: "page" as const,
                      onClick: () =>
                        void actions.setDefaultTemplate({ collectionId: c.id, workspaceId: c.workspaceId, place: c.name }),
                    },
                  ]
                : []),
              { label: "Open collection page", icon: "page", onClick: () => navigate(`/c/${c.id}`) },
              { label: "Share & access", icon: "share", onClick: () => actions.shareCollection(c) },
              { label: "Export", icon: "download", onClick: () => void actions.exportCollection(c) },
              { label: "Delete collection", icon: "trash", danger: true, onClick: () => actions.deleteCollection(c) },
            ]}
          />
        </span>
      </div>
      {/* A tree may only own treeitems: the note reaches assistive tech as the
          row's description, and Retry through the row menu. */}
      {note && (
        <div className="side-note tree-note" aria-hidden="true" style={{ "--level": 1 } as CSSProperties}>
          <span id={noteId} className={node.load === "loading" ? "shimmer" : undefined}>{note}</span>
          {node.load === "error" && (
            <>
              {" "}
              <button type="button" className="side-link" tabIndex={-1} onClick={() => actions.retryTree(c.id)}>
                Retry
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
}

function DocRow({ item, node }: RowProps<"doc">) {
  const { actions, activeDocId, menuFor, setMenuFor, templateIds, workspaceId } = useSidebarTreeContext();
  const active = node.id === activeDocId;
  const title = displayTitle(node);
  const template = templateIds.has(node.id);
  return (
    <Link
      to={`/d/${node.id}`}
      {...treeRowProps(item, node.writable)}
      aria-label={template ? `${title} Template` : item.getItemName()}
      className={cx("doc-row tree-row", active && "active", item.isUnorderedDragTarget() && "drop-into")}
      aria-current={active ? "page" : undefined}
    >
      <Twist item={item} />
      <OverflowTooltip text={title}>
        <span className="doc-title">{title}</span>
      </OverflowTooltip>
      {template && <span className="template-badge">Template</span>}
      {node.writable && (
        <span className="row-actions">
          <button type="button"
            className="row-action"
            tabIndex={-1}
            title="New sub-document" aria-label="New sub-document"
            onClick={(e) => {
              e.preventDefault();
              void actions.newDoc(node.collectionId, node.id);
            }}
          >
            <Icon name="plus" />
          </button>
          {workspaceId && (
            <NewPageMenu
              workspaceId={workspaceId}
              collectionId={node.collectionId}
              parentDocumentId={node.id}
              className="row-action"
              tabIndex={-1}
              onPick={(templateId) => void actions.newDoc(node.collectionId, node.id, templateId)}
            />
          )}
          <RowMenu
            open={menuFor === node.id}
            onOpenChange={(open) => setMenuFor(open ? node.id : null)}
            returnFocus={() => item.getElement()?.focus()}
            items={[
              { label: "New sub-document", icon: "plus", onClick: () => void actions.newDoc(node.collectionId, node.id) },
              ...(workspaceId
                ? [
                    {
                      label: "New from template…",
                      icon: "page" as const,
                      onClick: () =>
                        void actions.newFromTemplate({
                          collectionId: node.collectionId,
                          parentDocumentId: node.id,
                          workspaceId,
                        }),
                    },
                  ]
                : []),
              { label: "Duplicate", icon: "page", onClick: () => void actions.duplicateDoc(node) },
              template
                ? { label: "Turn into page", icon: "page", onClick: () => void actions.turnIntoPage(node) }
                : { label: "Save as template", icon: "page", onClick: () => actions.saveAsTemplate(node) },
              ...(workspaceId
                ? [
                    {
                      label: "Default template…",
                      icon: "page" as const,
                      onClick: () =>
                        void actions.setDefaultTemplate({
                          documentId: node.id,
                          collectionId: node.collectionId,
                          workspaceId,
                          place: `“${title}”`,
                        }),
                    },
                  ]
                : []),
              { label: "Archive", icon: "archive", onClick: () => void actions.archiveDoc(node, active) },
              { label: "Delete", icon: "trash", danger: true, onClick: () => void actions.deleteDoc(node, active) },
            ]}
          />
        </span>
      )}
    </Link>
  );
}

function Twist({ item }: { item: ItemInstance<SidebarNode> }) {
  if (!item.isFolder()) return <span className="doc-twist" aria-hidden="true" />;
  const expanded = item.isExpanded();
  return (
    <button type="button"
      className="doc-twist"
      tabIndex={-1}
      aria-expanded={expanded}
      aria-label={expanded ? "Collapse" : "Expand"}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        toggle(item);
      }}
    >
      <Icon name="chevron" size={12} className={"twist" + (expanded ? " open" : "")} />
    </button>
  );
}

function GroupRow({ item, node }: RowProps<"group">) {
  const expanded = item.isExpanded();
  return (
    <div {...treeRowProps(item, false)} className="tree-group-row tree-row">
      <button type="button" className="archived-toggle" tabIndex={-1} onClick={() => toggle(item)}>
        <Icon name="chevron" size={14} className={"twist" + (expanded ? " open" : "")} />
        {node.group === "archived" ? "Archived" : "Trash"} ({node.childIds.length})
      </button>
    </div>
  );
}

function ArchivedRow({ item, node }: RowProps<"archived">) {
  const { actions } = useSidebarTreeContext();
  const title = displayTitle(node);
  return (
    <div {...treeRowProps(item, false)} className="doc-row archived-row tree-row">
      <span className="doc-twist" aria-hidden="true" />
      <OverflowTooltip text={title}>
        <Link className="doc-title archived-title" tabIndex={-1} to={`/d/${node.id}`}>
          {title}
        </Link>
      </OverflowTooltip>
      {node.writable && (
        <span className="row-actions">
          <button type="button"
            className="row-action"
            tabIndex={-1}
            title="Restore" aria-label="Restore"
            onClick={() => void actions.restoreArchived(node)}
          >
            <Icon name="restore" />
          </button>
          <button type="button"
            className="row-action"
            tabIndex={-1}
            title="Move to trash" aria-label="Move to trash"
            onClick={() => void actions.trashArchived(node)}
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
function TrashRow({ item, node }: RowProps<"trash">) {
  const { actions } = useSidebarTreeContext();
  const title = displayTitle(node);
  return (
    <div {...treeRowProps(item, false)} className="doc-row archived-row trash-row tree-row">
      <span className="doc-twist" aria-hidden="true" />
      <OverflowTooltip text={title}>
        <Link className="doc-title archived-title" tabIndex={-1} to={`/d/${node.id}`}>
          {title}
        </Link>
      </OverflowTooltip>
      <span className="row-actions">
        <button type="button"
          className="row-action"
          tabIndex={-1}
          title="Restore" aria-label="Restore"
          onClick={() => void actions.restoreTrashed(node)}
        >
          <Icon name="restore" />
        </button>
        <button type="button"
          className="row-action"
          tabIndex={-1}
          title="Delete forever" aria-label="Delete forever"
          onClick={() => actions.purgeTrashed(node)}
        >
          <Icon name="trash" />
        </button>
      </span>
    </div>
  );
}
