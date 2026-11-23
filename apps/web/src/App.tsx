import * as Tooltip from "@radix-ui/react-tooltip";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { Outlet, useLocation, useMatch, useOutletContext } from "react-router-dom";
import { authClient } from "./auth-client.js";
import { Icon } from "./components/Icon.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { friendlyError } from "./errors.js";
import { SearchModal } from "./components/SearchModal.js";
import { Sidebar } from "./components/sidebar/Sidebar.js";
import { useShellLayout } from "./components/sidebar/useShellLayout.js";
import { trpc } from "./trpc.js";
import { storageGet, storageSet } from "./storage.js";

// Dialogs load on first open: they are rarely used and kept out of the first page.
const AdminModal = lazy(() => import("./components/AdminModal.js").then((m) => ({ default: m.AdminModal })));
const NotificationsModal = lazy(() =>
  import("./components/NotificationsModal.js").then((m) => ({ default: m.NotificationsModal })),
);
const PeopleModal = lazy(() => import("./components/PeopleModal.js").then((m) => ({ default: m.PeopleModal })));
const SettingsModal = lazy(() => import("./components/SettingsModal.js").then((m) => ({ default: m.SettingsModal })));
const ShareModal = lazy(() => import("./components/ShareModal.js").then((m) => ({ default: m.ShareModal })));
const ShortcutsModal = lazy(() =>
  import("./components/ShortcutsModal.js").then((m) => ({ default: m.ShortcutsModal })),
);

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
  /** Document pages hide the sidebar unless pinned; this shows or hides it. */
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  /** Open sharing for a collection (documents inherit their collection's). */
  openShare: (collectionId: string) => void;
}

export function useAppContext(): AppContext {
  return useOutletContext<AppContext>();
}

export const WS_KEY = "tandem.workspace";

export function App() {
  const workspaces = trpc.workspaces.mine.useQuery();
  const collections = trpc.collections.list.useQuery();
  const [chosenWorkspaceId, setWorkspaceId] = useState<string | null>(
    () => storageGet(WS_KEY) || null,
  );
  // Derived, not synced in an effect (which rendered the shell once with the
  // stale id first): the chosen workspace if it still exists, else the first.
  const workspaceId = useMemo(() => {
    const list = workspaces.data;
    if (!list || list.length === 0) return chosenWorkspaceId;
    return list.some((w) => w.id === chosenWorkspaceId) ? chosenWorkspaceId : list[0]!.id;
  }, [workspaces.data, chosenWorkspaceId]);
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
  const shell = useShellLayout(authClient.useSession().data?.user.id ?? "", !!activeDocId);

  // A collapsed sidebar slides back over the page while the pointer rests at
  // the window's left edge, and away once it leaves.
  const [peek, setPeek] = useState(false);
  const peekTimer = useRef<ReturnType<typeof setTimeout>>();
  const peekOpen = () => {
    clearTimeout(peekTimer.current);
    setPeek(true);
  };
  const peekClose = () => {
    clearTimeout(peekTimer.current);
    peekTimer.current = setTimeout(() => setPeek(false), 250);
  };
  useEffect(() => () => clearTimeout(peekTimer.current), []);

  // Narrow screens: the sidebar becomes an off-canvas drawer.
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const location = useLocation();
  useEffect(() => {
    setSidebarOpen(false);
    setPeek(false);
  }, [location.pathname]);
  useEffect(() => {
    if (!shell.collapsed) setPeek(false);
  }, [shell.collapsed]);

  // null = closed; a string (possibly empty) = open, prefilled with that query.
  const [searchQuery, setSearchQuery] = useState<string | null>(null);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [shareCollectionId, setShareCollectionId] = useState<string | null>(null);

  // The listener below is bound once; the toggle it calls is current.
  const toggleSidebar = useRef(shell.toggle);
  toggleSidebar.current = shell.toggle;

  // Cmd/Ctrl+K opens search from anywhere; Cmd/Ctrl+\ shows or hides the
  // sidebar; "?" (outside text fields) and
  // Cmd/Ctrl+/ open the shortcuts sheet.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchQuery((q) => (q === null ? "" : null));
        return;
      }
      if (mod && e.key === "\\") {
        e.preventDefault();
        toggleSidebar.current();
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
    sidebarCollapsed: shell.collapsed,
    toggleSidebar: shell.toggle,
    openShare: setShareCollectionId,
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
      {shell.collapsed && (
        <div className="sidebar-peek-zone" aria-hidden onMouseEnter={peekOpen} onMouseLeave={peekClose} />
      )}
      <Group className="app" data-sidebar-collapsed={shell.collapsed || undefined} {...shell.group}>
        <Panel {...shell.sidebarPanel}>
          <Sidebar
            open={sidebarOpen}
            peek={shell.collapsed && peek}
            onPeekEnter={peekOpen}
            onPeekLeave={peekClose}
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
      <Suspense fallback={null}>
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
      </Suspense>
    </Tooltip.Provider>
  );
}
