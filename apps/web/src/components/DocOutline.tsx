import { useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { friendlyError } from "../errors.js";
import { trpc } from "../trpc.js";
import { Icon } from "./Icon.js";
import { timeAgo } from "./time.js";
import { useToast } from "./toast.js";
import { useCreateDocument } from "./useCreateDocument.js";

export interface DocumentNode {
  id: string;
  title: string;
  updatedAt: string | Date;
  children: DocumentNode[];
}

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

/** Nested, collapsible list of documents; folds last for the session only. */
export function DocOutline({ nodes }: { nodes: DocumentNode[] }) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  const rows = (list: DocumentNode[], level: number): ReactNode[] =>
    list.flatMap((node) => {
      const open = !collapsed.has(node.id);
      const title = node.title || "Untitled";
      return [
        <li key={node.id} className="outline-row" style={{ "--level": level } as CSSProperties}>
          {node.children.length > 0 ? (
            <button
              type="button"
              className="outline-twist"
              aria-expanded={open}
              aria-label={`${open ? "Collapse" : "Expand"} ${title}`}
              onClick={() =>
                setCollapsed((prev) => {
                  const next = new Set(prev);
                  if (!next.delete(node.id)) next.add(node.id);
                  return next;
                })
              }
            >
              <Icon name="chevron" size={14} className={"twist" + (open ? " open" : "")} />
            </button>
          ) : (
            <span className="outline-twist" aria-hidden="true" />
          )}
          <Link to={`/d/${node.id}`} className="outline-link">
            <span className="document-name">{title}</span>
            <span className="document-when">edited {timeAgo(node.updatedAt)}</span>
          </Link>
        </li>,
        ...(open ? rows(node.children, level + 1) : []),
      ];
    });

  return <ul className="doc-outline">{rows(nodes, 0)}</ul>;
}

/** The "Pages" section on a parent document: its sub-pages, plus "New page"
 * for writers. Renders nothing for a document without children. */
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
  const createDocument = useCreateDocument();
  const toast = useToast();
  const [open, setOpen] = useState(true);
  const children = (tree.data && findDocument(tree.data, docId)?.children) ?? [];
  if (children.length === 0) return null;
  const count = documentCount(children);
  return (
    <section className="sub-pages" aria-label="Pages">
      <div className="sub-pages-head">
        <button
          type="button"
          className="sub-pages-toggle"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <Icon name="chevron" size={14} className={"twist" + (open ? " open" : "")} />
          {count} page{count === 1 ? "" : "s"}
        </button>
        {canEdit && (
          <button
            type="button"
            className="btn sub-pages-new"
            onClick={() =>
              void createDocument(collectionId, docId).catch((e) => toast(friendlyError(e), "danger"))
            }
          >
            <Icon name="plus" size={14} /> New page
          </button>
        )}
      </div>
      {open && <DocOutline nodes={children} />}
    </section>
  );
}
