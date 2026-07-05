import { useEffect, useRef, useState } from "react";
import { authorColor, authorKey } from "./colors.js";
import { Icon } from "./Icon.js";
import { timeAgo } from "./time.js";

export interface CommentItem {
  id: string;
  parentId: string | null;
  authorId: string;
  authorName: string;
  body: string;
  anchor: string | null;
  head: string | null;
  createdAt: string | Date;
  resolvedAt: string | Date | null;
}

export interface PendingComment {
  anchor: string;
  head: string;
  quote: string;
}

/** The discussion rail: one card per thread, replies inline, resolved tucked
 * behind a toggle. */
export function CommentsPanel({
  comments,
  pending,
  meId,
  canEdit,
  activeId,
  onSubmit,
  onCancelPending,
  onReply,
  onResolve,
  onDelete,
  onJumpTo,
  onClose,
}: {
  comments: CommentItem[];
  pending: PendingComment | null;
  meId: string | null;
  canEdit: boolean;
  activeId: string | null;
  onSubmit: (body: string) => void;
  onCancelPending: () => void;
  onReply: (parentId: string, body: string) => void;
  onResolve: (id: string, resolved: boolean) => void;
  onDelete: (id: string) => void;
  onJumpTo: (comment: CommentItem) => void;
  onClose: () => void;
}) {
  const [showResolved, setShowResolved] = useState(false);
  const threads = comments.filter((c) => !c.parentId);
  const open = threads.filter((t) => !t.resolvedAt);
  const resolved = threads.filter((t) => t.resolvedAt);
  const replies = (id: string) => comments.filter((c) => c.parentId === id);

  return (
    <aside className="comments-panel">
      <div className="comments-head">
        <h2>Comments</h2>
        <button className="row-action" title="Close comments" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>

      {pending && (
        <div className="comment-thread pending">
          <blockquote className="comment-quote">{pending.quote}</blockquote>
          <Composer
            autoFocus
            placeholder="Comment…"
            submitLabel="Comment"
            onSubmit={onSubmit}
            onCancel={onCancelPending}
          />
        </div>
      )}

      {open.length === 0 && !pending && (
        <p className="comments-empty">
          No open comments. Select some text and press "Comment" to start a
          discussion.
        </p>
      )}

      {open.map((thread) => (
        <Thread
          key={thread.id}
          thread={thread}
          replies={replies(thread.id)}
          meId={meId}
          canEdit={canEdit}
          active={activeId === thread.id}
          onReply={onReply}
          onResolve={onResolve}
          onDelete={onDelete}
          onJumpTo={onJumpTo}
        />
      ))}

      {resolved.length > 0 && (
        <button className="home-toggle" onClick={() => setShowResolved((s) => !s)}>
          {showResolved ? "Hide" : "Show"} {resolved.length} resolved
        </button>
      )}
      {showResolved &&
        resolved.map((thread) => (
          <Thread
            key={thread.id}
            thread={thread}
            replies={replies(thread.id)}
            meId={meId}
            canEdit={canEdit}
            active={activeId === thread.id}
            onReply={onReply}
            onResolve={onResolve}
            onDelete={onDelete}
            onJumpTo={onJumpTo}
          />
        ))}
    </aside>
  );
}

function Thread({
  thread,
  replies,
  meId,
  canEdit,
  active,
  onReply,
  onResolve,
  onDelete,
  onJumpTo,
}: {
  thread: CommentItem;
  replies: CommentItem[];
  meId: string | null;
  canEdit: boolean;
  active: boolean;
  onReply: (parentId: string, body: string) => void;
  onResolve: (id: string, resolved: boolean) => void;
  onDelete: (id: string) => void;
  onJumpTo: (comment: CommentItem) => void;
}) {
  const [replying, setReplying] = useState(false);
  const resolvedState = !!thread.resolvedAt;
  const canResolve = canEdit || thread.authorId === meId;

  return (
    <div
      className={
        "comment-thread" + (active ? " active" : "") + (resolvedState ? " resolved" : "")
      }
      onClick={() => onJumpTo(thread)}
    >
      <CommentBody comment={thread} mine={thread.authorId === meId} onDelete={onDelete}>
        {canResolve && (
          <button
            className="row-action"
            title={resolvedState ? "Reopen" : "Resolve"}
            onClick={(e) => {
              e.stopPropagation();
              onResolve(thread.id, !resolvedState);
            }}
          >
            <Icon name={resolvedState ? "restore" : "check"} />
          </button>
        )}
      </CommentBody>
      {replies.map((reply) => (
        <div className="comment-reply" key={reply.id}>
          <CommentBody comment={reply} mine={reply.authorId === meId} onDelete={onDelete} />
        </div>
      ))}
      {!resolvedState &&
        (replying ? (
          <Composer
            autoFocus
            placeholder="Reply…"
            submitLabel="Reply"
            onSubmit={(body) => {
              setReplying(false);
              onReply(thread.id, body);
            }}
            onCancel={() => setReplying(false)}
          />
        ) : (
          <button
            className="comment-reply-btn"
            onClick={(e) => {
              e.stopPropagation();
              setReplying(true);
            }}
          >
            Reply
          </button>
        ))}
    </div>
  );
}

function CommentBody({
  comment,
  mine,
  onDelete,
  children,
}: {
  comment: CommentItem;
  mine: boolean;
  onDelete: (id: string) => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="comment-body">
      <div className="comment-meta">
        <span
          className="avatar small"
          style={{ background: authorColor(authorKey(comment.authorId, false)) }}
        >
          {comment.authorName.slice(0, 1).toUpperCase()}
        </span>
        <span className="comment-author">{comment.authorName}</span>
        <span className="comment-when">{timeAgo(comment.createdAt)}</span>
        <span className="comment-actions">
          {children}
          {mine && (
            <button
              className="row-action"
              title="Delete comment"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(comment.id);
              }}
            >
              <Icon name="trash" />
            </button>
          )}
        </span>
      </div>
      <p className="comment-text">{comment.body}</p>
    </div>
  );
}

function Composer({
  placeholder,
  submitLabel,
  autoFocus,
  onSubmit,
  onCancel,
}: {
  placeholder: string;
  submitLabel: string;
  autoFocus?: boolean;
  onSubmit: (body: string) => void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const submit = () => {
    const trimmed = body.trim();
    if (trimmed) onSubmit(trimmed);
  };

  return (
    <div className="comment-composer" onClick={(e) => e.stopPropagation()}>
      <textarea
        ref={ref}
        rows={2}
        placeholder={placeholder}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          if (e.key === "Escape") onCancel();
        }}
      />
      <div className="dialog-actions">
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn primary" disabled={!body.trim()} onClick={submit}>
          {submitLabel}
        </button>
      </div>
    </div>
  );
}
