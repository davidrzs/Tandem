import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { authClient } from "../auth-client.js";
import { friendlyError } from "../errors.js";
import { trpc } from "../trpc.js";
import { authorColor, authorKey } from "./colors.js";
import { Icon } from "./Icon.js";
import { ConfirmDialog, PromptDialog, RowMenu } from "./Modal.js";
import { useToast } from "./toast.js";

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
  onOpenSettings: () => void;
  onOpenAdmin: () => void;
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
  onOpenSettings,
  onOpenAdmin,
  onShareCollection,
}: Props) {
  const utils = trpc.useUtils();
  const navigate = useNavigate();
  const session = authClient.useSession();
  const createWorkspace = trpc.workspaces.create.useMutation();
  const createCollection = trpc.collections.create.useMutation();

  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<ReactNode>(null);
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
      setError(friendlyError(e));
    }
  };

  const closeDialog = () => setDialog(null);

  const newWorkspace = () =>
    setDialog(
      <PromptDialog
        title="New workspace"
        label="Name"
        submitLabel="Create workspace"
        placeholder="e.g. Lab wiki"
        onClose={closeDialog}
        onSubmit={(name) =>
          void run(async () => {
            const ws = await createWorkspace.mutateAsync({ name, slug: slugify(name) });
            await utils.workspaces.mine.invalidate();
            onSelectWorkspace(ws.id);
          })
        }
      />,
    );

  const newCollection = () =>
    setDialog(
      <PromptDialog
        title="New collection"
        label="Name"
        submitLabel="Create collection"
        placeholder="e.g. Research notes"
        onClose={closeDialog}
        onSubmit={(name) =>
          void run(async () => {
            await createCollection.mutateAsync({
              name,
              slug: slugify(name),
              ...(workspaceId ? { workspaceId } : {}),
            });
            await utils.collections.list.invalidate();
          })
        }
      />,
    );

  const user = session.data?.user;

  return (
    <aside className="sidebar">
      <WorkspaceSwitcher
        workspaces={workspaces}
        workspaceId={workspaceId}
        onSelect={(id) => {
          onSelectWorkspace(id);
          navigate("/");
        }}
        onNew={newWorkspace}
      />

      <nav className="side-nav">
        <Link className={"nav-row" + (activeDocId ? "" : " active")} to="/">
          <Icon name="home" />
          Home
        </Link>
        <button className="nav-row" onClick={onOpenSearch}>
          <Icon name="search" />
          Search
          <kbd>⌘K</kbd>
        </button>
        {workspaceId && (
          <button className="nav-row" onClick={onOpenPeople}>
            <Icon name="users" />
            People &amp; groups
          </button>
        )}
        <button className="nav-row" onClick={onOpenSettings}>
          <Icon name="settings" />
          Settings
        </button>
        {user?.role === "admin" && (
          <button className="nav-row" onClick={onOpenAdmin}>
            <Icon name="settings" />
            Admin
          </button>
        )}
      </nav>

      <div className="section">
        <div className="section-title">
          <span>Collections</span>
          <button className="row-action" title="New collection" aria-label="New collection" onClick={newCollection}>
            <Icon name="plus" />
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
            setDialog={setDialog}
          />
        ))}
        {error && <div className="sidebar-error">{error}</div>}
      </div>

      {user && (
        <div className="sidebar-footer">
          <span
            className="avatar"
            style={{ background: authorColor(authorKey(user.id, false)) }}
          >
            {(user.name || user.email).slice(0, 1).toUpperCase()}
          </span>
          <span className="user-meta">
            <span className="user-name">{user.name}</span>
            <span className="user-email">{user.email}</span>
          </span>
          <button
            className="row-action"
            title="Sign out" aria-label="Sign out"
            onClick={() => void authClient.signOut()}
          >
            <Icon name="signout" />
          </button>
        </div>
      )}

      {dialog}
    </aside>
  );
}

function WorkspaceSwitcher({
  workspaces,
  workspaceId,
  onSelect,
  onNew,
}: {
  workspaces: Workspace[];
  workspaceId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  const active = workspaces.find((w) => w.id === workspaceId);

  return (
    <div className="ws-switcher">
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger asChild>
          <button className="ws-button">
            <span className="ws-mark">{(active?.name ?? "…").slice(0, 1).toUpperCase()}</span>
            <span className="ws-name">{active?.name ?? "Select a workspace"}</span>
            <Icon name="chevron" className="ws-chevron" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="menu-pop ws-menu" align="start" sideOffset={4}>
            {workspaces.map((w) => (
              <DropdownMenu.Item
                key={w.id}
                className="menu-item"
                onSelect={() => {
                  if (w.id !== workspaceId) onSelect(w.id);
                }}
              >
                <span className="menu-check">
                  {w.id === workspaceId && <Icon name="check" />}
                </span>
                {w.name}
              </DropdownMenu.Item>
            ))}
            <DropdownMenu.Separator className="menu-sep" />
            <DropdownMenu.Item className="menu-item" onSelect={onNew}>
              <span className="menu-check">
                <Icon name="plus" />
              </span>
              New workspace
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}

function CollectionSection({
  collection,
  expanded,
  activeDocId,
  onToggle,
  onShare,
  onError,
  setDialog,
}: {
  collection: Collection;
  expanded: boolean;
  activeDocId: string | null;
  onToggle: () => void;
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
  const createDoc = trpc.documents.create.useMutation();
  const renameCollection = trpc.collections.update.useMutation();
  const deleteCollection = trpc.collections.delete.useMutation();
  const [showArchived, setShowArchived] = useState(false);

  const refresh = () =>
    Promise.all([
      utils.documents.tree.invalidate({ collectionId: collection.id }),
      utils.documents.listArchived.invalidate({ collectionId: collection.id }),
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
      <div className={"collection-row" + (expanded ? " open" : "")}>
        <button className="collection-name" onClick={onToggle}>
          <Icon name="chevron" className={"twist" + (expanded ? " open" : "")} />
          <span className="collection-label">{collection.name}</span>
        </button>
        <span className="row-actions">
          {collection.writable && (
            <button className="row-action" title="New document" aria-label="New document" onClick={() => void newDoc()}>
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
              <button className="side-link" onClick={() => void tree.refetch()}>
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
              onNewChild={(id) => void newDoc(id)}
              run={run}
              setDialog={setDialog}
            />
          </div>
          {(archived.data?.length ?? 0) > 0 && (
            <>
              <button
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
                    setDialog={setDialog}
                  />
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
  setDialog,
}: {
  nodes: DocNode[];
  parentId: string | null;
  collectionId: string;
  writable: boolean;
  activeDocId: string | null;
  depth: number;
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
  onNewChild: (parentId: string) => void;
  run: (fn: () => Promise<unknown>) => Promise<void>;
  setDialog: (node: ReactNode) => void;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const move = trpc.documents.move.useMutation();
  const archive = trpc.documents.archive.useMutation();
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
          "doc-row" +
          (node.id === activeDocId ? " active" : "") +
          (dropMode ? ` drop-${dropMode}` : "")
        }
        style={{ paddingLeft: 9 + depth * 14 }}
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
                      toast(`Archived "${node.title || "Untitled"}" — restorable below`);
                      if (node.id === activeDocId) navigate("/");
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
          setDialog={setDialog}
        />
      )}
    </div>
  );
}

function ArchivedRow({
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
          <button
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
          <button
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
