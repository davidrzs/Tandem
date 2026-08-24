import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { authClient } from "../auth-client.js";
import { useAppContext } from "../App.js";
import { friendlyError } from "../errors.js";
import { trpc } from "../trpc.js";
import { useCreateDocument } from "./create-document.js";
import { Icon } from "./Icon.js";
import { notificationHref, notificationVerb } from "./notification-link.js";
import { listRecents } from "./recents.js";
import { timeAgo } from "./time.js";
import { useToast } from "./toast.js";

interface TodoGroup {
  documentId: string;
  documentTitle: string;
  items: Array<{ line: number; text: string; done: boolean }>;
}

type OnboardingFlag = "dismissed" | "reviewed";

const onboardingKey = (workspaceId: string | null, flag: OnboardingFlag) =>
  `tandem.onboarding.${flag}:${workspaceId ?? "none"}`;

const readOnboarding = (workspaceId: string | null, flag: OnboardingFlag): boolean => {
  try {
    return localStorage.getItem(onboardingKey(workspaceId, flag)) === "1";
  } catch {
    return false;
  }
};

const writeOnboarding = (workspaceId: string | null, flag: OnboardingFlag): void => {
  try {
    localStorage.setItem(onboardingKey(workspaceId, flag), "1");
  } catch {
    // Best effort, like recents.
  }
};

const AI_DOCUMENT_ACTIONS = new Set([
  "create_document",
  "edit_document",
  "insert_after_heading",
  "replace_section",
  "append_section",
]);

/** Home is an action center, not a second project-management system: it
 * projects actionable state already held by documents, comments, favorites,
 * notifications, and the private browser-local recent list. */
