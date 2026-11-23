import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useState } from "react";
import { Link } from "react-router-dom";
import { trpc } from "../../trpc.js";
import { effectiveTheme, setTheme, type ThemeChoice } from "../../theme.js";
import { Icon, type IconName } from "../Icon.js";
import { RollingNumber } from "../motion.js";
import { OverflowTooltip } from "../OverflowTooltip.js";
import { displayTitle } from "../outline.js";
import type { Workspace } from "./types.js";

/** An entry in the workspace menu above the workspace list. */
export interface WorkspaceMenuEntry {
  label: string;
  icon: IconName;
  onSelect: () => void;
  hint?: string;
}

/** The workspace's name opens its menu: the workspace-wide places that are
 * visited now and then (people, shortcuts, admin, theme), then the switch to
 * another workspace. */
export function WorkspaceSwitcher({
  workspaces,
  workspaceId,
  entries,
  onSelect,
  onNew,
}: {
  workspaces: Workspace[];
  workspaceId: string | null;
  entries: WorkspaceMenuEntry[];
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  const active = workspaces.find((w) => w.id === workspaceId);
  const [theme, setThemeState] = useState<ThemeChoice>(() => effectiveTheme());
  const nextTheme = theme === "dark" ? "light" : "dark";

  return (
    <div className="ws-switcher">
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger asChild>
          <button type="button" className="ws-button">
            <span className="ws-mark">{(active?.name ?? "…").slice(0, 1).toUpperCase()}</span>
            <span className="ws-name">{active?.name ?? "Select a workspace"}</span>
            <Icon name="updown" className="ws-chevron" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="menu-pop ws-menu" align="start" sideOffset={4}>
            {entries.map((e) => (
              <DropdownMenu.Item key={e.label} className="menu-item" onSelect={e.onSelect}>
                <span className="menu-check">
                  <Icon name={e.icon} />
                </span>
                {e.label}
                {e.hint && <kbd className="menu-hint">{e.hint}</kbd>}
              </DropdownMenu.Item>
            ))}
            <DropdownMenu.Item
              className="menu-item"
              onSelect={() => {
                setTheme(nextTheme);
                setThemeState(nextTheme);
              }}
            >
              <span className="menu-check">
                <Icon name={theme === "dark" ? "sun" : "moon"} />
              </span>
              {theme === "dark" ? "Light theme" : "Dark theme"}
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="menu-sep" />
            <DropdownMenu.Label className="menu-heading">Workspaces</DropdownMenu.Label>
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

/** Inbox nav entry with a live unread badge (polled — notifications have no
 * push channel; the count also refreshes on window focus). */
export function InboxNavRow({ onOpen }: { onOpen: () => void }) {
  const unread = trpc.notifications.unreadCount.useQuery(undefined, {
    refetchInterval: 60_000,
  });
  const count = unread.data ?? 0;
  return (
    <button type="button" className="nav-row" onClick={onOpen}>
      <Icon name="bell" />
      Inbox
      {count > 0 && <span className="nav-badge">{count > 99 ? "99+" : <RollingNumber value={count} />}</span>}
    </button>
  );
}

/** Starred documents in the current workspace — hidden when there are none. */
export function FavoritesSection({
  workspaceId,
  activeDocId,
}: {
  workspaceId: string | null;
  activeDocId: string | null;
}) {
  const favorites = trpc.favorites.list.useQuery();
  const mine = (favorites.data ?? []).filter(
    (f) => f.workspaceId === workspaceId && !f.archivedAt,
  );
  if (mine.length === 0) return null;
  return (
    <div className="section">
      <div className="section-title">
        <span>Favorites</span>
      </div>
      {mine.map((f) => (
        <Link
          key={f.id}
          to={`/d/${f.id}`}
          className={"doc-row favorite-row" + (f.id === activeDocId ? " active" : "")}
        >
          <Icon name="star" size={12} />
          <OverflowTooltip text={displayTitle(f)}>
            <span className="doc-title">{displayTitle(f)}</span>
          </OverflowTooltip>
        </Link>
      ))}
    </div>
  );
}
