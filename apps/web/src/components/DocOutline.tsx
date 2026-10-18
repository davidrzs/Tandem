import { useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { friendlyError } from "../errors.js";
import { trpc } from "../trpc.js";
import { Icon } from "./Icon.js";
import {
  displayTitle,
  documentCount,
  findDocument,
  nextSort,
  outlineRows,
  type DocumentNode,
  type OutlineSort,
  type SortKey,
} from "./outline.js";
import { timeAgo } from "./time.js";
import { useToast } from "./toast.js";
import { useCreateDocument } from "./useCreateDocument.js";

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "pages", label: "Pages" },
  { key: "updated", label: "Updated" },
];

/** Filterable, sortable folder table of a document tree; nested rows start
 * folded. View state lasts for the session only. `parentId` files new pages
 * under that document, otherwise at the top of the collection. */
export function DocOutline({
  nodes,
  collectionId,
  parentId,
  canEdit,
}: {
  nodes: DocumentNode[];
  collectionId: string;
  parentId?: string;
  canEdit: boolean;
}) {
  const createDocument = useCreateDocument();
  const toast = useToast();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [sort, setSort] = useState<OutlineSort | null>(null);
  const [filter, setFilter] = useState("");
  const rows = outlineRows(nodes, { expanded, sort, filter });
  const filtering = filter.trim() !== "";
  const count = documentCount(nodes);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <div className="outline-panel">
      <div className="outline-bar">
        <span className="outline-label">Contents</span>
        <span className="outline-count">
          {count} page{count === 1 ? "" : "s"}
        </span>
        <input
          type="search"
          className="outline-filter"
          placeholder="Filter pages…"
          aria-label="Filter pages"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {canEdit && (
          <button
            type="button"
            className="btn outline-new"
            onClick={() =>
              void createDocument(collectionId, parentId).catch((e) => toast(friendlyError(e), "danger"))
            }
          >
            <Icon name="plus" size={14} /> {parentId ? "New page" : "New document"}
          </button>
        )}
      </div>
      <table className="outline-table">
        <thead>
          <tr>
            {COLUMNS.map(({ key, label }) => {
              const active = sort?.key === key ? sort.dir : null;
              return (
                <th
                  key={key}
                  className={`outline-col-${key}`}
                  aria-sort={active === "asc" ? "ascending" : active === "desc" ? "descending" : undefined}
                >
                  <button type="button" onClick={() => setSort(nextSort(sort, key))}>
                    {label}
                    {active && <span aria-hidden="true">{active === "asc" ? " ↑" : " ↓"}</span>}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ node, depth, hasChildren, descendants, expanded: open }) => {
            const title = displayTitle(node);
            return (
              <tr key={node.id}>
                <td>
                  <div className="outline-name" style={{ "--depth": depth } as CSSProperties}>
                    {hasChildren ? (
                      <button
                        type="button"
                        className="outline-twist"
                        aria-expanded={open}
                        aria-label={`${open ? "Collapse" : "Expand"} ${title}`}
                        disabled={filtering}
                        onClick={() => toggle(node.id)}
                      >
                        <Icon name="chevron" size={14} className={"twist" + (open ? " open" : "")} />
                      </button>
                    ) : (
                      <span className="outline-twist" aria-hidden="true" />
                    )}
                    <Icon name={hasChildren ? "folder" : "page"} size={15} className="outline-icon" />
                    <Link to={`/d/${node.id}`} className="outline-link">
                      {title}
                    </Link>
                  </div>
                </td>
                <td className="outline-pages">{hasChildren ? descendants : "—"}</td>
                <td className="outline-updated">{timeAgo(node.updatedAt)}</td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr>
              <td colSpan={COLUMNS.length} className="outline-empty">
                {filtering ? "No pages match" : "No documents yet"}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/** The "Pages" section on a parent document. Renders nothing for a document
 * without children. */
export function SubPages({
  docId,
  collectionId,
  canEdit,
}: {
  docId: string;
  collectionId: string;
  canEdit: boolean;
}) {
  const tree = trpc.documents.tree.useQuery({ collectionId });
  const children = (tree.data && findDocument(tree.data, docId)?.children) ?? [];
  if (children.length === 0) return null;
  return (
    <section className="sub-pages" aria-label="Pages">
      <DocOutline nodes={children} collectionId={collectionId} parentId={docId} canEdit={canEdit} />
    </section>
  );
}
