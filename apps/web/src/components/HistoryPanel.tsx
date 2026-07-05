import { authorColor } from "./colors.js";
import { Icon } from "./Icon.js";
import { timeAgo } from "./time.js";

export interface HistorySession {
  clientId: number;
  key: string;
  label: string;
  ai: boolean;
  at: number;
}

/**
 * The edit-history rail: one entry per editing session, straight from the
 * document's authorship layer — who wrote (human or their AI) and when their
 * session started. Selecting a session highlights exactly the text it
 * contributed; "All sessions" colours everything by author.
 */
export function HistoryPanel({
  sessions,
  only,
  onSelect,
  onClose,
}: {
  sessions: HistorySession[];
  only: number | null;
  onSelect: (clientId: number | null) => void;
  onClose: () => void;
}) {
  return (
    <aside className="comments-panel history-panel">
      <div className="comments-head">
        <h2>History</h2>
        <button className="row-action" title="Close history" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>

      {sessions.length === 0 ? (
        <p className="comments-empty">No edits recorded yet.</p>
      ) : (
        <>
          <button
            className={"history-item" + (only === null ? " active" : "")}
            onClick={() => onSelect(null)}
          >
            <span className="legend-dot all" />
            All sessions
          </button>
          {sessions.map((session) => (
            <button
              key={session.clientId}
              className={"history-item" + (only === session.clientId ? " active" : "")}
              onClick={() =>
                onSelect(only === session.clientId ? null : session.clientId)
              }
            >
              <span
                className="legend-dot"
                style={{ background: authorColor(session.key) }}
              />
              <span className="history-who">{session.label}</span>
              <span className="history-when">
                {session.at > 0 ? timeAgo(new Date(session.at)) : "before history"}
              </span>
            </button>
          ))}
          <p className="history-note">
            Sessions are highlighted in the text. Snapshots and restore aren't
            available yet.
          </p>
        </>
      )}
    </aside>
  );
}
