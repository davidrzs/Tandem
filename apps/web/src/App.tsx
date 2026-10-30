import * as Tooltip from "@radix-ui/react-tooltip";
import { Suspense, useEffect, useMemo, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { Outlet, useLocation, useMatch, useOutletContext } from "react-router-dom";
import { authClient } from "./auth-client.js";
import { AdminModal } from "./components/AdminModal.js";
import { Icon } from "./components/Icon.js";
import { NotificationsModal } from "./components/NotificationsModal.js";
import { ShortcutsModal } from "./components/ShortcutsModal.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { friendlyError } from "./errors.js";
import { PeopleModal } from "./components/PeopleModal.js";
import { SearchModal } from "./components/SearchModal.js";
import { SettingsModal } from "./components/SettingsModal.js";
import { ShareModal } from "./components/ShareModal.js";
import { Sidebar } from "./components/sidebar/Sidebar.js";
import { useShellLayout } from "./components/sidebar/useShellLayout.js";
import { trpc } from "./trpc.js";
import { storageGet, storageSet } from "./storage.js";

export interface CollectionInfo {
  id: string;
  name: string;
  description: string | null;
  workspaceId: string;
  defaultRole: string;
  writable: boolean;
  position: number;
}

export interface AppContext {
  workspaceId: string | null;
  collections: CollectionInfo[];
  collectionsLoading: boolean;
  /** Open the search modal, optionally prefilled (e.g. "#ml " to browse a tag). */
  openSearch: (query?: string) => void;
  openSettings: () => void;
}

export function useAppContext(): AppContext {
  return useOutletContext<AppContext>();
}

export const WS_KEY = "tandem.workspace";

export function App() {
  const workspaces = trpc.workspaces.mine.useQuery();
  const collections = trpc.collections.list.useQuery();
  const [workspaceId, setWorkspaceId] = useState<string | null>(
    () => storageGet(WS_KEY) || null,
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
    if (workspaceId) storageSet(WS_KEY, workspaceId);
  }, [workspaceId]);

  // A deep link into another workspace's document or collection switches the
  // workspace. Both canonical routes use immutable ids rather than slugs.
  const docMatch = useMatch("/d/:docId");
  const collectionMatch = useMatch("/c/:collectionId");
  const activeDocId = docMatch?.params.docId ?? null;
  const linkedCollectionId = collectionMatch?.params.collectionId ?? null;
  const activeMeta = trpc.documents.getMeta.useQuery(
    { id: activeDocId! },
    { enabled: !!activeDocId },
  );
  useEffect(() => {
    const ws = activeDocId
      ? activeMeta.data?.workspaceId
      : (collections.data ?? []).find((collection) => collection.id === linkedCollectionId)
          ?.workspaceId;
    if (ws && ws !== workspaceId) setWorkspaceId(ws);
  }, [activeDocId, activeMeta.data?.workspaceId, collections.data, linkedCollectionId, workspaceId]);

  // AuthGate only mounts the app with a session, so uid is stable here.
  const shell = useShellLayout(authClient.useSession().data?.user.id ?? "");

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
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [shareCollectionId, setShareCollectionId] = useState<string | null>(null);

  // Cmd/Ctrl+K opens search from anywhere; "?" (outside text fields) and
  // Cmd/Ctrl+/ open the shortcuts sheet.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchQuery((q) => (q === null ? "" : null));
        return;
      }
      const target = e.target as HTMLElement | null;
      const typing =
        !!target &&
        (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      if ((mod && e.key === "/") || (e.key === "?" && !mod && !e.altKey && !typing)) {
        e.preventDefault();
        setShortcutsOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The sidebar tree memoises on this array; a fresh filter() per render
  // would rebuild its index on every navigation.
  const wsCollections = useMemo(
    () => (collections.data ?? []).filter((c) => c.workspaceId === workspaceId),
    [collections.data, workspaceId],
  );

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

  const shareCollection =
    (collections.data ?? []).find((c) => c.id === shareCollectionId) ?? null;
  const context: AppContext = {
    workspaceId,
    collections: collections.data ?? [],
    collectionsLoading: collections.isLoading,
    openSearch: (query = "") => setSearchQuery(query),
    openSettings: () => setSettingsOpen(true),
  };

  return (
    <Tooltip.Provider delayDuration={450} skipDelayDuration={250} disableHoverableContent>
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
      <Group className="app" {...shell.group}>
        <Panel {...shell.sidebarPanel}>
          <Sidebar
            open={sidebarOpen}
            loading={workspaces.isLoading || collections.isLoading}
            workspaces={workspaces.data ?? []}
            workspaceId={workspaceId}
            collections={wsCollections}
            activeDocId={activeDocId}
            activeCollectionId={activeMeta.data?.collectionId ?? linkedCollectionId}
            onSelectWorkspace={setWorkspaceId}
            onOpenSearch={() => setSearchQuery("")}
            onOpenInbox={() => setInboxOpen(true)}
            onOpenPeople={() => setPeopleOpen(true)}
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenAdmin={() => setAdminOpen(true)}
            onOpenShortcuts={() => setShortcutsOpen(true)}
            onShareCollection={setShareCollectionId}
          />
        </Panel>
        <Separator {...shell.separator} />
        <Panel {...shell.mainPanel}>
          <main className="main" data-toc-room={shell.tocRoom || undefined}>
            <ErrorBoundary>
              {/* The document route is lazy-loaded; the sidebar stays put while its
                  chunk arrives. */}
              <Suspense fallback={<div className="empty"><span className="shimmer">Loading…</span></div>}>
                <Outlet context={context} />
              </Suspense>
            </ErrorBoundary>
          </main>
        </Panel>
      </Group>
      {searchQuery !== null && (
        <SearchModal
          initialQuery={searchQuery}
          workspaceId={workspaceId}
          collections={wsCollections}
          onOpenSettings={() => {
            setSearchQuery(null);
            setSettingsOpen(true);
          }}
          onClose={() => setSearchQuery(null)}
        />
      )}
      {inboxOpen && <NotificationsModal onClose={() => setInboxOpen(false)} />}
      {settingsOpen && (
        <SettingsModal workspaceId={workspaceId} onClose={() => setSettingsOpen(false)} />
      )}
      {peopleOpen && workspaceId && (
        <PeopleModal workspaceId={workspaceId} onClose={() => setPeopleOpen(false)} />
      )}
      {adminOpen && <AdminModal onClose={() => setAdminOpen(false)} />}
      {shortcutsOpen && <ShortcutsModal onClose={() => setShortcutsOpen(false)} />}
      {shareCollection && (
        <ShareModal
          collection={shareCollection}
          onClose={() => setShareCollectionId(null)}
        />
      )}
    </Tooltip.Provider>
  );
}
