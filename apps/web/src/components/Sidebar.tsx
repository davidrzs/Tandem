import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { trpc } from "../trpc.js";
import { RowMenu } from "./Modal.js";

interface Workspace {
  id: string;
  name: string;
}
interface Collection {
  id: string;
  name: string;
  workspaceId: string;
  defaultRole: string;
  writable: boolean;
}
interface DocNode {
  id: string;
  title: string;
  position: number;
  children: DocNode[];
}

interface Props {
  loading: boolean;
  workspaces: Workspace[];
  workspaceId: string | null;
  collections: Collection[];
  activeDocId: string | null;
  activeCollectionId: string | null;
  onSelectWorkspace: (id: string) => void;
  onOpenSearch: () => void;
  onOpenPeople: () => void;
  onShareCollection: (id: string) => void;
}

function slugify(name: string) {
  return (
    name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") +
    "-" +
    Math.floor(performance.now()).toString(36)
  );
}

export function Sidebar({
  loading,
  workspaces,
  workspaceId,
  collections,
  activeDocId,
  activeCollectionId,
  onSelectWorkspace,
  onOpenSearch,
  onOpenPeople,
  onShareCollection,
}: Props) {
  const utils = trpc.useUtils();
  const navigate = useNavigate();
  const createWorkspace = trpc.workspaces.create.useMutation();
  const createCollection = trpc.collections.create.useMutation();

  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // The open document's collection is always expanded.
  useEffect(() => {
    if (activeCollectionId) {
      setExpanded((prev) =>
        prev.has(activeCollectionId) ? prev : new Set(prev).add(activeCollectionId),
      );
    }
  }, [activeCollectionId]);

  // Surface failures (RLS denial, duplicate slug, non-admin) instead of a
  // silent unhandled rejection.
  const run = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    }
  };

  const newWorkspace = () =>
    run(async () => {
      const name = window.prompt("Workspace name")?.trim();
      if (!name) return;
      const ws = await createWorkspace.mutateAsync({ name, slug: slugify(name) });
      await utils.workspaces.mine.invalidate();
      onSelectWorkspace(ws.id);
    });

  const newCollection = () =>
    run(async () => {
      const name = window.prompt("Collection name")?.trim();
      if (!name) return;
      await createCollection.mutateAsync({
        name,
        slug: slugify(name),
        ...(workspaceId ? { workspaceId } : {}),
      });
      await utils.collections.list.invalidate();
    });

  return (
    <aside className="sidebar">
      <div className="section">
        <div className="section-title">
          Workspace
          <button className="add" title="New workspace" onClick={() => void newWorkspace()}>
            +
          </button>
        </div>
        <select
          className="ws-select"
          value={workspaceId ?? ""}
          onChange={(e) => {
            onSelectWorkspace(e.target.value);
            navigate("/");
          }}
        >
          {!workspaceId && (
            <option value="" disabled hidden>
              Select a workspace…
            </option>
          )}
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
        <nav className="side-nav">
          <Link className={"row" + (activeDocId ? "" : " active")} to="/">
            Home
          </Link>
          <button className="row" onClick={onOpenSearch}>
            Search <kbd>⌘K</kbd>
          </button>
          {workspaceId && (
            <button className="row" onClick={onOpenPeople}>
              People &amp; groups
            </button>
          )}
        </nav>
        {error && <div className="sidebar-error">{error}</div>}
      </div>

      <div className="section">
        <div className="section-title">
          Collections
          <button className="add" title="New collection" onClick={() => void newCollection()}>
            +
          </button>
        </div>
        {loading && <div className="side-note">Loading…</div>}
        {!loading && collections.length === 0 && (
          <div className="side-note">No collections yet — create one.</div>
        )}
        {collections.map((c) => (
          <CollectionSection
            key={c.id}
            collection={c}
            expanded={expanded.has(c.id)}
            activeDocId={activeDocId}
            onToggle={() =>
              setExpanded((prev) => {
                const next = new Set(prev);
                if (next.has(c.id)) next.delete(c.id);
                else next.add(c.id);
                return next;
              })
            }
            onShare={() => onShareCollection(c.id)}
            onError={setError}
          />
        ))}
      </div>
    </aside>
  );
}

