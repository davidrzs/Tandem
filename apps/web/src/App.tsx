import { Suspense, useEffect, useState } from "react";
import { Outlet, useLocation, useMatch, useOutletContext } from "react-router-dom";
import { AdminModal } from "./components/AdminModal.js";
import { Icon } from "./components/Icon.js";
import { NotificationsModal } from "./components/NotificationsModal.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { friendlyError } from "./errors.js";
import { PeopleModal } from "./components/PeopleModal.js";
import { SearchModal } from "./components/SearchModal.js";
import { SettingsModal } from "./components/SettingsModal.js";
import { ShareModal } from "./components/ShareModal.js";
import { Sidebar } from "./components/Sidebar.js";
import { trpc } from "./trpc.js";

export interface CollectionInfo {
  id: string;
  name: string;
  workspaceId: string;
  defaultRole: string;
  writable: boolean;
  position: number;
}

export interface AppContext {
  workspaceId: string | null;
  collections: CollectionInfo[];
  /** Open the search modal, optionally prefilled (e.g. "#ml " to browse a tag). */
  openSearch: (query?: string) => void;
}

export function useAppContext(): AppContext {
  return useOutletContext<AppContext>();
}

export const WS_KEY = "tandem.workspace";

export function App() {
  const workspaces = trpc.workspaces.mine.useQuery();
  const collections = trpc.collections.list.useQuery();
  const [workspaceId, setWorkspaceId] = useState<string | null>(
    () => localStorage.getItem(WS_KEY) || null,
  );

  // Default to the first workspace once loaded; drop a stale stored id.
  useEffect(() => {
    const list = workspaces.data;
    if (!list || list.length === 0) return;
    if (!workspaceId || !list.some((w) => w.id === workspaceId)) {
      setWorkspaceId(list[0]!.id);
    }
  }, [workspaces.data, workspaceId]);
  useEffect(() => {
    if (workspaceId) localStorage.setItem(WS_KEY, workspaceId);
  }, [workspaceId]);

  // A deep link into another workspace's document switches the workspace.
  const docMatch = useMatch("/d/:docId");
  const activeDocId = docMatch?.params.docId ?? null;
  const activeMeta = trpc.documents.getMeta.useQuery(
    { id: activeDocId! },
    { enabled: !!activeDocId },
  );
  useEffect(() => {
    const ws = activeMeta.data?.workspaceId;
    if (ws && ws !== workspaceId) setWorkspaceId(ws);
  }, [activeMeta.data?.workspaceId, workspaceId]);

  // Narrow screens: the sidebar becomes an off-canvas drawer.
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setSidebarOpen(false), [location.pathname]);

  // null = closed; a string (possibly empty) = open, prefilled with that query.
  const [searchQuery, setSearchQuery] = useState<string | null>(null);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [shareCollectionId, setShareCollectionId] = useState<string | null>(null);

  // Cmd/Ctrl+K opens search from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchQuery((q) => (q === null ? "" : null));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (workspaces.error || collections.error) {
    const failed = workspaces.error ? workspaces : collections;
    return (
      <div className="error-panel">
        <h2>Couldn't load your workspace</h2>
        <p className="error-detail">{friendlyError(failed.error, "Please try again.")}</p>
        <button type="button" className="btn" onClick={() => void failed.refetch()}>
          Retry
        </button>
      </div>
    );
  }

  const wsCollections = (collections.data ?? []).filter(
    (c) => c.workspaceId === workspaceId,
  );
  const shareCollection =
    (collections.data ?? []).find((c) => c.id === shareCollectionId) ?? null;
  const context: AppContext = {
    workspaceId,
    collections: collections.data ?? [],
    openSearch: (query = "") => setSearchQuery(query),
  };

  return (
    <div className="app">
      <button type="button"
        className="hamburger"
        aria-label="Open menu"
        onClick={() => setSidebarOpen(true)}
      >
        <Icon name="menu" size={17} />
      </button>
      {sidebarOpen && (
        <div className="sidebar-scrim" onClick={() => setSidebarOpen(false)} />
      )}
      <Sidebar
        open={sidebarOpen}
        loading={workspaces.isLoading || collections.isLoading}
        workspaces={workspaces.data ?? []}
        workspaceId={workspaceId}
        collections={wsCollections}
        activeDocId={activeDocId}
        activeCollectionId={activeMeta.data?.collectionId ?? null}
        onSelectWorkspace={setWorkspaceId}
        onOpenSearch={() => setSearchQuery("")}
        onOpenInbox={() => setInboxOpen(true)}
        onOpenPeople={() => setPeopleOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenAdmin={() => setAdminOpen(true)}
        onShareCollection={setShareCollectionId}
      />
      <main className="main">
        <ErrorBoundary>
          {/* The document route is lazy-loaded; the sidebar stays put while its
              chunk arrives. */}
          <Suspense fallback={<div className="empty">Loading…</div>}>
            <Outlet context={context} />
          </Suspense>
        </ErrorBoundary>
      </main>
      {searchQuery !== null && (
        <SearchModal initialQuery={searchQuery} onClose={() => setSearchQuery(null)} />
      )}
      {inboxOpen && <NotificationsModal onClose={() => setInboxOpen(false)} />}
      {settingsOpen && (
        <SettingsModal workspaceId={workspaceId} onClose={() => setSettingsOpen(false)} />
      )}
      {peopleOpen && workspaceId && (
        <PeopleModal workspaceId={workspaceId} onClose={() => setPeopleOpen(false)} />
      )}
      {adminOpen && <AdminModal onClose={() => setAdminOpen(false)} />}
      {shareCollection && (
        <ShareModal
          collection={shareCollection}
          onClose={() => setShareCollectionId(null)}
        />
      )}
    </div>
  );
}
