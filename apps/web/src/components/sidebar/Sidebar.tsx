import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { authClient } from "../../auth-client.js";
import { friendlyError } from "../../errors.js";
import { trpc } from "../../trpc.js";
import { authorColor, authorKey } from "../colors.js";
import { Icon } from "../Icon.js";
import { PromptDialog } from "../Modal.js";
import { forgetUserDocs } from "../../offline.js";
import { CollectionSection } from "./CollectionSection.js";
import { FavoritesSection, InboxNavRow, ThemeToggle, WorkspaceSwitcher } from "./NavRows.js";
import type { Collection, Workspace } from "./types.js";
import { useFoldState } from "./useFoldState.js";

interface Props {
  loading: boolean;
  workspaces: Workspace[];
  workspaceId: string | null;
  collections: Collection[];
  activeDocId: string | null;
  activeCollectionId: string | null;
  /** Narrow screens: the sidebar is an off-canvas drawer; this opens it. */
  open?: boolean;
  onSelectWorkspace: (id: string) => void;
  onOpenSearch: () => void;
  onOpenInbox: () => void;
  onOpenPeople: () => void;
  onOpenSettings: () => void;
  onOpenShortcuts: () => void;
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
  open,
  onSelectWorkspace,
  onOpenSearch,
  onOpenInbox,
  onOpenPeople,
  onOpenSettings,
  onOpenShortcuts,
  onOpenAdmin,
  onShareCollection,
}: Props) {
  const utils = trpc.useUtils();
  const navigate = useNavigate();
  const session = authClient.useSession();
  const createWorkspace = trpc.workspaces.create.useMutation();
  const createCollection = trpc.collections.create.useMutation();

  // AuthGate only mounts the app with a session, so uid is stable for the
  // lifetime of this component (sign-out unmounts it).
  const uid = session.data?.user.id ?? "";

  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<ReactNode>(null);
  const { expanded, collapsedDocs, foldsReconciled, toggleCollection, toggleDoc, revealDocs } =
    useFoldState(uid, activeCollectionId);

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
    <aside className="sidebar" data-open={open || undefined}>
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
        <Link
          className={"nav-row" + (activeDocId || activeCollectionId ? "" : " active")}
          to="/"
        >
          <Icon name="home" />
          Home
        </Link>
        <button type="button" className="nav-row" onClick={onOpenSearch}>
          <Icon name="search" />
          Search
          <kbd>⌘K</kbd>
        </button>
        <InboxNavRow onOpen={onOpenInbox} />
        {workspaceId && (
          <button type="button" className="nav-row" onClick={onOpenPeople}>
            <Icon name="users" />
            People &amp; groups
          </button>
        )}
        <button type="button" className="nav-row" onClick={onOpenSettings}>
          <Icon name="settings" />
          Settings
        </button>
        <button type="button" className="nav-row" onClick={onOpenShortcuts}>
          <Icon name="keyboard" />
          Shortcuts
          <kbd>?</kbd>
        </button>
        {user?.role === "admin" && (
          <button type="button" className="nav-row" onClick={onOpenAdmin}>
            <Icon name="settings" />
            Admin
          </button>
        )}
      </nav>

      <div className="sidebar-scroll">
        <FavoritesSection workspaceId={workspaceId} activeDocId={activeDocId} />

        <div className="section">
          <div className="section-title">
            <span>Collections</span>
            <button type="button" className="row-action" title="New collection" aria-label="New collection" onClick={newCollection}>
              <Icon name="plus" />
            </button>
          </div>
          {loading && <div className="side-note">Loading…</div>}
          {!loading && collections.length === 0 && (
            <div className="side-note">No collections yet — create one.</div>
          )}
          {collections.map((c, i) => (
            <CollectionSection
              key={c.id}
              collection={c}
              siblings={collections}
              index={i}
              expanded={expanded.has(c.id)}
              activeDocId={activeDocId}
              collapsedDocs={collapsedDocs}
              foldsReconciled={foldsReconciled}
              onToggle={() => toggleCollection(c.id)}
              onToggleDoc={toggleDoc}
              onRevealDocs={revealDocs}
              onShare={() => onShareCollection(c.id)}
              onError={setError}
              setDialog={setDialog}
            />
          ))}
          {error && <div className="sidebar-error">{error}</div>}
        </div>
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
          <ThemeToggle />
          <button type="button"
            className="row-action"
            title="Sign out" aria-label="Sign out"
            // Full reload: drops the react-query cache (and any other
            // in-memory state) so the next account can't reconcile against
            // this session's snapshot. Same pattern as the 2FA challenge.
            onClick={() =>
              // End the session first (it matters most if the tab closes),
              // then drop this user's offline document copies.
              void authClient
                .signOut()
                .then(() => forgetUserDocs(uid))
                .then(() => window.location.assign("/"))
            }
          >
            <Icon name="signout" />
          </button>
        </div>
      )}

      {dialog}
    </aside>
  );
}