function CollectionSection({
  collection,
  expanded,
  activeDocId,
  onToggle,
  onShare,
  onError,
}: {
  collection: Collection;
  expanded: boolean;
  activeDocId: string | null;
  onToggle: () => void;
  onShare: () => void;
  onError: (msg: string) => void;
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
  const createDoc = trpc.documents.create.useMutation();
  const renameCollection = trpc.collections.update.useMutation();
  const deleteCollection = trpc.collections.delete.useMutation();
  const [showArchived, setShowArchived] = useState(false);

  const refresh = () =>
    Promise.all([
      utils.documents.tree.invalidate({ collectionId: collection.id }),
      utils.documents.listArchived.invalidate({ collectionId: collection.id }),
    ]);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await refresh();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Something went wrong");
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
      navigate(`/d/${doc.id}`);
    });

  const menuItems = [
    ...(collection.writable
      ? [
          { label: "New document", onClick: () => void newDoc() },
          {
            label: "Rename",
            onClick: () => {
              const name = window.prompt("Collection name", collection.name)?.trim();
              if (!name) return;
              void run(async () => {
                await renameCollection.mutateAsync({ id: collection.id, name });
                await utils.collections.list.invalidate();
              });
            },
          },
        ]
      : []),
    { label: "Share & access", onClick: onShare },
    {
      label: "Delete collection",
      danger: true,
      onClick: () => {
        if (
          window.confirm(
            `Delete "${collection.name}" and all its documents? (Owners/admins only.)`,
          )
        ) {
          void run(async () => {
            await deleteCollection.mutateAsync({ id: collection.id });
            await utils.collections.list.invalidate();
            navigate("/");
          });
        }
      },
    },
  ];

  return (
    <div className="collection">
      <div className={"row collection-row" + (expanded ? " open" : "")}>
        <button className="collection-name" onClick={onToggle}>
          <span className="twist">{expanded ? "▾" : "▸"}</span>
          {collection.name}
        </button>
        <span className="row-actions">
          {collection.writable && (
            <button className="row-action" title="New document" onClick={() => void newDoc()}>
              +
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
              <button className="side-link" onClick={() => void tree.refetch()}>
                Retry
              </button>
            </div>
          )}
          <DocTree
            nodes={tree.data ?? []}
            parentId={null}
            collectionId={collection.id}
            writable={collection.writable}
            activeDocId={activeDocId}
            depth={0}
            onNewChild={(id) => void newDoc(id)}
            run={run}
          />
          {(archived.data?.length ?? 0) > 0 && (
            <>
              <button
                className="row archived-toggle"
                onClick={() => setShowArchived((s) => !s)}
              >
                {showArchived ? "▾" : "▸"} Archived ({archived.data!.length})
              </button>
              {showArchived &&
                archived.data!.map((d) => (
                  <ArchivedRow key={d.id} doc={d} writable={collection.writable} run={run} />
                ))}
            </>
          )}
        </>
      )}
    </div>
  );
}

/** Drop position while dragging: before/after = reorder, into = nest. */
type DropMode = "before" | "after" | "into";

