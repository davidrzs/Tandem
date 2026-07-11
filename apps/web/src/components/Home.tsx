import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { authClient } from "../auth-client.js";
import { useAppContext } from "../App.js";
import { friendlyError } from "../errors.js";
import { trpc } from "../trpc.js";
import { Icon } from "./Icon.js";
import { listRecents } from "./recents.js";

interface TodoGroup {
  documentId: string;
  documentTitle: string;
  items: Array<{ line: number; text: string; done: boolean }>;
}

/** The start page: every open task assigned to me across the wiki, linking
 * back to its source document. */
export function Home() {
  const session = authClient.useSession();
  const { workspaceId } = useAppContext();
  const todos = trpc.documents.myTodos.useQuery();
  const [showDone, setShowDone] = useState(false);
  const recents = useMemo(
    () =>
      listRecents()
        .filter((r) => r.workspaceId === workspaceId)
        .slice(0, 8),
    [workspaceId],
  );

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

  return (
    <div className="home">
      <h1>{name ? `Hi ${name}` : "Home"}</h1>
      <p className="home-sub">
        {todos.isLoading
          ? "Looking for tasks assigned to you…"
          : openCount === 0
            ? "No open tasks are assigned to you."
            : `${openCount} open task${openCount === 1 ? "" : "s"} assigned to you.`}
      </p>

      {recents.length > 0 && (
        <>
          <h2 className="home-h2">Recently viewed</h2>
          <div className="recent-row">
            {recents.map((r) => (
              <Link key={r.id} className="recent-chip" to={`/d/${r.id}`}>
                <Icon name="page" size={13} />
                {r.title || "Untitled"}
              </Link>
            ))}
          </div>
        </>
      )}

      {todos.error && (
        <div className="error-panel inline">
          <p className="error-detail">{friendlyError(todos.error, "Couldn't load your tasks. Try again.")}</p>
          <button className="btn" onClick={() => void todos.refetch()}>
            Retry
          </button>
        </div>
      )}

      {open.map((g) => (
        <TodoCard key={g.documentId} group={g} />
      ))}

      {doneCount > 0 && (
        <button className="home-toggle" onClick={() => setShowDone((s) => !s)}>
          {showDone ? "Hide" : "Show"} {doneCount} completed
        </button>
      )}
      {showDone && done.map((g) => <TodoCard key={g.documentId} group={g} />)}

      {!todos.isLoading && openCount === 0 && doneCount === 0 && !todos.error && (
        <p className="home-hint">
          Assign a task to anyone by writing a to-do with a mention in any
          document: <code>- [ ] @{session.data?.user.email.split("@")[0] ?? "name"} write the intro</code>
        </p>
      )}
    </div>
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
            <span className="todo-box">{item.done ? "☑" : "☐"}</span>
            {item.text}
          </li>
        ))}
      </ul>
    </div>
  );
}
