import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { Layout, LayoutChangedMeta, PanelImperativeHandle, PanelSize } from "react-resizable-panels";
import { storageGet, storageSet } from "../../storage.js";

export const SIDEBAR_WIDTH = { min: 200, max: 480, default: 248 } as const;
/** Main-pane width at which the contents rail fits in the gutter: the old
 * 1400px viewport breakpoint minus the default sidebar. */
const TOC_MIN_MAIN = 1152;
const WIDTH_KEY = "tandem.sidebar.width";
/** "0" tucks the sidebar away on document pages; anything else keeps it open.
 * A display preference of this device, like the theme, so it is not per user. */
export const PIN_KEY = "tandem.sidebar.pinned";

const clampWidth = (px: number) =>
  Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, Math.round(px)));

/** Props for the app shell's react-resizable-panels Group. The sidebar width
 * is persisted in pixels per user; the library's own useDefaultLayout stores
 * percentages, which would change the sidebar's width with the window.
 *
 * On a document page the reader can tuck the sidebar away (it then peeks in
 * from the left edge); it stays open until they do. Anywhere else it is
 * always open. Dragging it shut or open counts as the same toggle. */
export function useShellLayout(uid: string, onDoc: boolean) {
  const key = `${WIDTH_KEY}:${uid}`;
  const [defaultSize] = useState(() => {
    const stored = Number(storageGet(key));
    return stored > 0 ? clampWidth(stored) : SIDEBAR_WIDTH.default;
  });
  const [tocRoom, setTocRoom] = useState(false);
  const groupEl = useRef<HTMLDivElement>(null);
  const panelRef = useRef<PanelImperativeHandle>(null);
  const save = (px: number) => storageSet(key, String(clampWidth(px)));

  const [pinned, setPinned] = useState(() => storageGet(PIN_KEY) !== "0");
  const collapsed = onDoc && !pinned;
  // Read by onResize, which the library captures once.
  const state = useRef({ collapsed, onDoc });
  state.current = { collapsed, onDoc };
  const setOpen = useCallback((open: boolean) => {
    // Off a document page the sidebar is always open; only the pin is stored.
    if (!state.current.onDoc) return;
    setPinned(open);
    storageSet(PIN_KEY, open ? "1" : "0");
  }, []);
  const toggle = useCallback(() => setOpen(state.current.collapsed), [setOpen]);

  // Layout, not passive: entering a document should not paint a frame with
  // the sidebar still open. The panel may only register that it is
  // collapsible (onDoc) after this runs, so settle once more next frame.
  useLayoutEffect(() => {
    const apply = () => {
      const panel = panelRef.current;
      if (!panel) return;
      if (collapsed && !panel.isCollapsed()) panel.collapse();
      if (!collapsed && panel.isCollapsed()) panel.expand();
    };
    apply();
    const frame = requestAnimationFrame(apply);
    return () => cancelAnimationFrame(frame);
  }, [collapsed]);

  return {
    group: {
      orientation: "horizontal" as const,
      elementRef: groupEl,
      style: { height: "100dvh" },
      onLayoutChanged: (_layout: Layout, meta: LayoutChangedMeta) => {
        if (!meta.isUserInteraction) return;
        const size = panelRef.current?.getSize().inPixels ?? 0;
        if (size) save(size);
        // Dragging past the collapse threshold, or back out of it, is the
        // same as the toggle. Only the reader's own drags count: the library
        // also re-lays out when constraints change.
        if ((size === 0) !== state.current.collapsed) setOpen(size > 0);
      },
    },
    sidebarPanel: {
      id: "sidebar-pane",
      className: "sidebar-pane",
      panelRef,
      defaultSize,
      minSize: SIDEBAR_WIDTH.min,
      maxSize: SIDEBAR_WIDTH.max,
      // Only a document page lets the sidebar collapse; elsewhere a drag stops
      // at the minimum width.
      collapsible: onDoc,
      collapsedSize: 0,
      groupResizeBehavior: "preserve-pixel-size" as const,
      style: { overflow: "visible" },
      // A CSS variable rather than state: the contents rail follows the edge
      // without a re-render per pixel of drag.
      onResize: (size: PanelSize) =>
        groupEl.current?.style.setProperty("--sidebar-width", `${size.inPixels}px`),
    },
    separator: {
      className: "sidebar-resizer",
      "aria-label": "Resize sidebar",
      // The library's double-click restores defaultSize, which is the
      // persisted width; reset to the real default instead.
      disableDoubleClick: true,
      onDoubleClick: () => {
        panelRef.current?.resize(SIDEBAR_WIDTH.default);
        save(SIDEBAR_WIDTH.default);
      },
    },
    mainPanel: {
      id: "main-pane",
      className: "main-pane",
      style: { overflow: "hidden" },
      onResize: (size: PanelSize) => setTocRoom(size.inPixels >= TOC_MIN_MAIN),
    },
    tocRoom,
    collapsed,
    toggle,
  };
}