function DocTree({
  nodes,
  parentId,
  collectionId,
  writable,
  activeDocId,
  depth,
  onNewChild,
  run,
}: {
  nodes: DocNode[];
  parentId: string | null;
  collectionId: string;
  writable: boolean;
  activeDocId: string | null;
  depth: number;
  onNewChild: (parentId: string) => void;
  run: (fn: () => Promise<unknown>) => Promise<void>;
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
          onNewChild={onNewChild}
          run={run}
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
  onNewChild,
  run,
}: {
  node: DocNode;
  siblings: DocNode[];
  index: number;
  parentId: string | null;
  collectionId: string;
  writable: boolean;
  activeDocId: string | null;
  depth: number;
  onNewChild: (parentId: string) => void;
  run: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const navigate = useNavigate();
  const move = trpc.documents.move.useMutation();
  const archive = trpc.documents.archive.useMutation();
  const softDelete = trpc.documents.delete.useMutation();
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
    const dragged = JSON.parse(payload) as { id: string; collectionId: string };
    // Moves stay within one collection (the backend enforces this too).
    if (dragged.collectionId !== collectionId || dragged.id === node.id) return;
    void run(() =>
      mode === "into"
        ? move.mutateAsync({ id: dragged.id, parentDocumentId: node.id })
        : move.mutateAsync({
            id: dragged.id,
            parentDocumentId: parentId,
            position: positionFor(mode),
          }),
    );
  };

  return (
    <div>
      <Link
        to={`/d/${node.id}`}
        draggable={writable}
        className={
          "row doc-row" +
          (node.id === activeDocId ? " active" : "") +
          (dropMode ? ` drop-${dropMode}` : "")
        }
        style={{ paddingLeft: 12 + depth * 14 }}
        onDragStart={(e) => {
          e.dataTransfer.setData(
            "application/x-tandem-doc",
            JSON.stringify({ id: node.id, collectionId }),
          );
        }}
        onDragOver={(e) => {
          if (!writable) return;
          e.preventDefault();
          const rect = e.currentTarget.getBoundingClientRect();
          const y = (e.clientY - rect.top) / rect.height;
          setDropMode(y < 0.25 ? "before" : y > 0.75 ? "after" : "into");
        }}
        onDragLeave={() => setDropMode(null)}
        onDrop={onDrop}
      >
        <span className="doc-title">{node.title || "Untitled"}</span>
        {writable && (
          <span className="row-actions">
            <button
              className="row-action"
              title="New sub-document"
              onClick={(e) => {
                e.preventDefault();
                onNewChild(node.id);
              }}
            >
              +
            </button>
            <RowMenu
              items={[
                {
                  label: "Archive",
                  onClick: () =>
                    void run(async () => {
                      await archive.mutateAsync({ id: node.id });
                      if (node.id === activeDocId) navigate("/");
                    }),
                },
                {
                  label: "Delete",
                  danger: true,
                  onClick: () => {
                    if (
                      window.confirm(
                        `Delete "${node.title || "Untitled"}" and its sub-documents?`,
                      )
                    ) {
                      void run(async () => {
                        await softDelete.mutateAsync({ id: node.id });
                        if (node.id === activeDocId) navigate("/");
                      });
                    }
                  },
                },
              ]}
            />
          </span>
        )}
      </Link>
      {node.children.length > 0 && (
        <DocTree
          nodes={node.children}
          parentId={node.id}
          collectionId={collectionId}
          writable={writable}
          activeDocId={activeDocId}
          depth={depth + 1}
          onNewChild={onNewChild}
          run={run}
        />
      )}
    </div>
  );
}

function ArchivedRow({
  doc,
  writable,
  run,
}: {
  doc: { id: string; title: string };
  writable: boolean;
  run: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const restore = trpc.documents.restore.useMutation();
  const softDelete = trpc.documents.delete.useMutation();
  return (
    <div className="row archived-row">
      <Link className="doc-title archived-title" to={`/d/${doc.id}`}>
        {doc.title || "Untitled"}
      </Link>
      {writable && (
        <span className="row-actions">
          <button
            className="row-action"
            title="Restore"
            onClick={() => void run(() => restore.mutateAsync({ id: doc.id }))}
          >
            ↩
          </button>
          <button
            className="row-action"
            title="Delete permanently"
            onClick={() => {
              if (window.confirm(`Delete "${doc.title || "Untitled"}"?`)) {
                void run(() => softDelete.mutateAsync({ id: doc.id }));
              }
            }}
          >
            ×
          </button>
        </span>
      )}
    </div>
  );
}
