import { Image } from "@realtime/editor";
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import { useRef } from "react";

/** Image with a drag handle that sets the display `width` (a layout attribute). */
function ImageView({ node, updateAttributes, selected, editor }: NodeViewProps) {
  const { src, alt, title, width } = node.attrs as {
    src: string;
    alt?: string;
    title?: string;
    width?: string | null;
  };
  const imgRef = useRef<HTMLImageElement>(null);

  function startResize(e: React.PointerEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = imgRef.current?.offsetWidth ?? 0;
    const onMove = (ev: PointerEvent) => {
      const w = Math.max(40, Math.round(startW + (ev.clientX - startX)));
      updateAttributes({ width: String(w) });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  return (
    <NodeViewWrapper className="img-node" data-selected={selected || undefined}>
      <img
        ref={imgRef}
        src={src}
        alt={alt ?? ""}
        title={title ?? undefined}
        style={{ width: width ? `${width}px` : undefined }}
        draggable={false}
      />
      {editor.isEditable && (
        <span className="img-resize-handle" onPointerDown={startResize} />
      )}
    </NodeViewWrapper>
  );
}

/** Client image extension: same schema as the server (inline + width), plus a
 * React NodeView for resizing. The NodeView is render-only — schema unchanged. */
export const ClientImage = Image.extend({
  addNodeView() {
    return ReactNodeViewRenderer(ImageView);
  },
}).configure({ inline: true });
