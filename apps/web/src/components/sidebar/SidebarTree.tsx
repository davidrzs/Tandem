import { AssistiveTreeDescription } from "@headless-tree/react";
import type { CSSProperties } from "react";
import { Icon } from "../Icon.js";
import { TreeRow } from "./TreeRows.js";
import {
  INDENT_PX,
  ROW_PAD_PX,
  SidebarTreeContext,
  useSidebarTree,
  type SidebarTreeProps,
} from "./useSidebarTree.js";

export function SidebarTree({
  loading,
  onNewCollection,
  ...props
}: SidebarTreeProps & { loading: boolean; onNewCollection: () => void }) {
  const model = useSidebarTree(props);
  const { tree } = model;
  const container = tree.getContainerProps("Collections");
  return (
    <div className="section">
      <div className="section-title tree-toolbar">
        <span>Collections</span>
        <span className="toolbar-actions">
          <button type="button"
            className="row-action"
            title="Reveal active document" aria-label="Reveal active document"
            disabled={!model.canRevealActive}
            onClick={() => void model.revealActive()}
          >
            <Icon name="locate" />
          </button>
          <button type="button" className="row-action" title="Collapse all" aria-label="Collapse all" onClick={model.collapseAll}>
            <Icon name="collapse" />
          </button>
          <button type="button" className="row-action" title="New collection" aria-label="New collection" onClick={onNewCollection}>
            <Icon name="plus" />
          </button>
        </span>
      </div>
      {loading && <div className="side-note"><span className="shimmer">Loading…</span></div>}
      {!loading && props.collections.length === 0 && (
        <div className="side-note">No collections yet — create one.</div>
      )}
      <SidebarTreeContext.Provider value={model}>
        <div
          {...container}
          className="tree"
          style={{ ...container.style, "--tree-indent": `${INDENT_PX}px`, "--row-pad": `${ROW_PAD_PX}px` } as CSSProperties}
        >
          {tree.getItems().map((item) => (
            <TreeRow key={item.getKey()} item={item} />
          ))}
          <div className="tree-drag-line" style={tree.getDragLineStyle(-1, ROW_PAD_PX)} />
        </div>
        <AssistiveTreeDescription tree={tree} />
      </SidebarTreeContext.Provider>
    </div>
  );
}
