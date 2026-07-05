import { useEffect, useState } from "react";
import { Outlet, useMatch, useOutletContext } from "react-router-dom";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
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
}

export interface AppContext {
  workspaceId: string | null;
  collections: CollectionInfo[];
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

  const [searchOpen, setSearchOpen] = useState(false);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shareCollectionId, setShareCollectionId] = useState<string | null>(null);

  // Cmd/Ctrl+K opens search from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((s) => !s);
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
        <p className="error-detail">{failed.error?.message}</p>
        <button className="btn" onClick={() => void failed.refetch()}>
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
  };

  return (
    <div className="app">
      <Sidebar
        loading={workspaces.isLoading || collections.isLoading}
        workspaces={workspaces.data ?? []}
        workspaceId={workspaceId}
        collections={wsCollections}
        activeDocId={activeDocId}
        activeCollectionId={activeMeta.data?.collectionId ?? null}
        onSelectWorkspace={setWorkspaceId}
        onOpenSearch={() => setSearchOpen(true)}
        onOpenPeople={() => setPeopleOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onShareCollection={setShareCollectionId}
      />
      <main className="main">
        <ErrorBoundary>
          <Outlet context={context} />
        </ErrorBoundary>
      </main>
      {searchOpen && <SearchModal onClose={() => setSearchOpen(false)} />}
      {settingsOpen && (
        <SettingsModal workspaceId={workspaceId} onClose={() => setSettingsOpen(false)} />
      )}
      {peopleOpen && workspaceId && (
        <PeopleModal workspaceId={workspaceId} onClose={() => setPeopleOpen(false)} />
      )}
      {shareCollection && (
        <ShareModal
          collection={shareCollection}
          onClose={() => setShareCollectionId(null)}
        />
      )}
    </div>
  );
}
