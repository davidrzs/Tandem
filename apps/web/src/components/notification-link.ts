export interface NotificationLinkTarget {
  documentId: string | null;
  targetType?: string | null;
  targetId?: string | null;
}

/** Route an inbox/action-center item to the exact collaboration target when
 * one was recorded, while preserving the old document-only fallback. */
export function notificationHref(notification: NotificationLinkTarget): string | null {
  if (!notification.documentId) return null;
  const base = `/d/${notification.documentId}`;
  if (!notification.targetId) return base;
  if (notification.targetType === "comment") {
    return `${base}?comment=${encodeURIComponent(notification.targetId)}`;
  }
  if (notification.targetType === "task") {
    return `${base}?task=${encodeURIComponent(notification.targetId)}`;
  }
  return base;
}

/** How a notification row reads: "{actor} {verb} {document}". */
export function notificationVerb(kind: string): string {
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
