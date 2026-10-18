import { useRef, useState } from "react";
import type { Layout, LayoutChangedMeta, PanelImperativeHandle, PanelSize } from "react-resizable-panels";
import { storageGet, storageSet } from "../../storage.js";

export const SIDEBAR_WIDTH = { min: 200, max: 480, default: 248 } as const;
/** Main-pane width at which the contents rail fits in the gutter: the old
 * 1400px viewport breakpoint minus the default sidebar. */
const TOC_MIN_MAIN = 1152;
const WIDTH_KEY = "tandem.sidebar.width";

const clampWidth = (px: number) =>
  Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, Math.round(px)));

/** Props for the app shell's react-resizable-panels Group. The sidebar width
 * is persisted in pixels per user; the library's own useDefaultLayout stores
 * percentages, which would change the sidebar's width with the window. */
export function useShellLayout(uid: string) {
  const key = `${WIDTH_KEY}:${uid}`;
  const [defaultSize] = useState(() => {
    const stored = Number(storageGet(key));
    return stored > 0 ? clampWidth(stored) : SIDEBAR_WIDTH.default;
  });
  const [tocRoom, setTocRoom] = useState(false);
  const groupEl = useRef<HTMLDivElement>(null);
  const panelRef = useRef<PanelImperativeHandle>(null);
  const save = (px: number) => storageSet(key, String(clampWidth(px)));

  return {
    group: {
      orientation: "horizontal" as const,
      elementRef: groupEl,
      style: { height: "100vh" },
      onLayoutChanged: (_layout: Layout, meta: LayoutChangedMeta) => {
        const size = panelRef.current?.getSize().inPixels;
        if (meta.isUserInteraction && size) save(size);
      },
    },
    sidebarPanel: {
      id: "sidebar-pane",
      className: "sidebar-pane",
      panelRef,
      defaultSize,
      minSize: SIDEBAR_WIDTH.min,
      maxSize: SIDEBAR_WIDTH.max,
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
  };
}
