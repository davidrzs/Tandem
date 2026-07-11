import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { useState } from "react";
import { Callout } from "@tandem/editor";
import { Icon, type IconName } from "./Icon.js";

const KNOWN = ["note", "tip", "warning", "important", "caution"];
const ICON: Record<string, IconName> = {
  note: "info",
  tip: "info",
  important: "info",
  warning: "alert",
  caution: "alert",
};
const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "Note");

/**
 * A callout box. The header (icon + type label) is chrome; the body is editable.
 * Collapsible callouts (Obsidian `-`/`+`) fold LOCALLY — the open/closed state is
 * component state and never written to the document, so folding one to read it
 * creates no edit and no blame.
 */
function CalloutView({ node, editor, updateAttributes }: NodeViewProps) {
  const type = String(node.attrs.type ?? "note");
  const collapsible = Boolean(node.attrs.collapsible);
  const [open, setOpen] = useState(!node.attrs.collapsed);
  const known = KNOWN.includes(type);
  const shown = !collapsible || open;
  return (
    <NodeViewWrapper className={`callout callout-${known ? type : "neutral"}`}>
      <div className="callout-head" contentEditable={false}>
        <Icon name={ICON[type] ?? "info"} size={15} />
        {editor.isEditable ? (
          // The flavor is a document attribute (`> [!type]` in markdown), so
          // changing it is a real, attributed edit — unlike folding.
          <select
            className="callout-type"
            value={type}
            aria-label="Callout type"
            onChange={(e) => updateAttributes({ type: e.target.value })}
          >
            {KNOWN.map((t) => (
              <option key={t} value={t}>
                {cap(t)}
              </option>
            ))}
            {!known && <option value={type}>{cap(type)}</option>}
          </select>
        ) : (
          <span className="callout-label">{cap(type)}</span>
        )}
        {collapsible && (
          <button
            type="button"
            className="callout-fold"
            onClick={() => setOpen((o) => !o)}
            aria-label={open ? "Collapse callout" : "Expand callout"}
          >
            <Icon name="chevron" className={"twist" + (open ? " open" : "")} size={13} />
          </button>
        )}
      </div>
      <NodeViewContent className="callout-body" style={shown ? undefined : { display: "none" }} />
    </NodeViewWrapper>
  );
}

/** Shared Callout node, rendered as a coloured box in the web editor. */
export const ClientCallout = Callout.extend({
  addNodeView() {
    return ReactNodeViewRenderer(CalloutView);
  },
});
