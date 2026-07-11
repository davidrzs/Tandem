import { useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { friendlyError } from "../errors.js";
import { trpc } from "../trpc.js";
import { Modal } from "./Modal.js";
import { timeAgo } from "./time.js";

function verb(kind: string): string {
  switch (kind) {
    case "comment_reply":
      return "replied in";
    case "comment_mention":
      return "mentioned you in";
    case "comment_resolved":
      return "resolved your comment in";
    case "task_assigned":
      return "assigned you a task in";
    default:
      return "did something in";
  }
}

/** The inbox: comment replies/mentions/resolves and task assignments. Opening
 * it clears the unread badge; rows navigate to their document. */
export function NotificationsModal({ onClose }: { onClose: () => void }) {
  const utils = trpc.useUtils();
  const navigate = useNavigate();
  const list = trpc.notifications.list.useQuery();
  // Unread dots come from the list fetched at open; marking read only resets
  // the badge, so the dots stay visible while the modal is up.
  const unreadIds = useMemo(
    () => new Set((list.data ?? []).filter((n) => !n.readAt).map((n) => n.id)),
    [list.data],
  );
  const markAll = trpc.notifications.markAllRead.useMutation({
    onSuccess: () => utils.notifications.unreadCount.invalidate(),
  });
  useEffect(() => {
    if (list.data?.some((n) => !n.readAt)) markAll.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.data]);

  return (
    <Modal title="Inbox" onClose={onClose} wide>
      {list.isLoading && <p className="modal-note">Loading…</p>}
      {list.error && (
        <p className="modal-note">{friendlyError(list.error, "Couldn't load notifications.")}</p>
      )}
      {list.data && list.data.length === 0 && (
        <p className="modal-note">
          Nothing yet. You'll hear about comment replies, @mentions, resolved
          threads, and tasks assigned to you.
        </p>
      )}
      <ul className="notif-list">
        {(list.data ?? []).map((n) => (
          <li key={n.id}>
            <button
              type="button"
              className={"notif-row" + (unreadIds.has(n.id) ? " unread" : "")}
              onClick={() => {
                onClose();
                if (n.documentId) navigate(`/d/${n.documentId}`);
              }}
            >
              <span className="notif-what">
                <strong>
                  {n.actorName || "Someone"}
                  {n.ai ? "'s AI" : ""}
                </strong>{" "}
                {verb(n.kind)} <em>{n.documentTitle || "Untitled"}</em>
                {n.snippet && <span className="notif-snippet">{n.snippet}</span>}
              </span>
              <span className="notif-when">{timeAgo(n.createdAt)}</span>
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
