import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { useNavigate } from "react-router-dom";
import { PageRef } from "@tandem/editor";
import { trpc } from "../trpc.js";
import { Icon } from "./Icon.js";

/**
 * A cross-reference chip. The node stores only the target's ID (+ a title
 * snapshot for markdown); this view shows the target's CURRENT title, so
 * renames propagate without editing the document — and moving the target
 * never matters at all, because the binding is the ID, not a path.
 */
function PageRefView({ node }: NodeViewProps) {
  const navigate = useNavigate();
  const docId = node.attrs.docId as string | null;
  const meta = trpc.documents.getMeta.useQuery(
    { id: docId! },
    { enabled: !!docId, staleTime: 30_000 },
  );
  // Target deleted or no longer visible to this reader: keep the snapshot
  // text, visibly inert.
  const missing = !!docId && meta.isFetched && !meta.data;
  const title =
    meta.data?.title || (node.attrs.title as string) || "Untitled";

  return (
    <NodeViewWrapper
      as="span"
      className={"page-ref" + (missing ? " missing" : "")}
      title={missing ? "This page is gone or not shared with you" : title}
      onClick={() => {
        if (docId && !missing) navigate(`/d/${docId}`);
      }}
    >
      <Icon name="page" size={12} />
      {title}
    </NodeViewWrapper>
  );
}

/** The shared PageRef node, rendered as a live chip in the web editor. */
export const ClientPageRef = PageRef.extend({
  addNodeView() {
    return ReactNodeViewRenderer(PageRefView);
  },
});
