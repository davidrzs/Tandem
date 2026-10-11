import type { Editor } from "@tiptap/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type * as Y from "yjs";
import { trpc } from "../../trpc.js";
import { anchorRange, commentsPluginKey, selectionAnchor, type CommentAnchor } from "../comments.js";
import type { CommentItem, PendingComment } from "../CommentsPanel.js";

/** Comment threads, their mutations, and the refs the decoration plugin
 * reads (it is created once with the editor). */
export function useComments(docId: string) {
  const utils = trpc.useUtils();
  const commentsQuery = trpc.comments.list.useQuery({ documentId: docId });
  const commentItems: CommentItem[] = useMemo(
    () => commentsQuery.data ?? [],
    [commentsQuery.data],
  );
  const createComment = trpc.comments.create.useMutation({
    onSuccess: () => utils.comments.list.invalidate({ documentId: docId }),
  });
  const resolveComment = trpc.comments.setResolved.useMutation({
    onSuccess: () => utils.comments.list.invalidate({ documentId: docId }),
  });
  const deleteComment = trpc.comments.delete.useMutation({
    onSuccess: () => utils.comments.list.invalidate({ documentId: docId }),
  });
  const [pending, setPending] = useState<PendingComment | null>(null);
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  // The decoration plugin reads anchors/active through refs (created once).
  const anchorsRef = useRef<CommentAnchor[]>([]);
  const activeCommentRef = useRef<string | null>(null);
  activeCommentRef.current = activeCommentId;
  useEffect(() => {
    anchorsRef.current = commentItems
      .filter((c) => !c.parentId && !c.resolvedAt && c.anchor && c.head)
      .map((c) => ({ id: c.id, anchor: c.anchor!, head: c.head! }));
  }, [commentItems]);

  return {
    commentItems,
    createComment,
    resolveComment,
    deleteComment,
    pending,
    setPending,
    activeCommentId,
    setActiveCommentId,
    anchorsRef,
    activeCommentRef,
  };
}

/** Editor-bound comment behaviour: highlight redraws, starting a thread from
 * the selection, jumping to a thread, and the ?comment= deep link. */
export function useCommentNavigation({
  editor,
  ydoc,
  synced,
  commentTarget,
  commentItems,
  activeCommentId,
  setPending,
  setActiveCommentId,
  setRail,
}: {
  editor: Editor | null;
  ydoc: Y.Doc;
  synced: boolean;
  commentTarget: string | null;
  commentItems: CommentItem[];
  activeCommentId: string | null;
  setPending: (pending: PendingComment | null) => void;
  setActiveCommentId: (id: string | null) => void;
  setRail: (rail: null | "comments" | "history") => void;
}) {
  // Redraw comment highlights when threads or the focused thread change.
  useEffect(() => {
    if (!editor) return;
    editor.view.dispatch(editor.state.tr.setMeta(commentsPluginKey, { recompute: true }));
  }, [editor, commentItems, activeCommentId]);

  const startComment = useCallback(() => {
    if (!editor) return;
    const anchors = selectionAnchor(editor.state);
    if (!anchors) return;
    const { from, to } = editor.state.selection;
    const quote = editor.state.doc.textBetween(from, to, " ").slice(0, 160);
    setPending({ ...anchors, quote });
    setRail("comments");
  }, [editor]);

  const jumpToComment = useCallback(
    (comment: CommentItem) => {
      setActiveCommentId(comment.id);
      if (!editor || !comment.anchor || !comment.head) return true;
      const range = anchorRange(editor.state, ydoc, comment.anchor, comment.head);
      if (!range) return false;
      editor.chain().setTextSelection(range).scrollIntoView().run();
      return true;
    },
    [editor, ydoc],
  );

  // Collaboration deep links are resolved only after both the editor binding
  // and the relevant server data are ready. The URL remains shareable; refs
  // prevent query refetches from repeatedly stealing the user's selection.
  const handledCommentTarget = useRef<string | null>(null);
  useEffect(() => {
    if (!commentTarget || !editor || !synced || handledCommentTarget.current === commentTarget) {
      return;
    }
    const target = commentItems.find((comment) => comment.id === commentTarget);
    if (!target) return;
    const thread = target.parentId
      ? commentItems.find((comment) => comment.id === target.parentId) ?? target
      : target;
    setRail("comments");
    if (!jumpToComment(thread)) return;
    handledCommentTarget.current = commentTarget;
    // Focus only for deep links: a click in the panel must not pull the
    // caret out of a reply the reader is in the middle of typing.
    editor.commands.focus();
  }, [commentItems, commentTarget, editor, jumpToComment, synced]);

  return { startComment, jumpToComment };
}