export function Home() {
  const session = authClient.useSession();
  const { workspaceId, collections, openSearch, openSettings } = useAppContext();
  const navigate = useNavigate();
  const toast = useToast();
  const utils = trpc.useUtils();
  const todos = trpc.documents.myTodos.useQuery();
  const notifications = trpc.notifications.list.useQuery({
    workspaceId: workspaceId ?? undefined,
  });
  const markNotificationRead = trpc.notifications.markRead.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.notifications.list.invalidate(),
        utils.notifications.unreadCount.invalidate(),
      ]);
    },
  });
  const favorites = trpc.favorites.list.useQuery();
  const hasAnyDocument = trpc.documents.hasAny.useQuery(
    { workspaceId: workspaceId! },
    { enabled: !!workspaceId },
  );
  const audit = trpc.settings.audit.useQuery(
    { workspaceId: workspaceId! },
    { enabled: !!workspaceId },
  );
  const createDocument = useCreateDocument(workspaceId, (id) => navigate(`/d/${id}`));
  const [showDone, setShowDone] = useState(false);
  const [dismissed, setDismissed] = useState(() => readOnboarding(workspaceId, "dismissed"));
  const [reviewed, setReviewed] = useState(() => readOnboarding(workspaceId, "reviewed"));

  // Switching workspace swaps which walkthrough state applies.
  useEffect(() => {
    setDismissed(readOnboarding(workspaceId, "dismissed"));
    setReviewed(readOnboarding(workspaceId, "reviewed"));
  }, [workspaceId]);

  const recents = useMemo(
    () =>
      listRecents()
        .filter((r) => r.workspaceId === workspaceId)
        .slice(0, 8),
    [workspaceId],
  );
  const workspaceFavorites = (favorites.data ?? []).filter(
    (document) => document.workspaceId === workspaceId && !document.archivedAt,
  );
  const unread = (notifications.data ?? []).filter((n) => !n.readAt);

  const { open, done } = useMemo(() => {
    const groups = new Map<string, TodoGroup>();
    const doneGroups = new Map<string, TodoGroup>();
    for (const t of todos.data ?? []) {
      const target = t.done ? doneGroups : groups;
      let g = target.get(t.documentId);
      if (!g) {
        g = { documentId: t.documentId, documentTitle: t.documentTitle, items: [] };
        target.set(t.documentId, g);
      }
      g.items.push({ line: t.line, text: t.text, done: t.done });
    }
    return { open: [...groups.values()], done: [...doneGroups.values()] };
  }, [todos.data]);

  const name = session.data?.user.name?.split(" ")[0];
  const openCount = open.reduce((n, g) => n + g.items.length, 0);
  const doneCount = done.reduce((n, g) => n + g.items.length, 0);
  const hasDocument =
    !!hasAnyDocument.data ||
    recents.length > 0 ||
    workspaceFavorites.length > 0 ||
    openCount + doneCount > 0;
  const myAiActions = (audit.data ?? []).filter(
    (entry) =>
      entry.ai &&
      entry.userId === session.data?.user.id &&
      AI_DOCUMENT_ACTIONS.has(entry.action),
  );
  // Only an entry that names its document can honestly say what the AI
  // changed; older entries predate the column and are left unlinked.
  const reviewTarget = myAiActions.find((entry) => entry.documentId);
  // Reviewing implies an agent edit happened, so the walkthrough stays
  // complete once done — the audit window it was derived from is bounded.
  const agentUsed = myAiActions.length > 0 || reviewed;
  const setupComplete = hasDocument && reviewed;
  const showOnboarding =
    !dismissed &&
    !setupComplete &&
    !!workspaceId &&
    !hasAnyDocument.isLoading &&
    !audit.isLoading;
  const writableCollection = collections.find(
    (collection) => collection.workspaceId === workspaceId && collection.writable,
  );
  const onboardingProgress = [hasDocument, agentUsed, reviewed].filter(Boolean).length;

  const dismissOnboarding = () => {
    setDismissed(true);
    writeOnboarding(workspaceId, "dismissed");
  };
  const reviewAiEdit = () => {
    if (!reviewTarget?.documentId) return;
    setReviewed(true);
    writeOnboarding(workspaceId, "reviewed");
    navigate(
      `/d/${reviewTarget.documentId}?history=${encodeURIComponent(reviewTarget.sessionId ?? "ai")}`,
    );
  };
  const copyStarterPrompt = async () => {
    const target = recents[0] ?? workspaceFavorites[0];
    if (!target) return;
    try {
      await navigator.clipboard.writeText(
        `Open the Tandem document "${target.title || "Untitled"}". Add a short "Open questions" section at the end. Do not change anything else.`,
      );
      toast("Starter prompt copied");
    } catch {
      // No clipboard on insecure origins — self-hosting over plain HTTP.
      toast("Couldn't copy — your browser blocked clipboard access", "danger");
    }
  };

  return (
    <div className="home action-home">
      <div className="home-heading">
        <div>
          <h1>{name ? `Hi ${name}` : "Home"}</h1>
          <p className="home-sub">
            {openCount > 0 || unread.length > 0
              ? `${unread.length + openCount} item${unread.length + openCount === 1 ? " needs" : "s need"} your attention.`
              : "You're all caught up."}
          </p>
        </div>
        <button type="button" className="home-search" onClick={() => openSearch()}>
          <Icon name="search" size={15} />
          Search Tandem
          <kbd>⌘K</kbd>
        </button>
      </div>

      {showOnboarding && (
        <section className="onboarding-card" aria-labelledby="onboarding-title">
          <div className="onboarding-head">
            <div>
              <span className="eyebrow">Human + AI, with a clear record</span>
              <h2 id="onboarding-title">Make your first edit together</h2>
            </div>
            <button type="button" className="home-dismiss" onClick={dismissOnboarding}>
              Dismiss
            </button>
          </div>
          <div
            className="onboarding-progress"
            role="progressbar"
            aria-label="Getting started progress"
            aria-valuemin={0}
            aria-valuemax={3}
            aria-valuenow={onboardingProgress}
          >
            <span style={{ width: `${(onboardingProgress / 3) * 100}%` }} />
          </div>
          <ol className="onboarding-steps">
            <OnboardingStep done={hasDocument} number={1} title="Create or open a document">
              {hasDocument ? (
                "Your document is ready."
              ) : writableCollection ? (
                <button
                  type="button"
                  className="btn"
                  disabled={createDocument.isPending}
                  onClick={() =>
                    createDocument.mutate({ collectionId: writableCollection.id, title: "" })
                  }
                >
                  New document
                </button>
              ) : (
                "Create a writable collection from the sidebar first."
              )}
            </OnboardingStep>
            <OnboardingStep done={agentUsed} number={2} title="Connect an agent and ask for one small edit">
              {myAiActions[0] ? (
                `${myAiActions[0].userName}'s AI used ${myAiActions[0].action.replaceAll("_", " ")}.`
              ) : agentUsed ? (
                "Your agent has edited here before."
              ) : (
                <span className="onboarding-actions">
                  <button type="button" className="btn" onClick={openSettings}>
                    Connect agent
                  </button>
                  {hasDocument && (
                    <button type="button" className="btn" onClick={() => void copyStarterPrompt()}>
                      Copy safe starter prompt
                    </button>
                  )}
                </span>
              )}
            </OnboardingStep>
            <OnboardingStep done={reviewed} number={3} title="Review exactly what the AI changed">
              {reviewTarget ? (
                <button type="button" className="btn primary" onClick={reviewAiEdit}>
                  Review AI edit
                </button>
              ) : (
                "After the edit, Tandem will highlight only the AI-authored spans."
              )}
            </OnboardingStep>
          </ol>
        </section>
      )}

      {(unread.length > 0 || (reviewTarget && !reviewed)) && (
        <section className="home-section">
          <h2>Needs your attention</h2>
          <div className="attention-list">
            {reviewTarget && !reviewed && (
              <button type="button" className="attention-row" onClick={reviewAiEdit}>
                <span className="attention-icon ai"><Icon name="pen" size={15} /></span>
                <span className="attention-copy">
                  <strong>{reviewTarget.userName}'s AI changed {reviewTarget.documentTitle || "Untitled"}</strong>
                  <span>{reviewTarget.action.replaceAll("_", " ")} · {timeAgo(reviewTarget.createdAt)}</span>
                </span>
                <span className="attention-action">Review</span>
              </button>
            )}
            {unread.slice(0, 5).map((notification) => {
              const href = notificationHref(notification);
              const content = (
                <>
                  <span className="attention-icon"><Icon name="comment" size={15} /></span>
                  <span className="attention-copy">
                    <strong>
                      {notification.actorName || "Someone"} {notificationVerb(notification.kind)} {notification.documentTitle || "Untitled"}
                    </strong>
                    {notification.snippet && <span>{notification.snippet}</span>}
                  </span>
                  <span className="attention-action">{timeAgo(notification.createdAt)}</span>
                </>
              );
              return href ? (
                <Link
                  key={notification.id}
                  className="attention-row"
                  to={href}
                  onClick={() => markNotificationRead.mutate({ id: notification.id })}
                >
                  {content}
                </Link>
              ) : (
                <div key={notification.id} className="attention-row">{content}</div>
              );
            })}
          </div>
        </section>
      )}

      <section className="home-section">
        <div className="home-section-head">
          <h2>My tasks{openCount > 0 ? ` · ${openCount}` : ""}</h2>
          {doneCount > 0 && (
            <button type="button" className="home-toggle" onClick={() => setShowDone((s) => !s)}>
              {showDone ? "Hide" : "Show"} {doneCount} completed
            </button>
          )}
        </div>
        {todos.error && (
          <div className="error-panel inline">
            <p className="error-detail">{friendlyError(todos.error, "Couldn't load your tasks. Try again.")}</p>
            <button type="button" className="btn" onClick={() => void todos.refetch()}>Retry</button>
          </div>
        )}
        {todos.isLoading && <p className="home-empty">Looking for tasks assigned to you…</p>}
        {!todos.isLoading && openCount === 0 && !todos.error && (
          <p className="home-empty">No open tasks are assigned to you.</p>
        )}
        {open.map((g) => <TodoCard key={g.documentId} group={g} />)}
        {showDone && done.map((g) => <TodoCard key={g.documentId} group={g} />)}
      </section>

      {(workspaceFavorites.length > 0 || recents.length > 0) && (
        <section className="home-section">
          <h2>Continue working</h2>
          <div className="continue-grid">
            {workspaceFavorites.slice(0, 4).map((doc) => (
              <Link key={`favorite:${doc.id}`} className="continue-card" to={`/d/${doc.id}`}>
                <Icon name="star" size={14} />
                <span><strong>{doc.title || "Untitled"}</strong><small>Favorite</small></span>
              </Link>
            ))}
            {recents
              .filter((recent) => !workspaceFavorites.some((favorite) => favorite.id === recent.id))
              .slice(0, 4)
              .map((recent) => (
                <Link key={`recent:${recent.id}`} className="continue-card" to={`/d/${recent.id}`}>
                  <Icon name="page" size={14} />
                  <span><strong>{recent.title || "Untitled"}</strong><small>Recently viewed</small></span>
                </Link>
              ))}
          </div>
        </section>
      )}

      <section className="home-section quick-section">
        <h2>Quick actions</h2>
        <div className="quick-actions">
          <button
            type="button"
            className="quick-action"
            disabled={!writableCollection || createDocument.isPending}
            onClick={() =>
              writableCollection && createDocument.mutate({ collectionId: writableCollection.id, title: "" })
            }
          >
            <Icon name="plus" /> New document
          </button>
          <button type="button" className="quick-action" onClick={openSettings}>
            <Icon name="download" /> Import notes
          </button>
          <button type="button" className="quick-action" onClick={openSettings}>
            <Icon name="settings" /> Connect an agent
          </button>
        </div>
        {createDocument.error && (
          <p className="error-detail">
            {friendlyError(createDocument.error, "Couldn't create the document.")}
          </p>
        )}
      </section>
    </div>
  );
}

function OnboardingStep({
  done,
  number,
  title,
  children,
}: {
  done: boolean;
  number: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <li className={done ? "done" : ""}>
      <span className="onboarding-number">{done ? <Icon name="check" size={14} /> : number}</span>
      <span className="onboarding-copy"><strong>{title}</strong><span>{children}</span></span>
    </li>
  );
}

function TodoCard({ group }: { group: TodoGroup }) {
  return (
    <div className="todo-card">
      <Link className="todo-doc" to={`/d/${group.documentId}`}>
        {group.documentTitle || "Untitled"}
      </Link>
      <ul className="todo-list">
        {group.items.map((item) => (
          <li key={item.line} className={item.done ? "done" : ""}>
            <span className="todo-box" aria-hidden="true" />
            <Link to={`/d/${group.documentId}?task=${encodeURIComponent(item.text)}`}>
              {item.text}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
