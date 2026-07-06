import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import { useState } from "react";
import { Toggle } from "@tandem/editor";
import { Icon } from "./Icon.js";

/**
 * A collapsible section (serialized as <details>). The caret is chrome; the
 * summary and content are the node's editable children. Open/closed is local
 * component state (defaults open for editing) — it never mutates the document,
 * so a reader folding a section creates no edit and no blame.
 */
function ToggleView() {
  const [open, setOpen] = useState(true);
  return (
    <NodeViewWrapper className={"toggle" + (open ? " open" : " collapsed")}>
      <button
        type="button"
        className="toggle-caret"
        contentEditable={false}
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? "Collapse section" : "Expand section"}
      >
        <Icon name="chevron" className={"twist" + (open ? " open" : "")} size={14} />
      </button>
      <NodeViewContent className="toggle-inner" />
    </NodeViewWrapper>
  );
}

/** Shared Toggle node, rendered as a foldable section in the web editor. */
export const ClientToggle = Toggle.extend({
  addNodeView() {
    return ReactNodeViewRenderer(ToggleView);
  },
});
