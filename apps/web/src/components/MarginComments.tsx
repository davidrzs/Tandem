import type { Editor } from "@tiptap/react";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import type * as Y from "yjs";
import { authorColor, authorKey } from "./colors.js";
import { anchorRange } from "./comments.js";
import { type CommentItem, Composer, type PendingComment, Thread } from "./CommentsPanel.js";
import { layoutMargin } from "./margin-layout.js";
import { timeAgo } from "./time.js";

const PENDING = "pending";
/** Height assumed for a card before it has been measured. */
const UNMEASURED = 72;

function sameMap(a: Map<string, number>, b: Map<string, number>) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (Math.abs((b.get(k) ?? Number.NaN) - v) > 0.5) return false;
  return true;
}

/**
 * Open threads beside the text they discuss, in the right margin of `frame`
 * (the element wrapping the editor). The active thread opens in full at its
 * anchor; the rest are one-glance summaries that make way for it. Threads
 * whose text is gone, and resolved ones, live only in the comments panel.
 */
export function MarginComments({
  editor,
  ydoc,
  frame,
  comments,
  pending,
  activeId,
  meId,
  canEdit,
  onOpen,
  onSubmit,
  onCancelPending,
  onReply,
  onResolve,
  onDelete,
}: {
  editor: Editor;
  ydoc: Y.Doc;
  frame: RefObject<HTMLElement>;
  comments: CommentItem[];
  pending: PendingComment | null;
  activeId: string | null;
  meId: string | null;
  canEdit: boolean;
  onOpen: (thread: CommentItem) => void;
  onSubmit: (body: string) => void;
  onCancelPending: () => void;
  onReply: (parentId: string, body: string) => void;
  onResolve: (id: string, resolved: boolean) => Promise<unknown>;
  onDelete: (id: string) => void;
}) {
  const threads = useMemo(
    () => comments.filter((c) => !c.parentId && !c.resolvedAt && c.anchor && c.head),
    [comments],
  );
  const replyCount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of comments) if (c.parentId) counts.set(c.parentId, (counts.get(c.parentId) ?? 0) + 1);
    return counts;
  }, [comments]);

  // Where each anchor sits, re-read after any document change (local or a
  // collaborator's) and whenever the frame reflows.
  const [anchorYs, setAnchorYs] = useState<Map<string, number>>(() => new Map());
  useEffect(() => {
    let raf = 0;
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const el = frame.current;
        if (!el) return;
        const origin = el.getBoundingClientRect().top;
        const yOf = (anchor: string, head: string) => {
          const range = anchorRange(editor.state, ydoc, anchor, head);
          if (!range || range.to > editor.state.doc.content.size) return null;
          return editor.view.coordsAtPos(range.from).top - origin;
        };
        const next = new Map<string, number>();
        for (const t of threads) {
          const y = yOf(t.anchor!, t.head!);
          if (y !== null) next.set(t.id, y);
        }
        if (pending) {
          const y = yOf(pending.anchor, pending.head);
          if (y !== null) next.set(PENDING, y);
        }
        setAnchorYs((prev) => (sameMap(prev, next) ? prev : next));
      });
    };
    measure();
    editor.on("update", measure);
    const observer = new ResizeObserver(measure);
    if (frame.current) observer.observe(frame.current);
    return () => {
      cancelAnimationFrame(raf);
      editor.off("update", measure);
      observer.disconnect();
    };
  }, [editor, ydoc, frame, threads, pending]);

  // Card heights, observed: a card grows when its reply box opens.
  const [heights, setHeights] = useState<Map<string, number>>(() => new Map());
  const slots = useRef(new Map<string, HTMLElement>());
  const observer = useRef<ResizeObserver>();
  if (!observer.current && typeof ResizeObserver !== "undefined") {
    observer.current = new ResizeObserver(() => {
      const next = new Map<string, number>();
      for (const [key, el] of slots.current) next.set(key, el.offsetHeight);
      setHeights((prev) => (sameMap(prev, next) ? prev : next));
    });
  }
  useEffect(() => () => observer.current?.disconnect(), []);
  // One stable ref callback per card, so re-renders don't re-observe.
  const refs = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const slotRef = (key: string) => {
    let ref = refs.current.get(key);
    if (!ref) {
      ref = (el) => {
        const prev = slots.current.get(key);
        if (prev) observer.current?.unobserve(prev);
        slots.current.delete(key);
        if (el) {
          slots.current.set(key, el);
          observer.current?.observe(el);
        } else {
          refs.current.delete(key);
        }
      };
      refs.current.set(key, ref);
    }
    return ref;
  };

  const activeKey = pending && anchorYs.has(PENDING) ? PENDING : activeId;
  const tops = layoutMargin(
    [...anchorYs].map(([key, y]) => ({ key, y, h: heights.get(key) ?? UNMEASURED })),
    activeKey,
  );
  const byId = new Map(threads.map((t) => [t.id, t]));

  return (
    <div className="margin-comments">
      {[...tops].map(([key, top]) => {
        const thread = byId.get(key);
        return (
          <div
            key={key}
            ref={slotRef(key)}
            className={"margin-slot" + (key === activeKey ? " active" : "")}
            style={{ transform: `translateY(${top}px)` }}
          >
            {key === PENDING ? (
              <div className="comment-thread pending">
                <Composer
                  autoFocus
                  placeholder="Comment…"
                  submitLabel="Comment"
                  onSubmit={onSubmit}
                  onCancel={onCancelPending}
                />
              </div>
            ) : !thread ? null : key === activeId ? (
              <Thread
                thread={thread}
                replies={comments.filter((c) => c.parentId === thread.id)}
                meId={meId}
                canEdit={canEdit}
                active
                onReply={onReply}
                onResolve={onResolve}
                onDelete={onDelete}
                onJumpTo={onOpen}
              />
            ) : (
              <button
                type="button"
                className="comment-thread margin-summary"
                data-comment-id={thread.id}
                onClick={() => onOpen(thread)}
              >
                <span className="comment-meta">
                  <span
                    className="avatar small"
                    style={{ background: authorColor(authorKey(thread.authorId, false)) }}
                  >
                    {thread.authorName.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="comment-author">{thread.authorName}</span>
                  <span className="comment-when">{timeAgo(thread.createdAt)}</span>
                </span>
                <span className="margin-snippet">{thread.body}</span>
                {(replyCount.get(thread.id) ?? 0) > 0 && (
                  <span className="margin-replies">
                    {replyCount.get(thread.id)} {replyCount.get(thread.id) === 1 ? "reply" : "replies"}
                  </span>
                )}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
