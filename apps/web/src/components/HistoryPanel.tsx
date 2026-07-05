import { authorLabel } from "./blame.js";
import { authorColor, authorKey } from "./colors.js";
import { Icon } from "./Icon.js";
import { timeAgo } from "./time.js";

export interface HistorySession {
  clientId: number;
  key: string;
  label: string;
  ai: boolean;
  at: number;
}

export interface SnapshotVersion {
  id: string;
  createdAt: string | Date;
  kind: string;
  authors: { userId: string; name: string; ai: boolean }[];
}

function versionLabel(v: SnapshotVersion): string {
  if (v.authors.length === 0) return "Unknown";
  return v.authors.map((a) => authorLabel(a)).join(", ");
}

/**
 * The history rail: recent editing sessions (who wrote what, from the blame
 * layer) and saved point-in-time versions. Selecting a session highlights the
 * text it contributed; selecting a version opens a read-only preview you can
 * restore from.
 */
export function HistoryPanel({
  sessions,
  only,
  onSelect,
  versions,
  previewingId,
  onPreview,
  onClose,
}: {
  sessions: HistorySession[];
  only: number | null;
  onSelect: (clientId: number | null) => void;
  versions: SnapshotVersion[];
  previewingId: string | null;
  onPreview: (id: string) => void;
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

      <h3 className="history-section">Who wrote what</h3>
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
              onClick={() => onSelect(only === session.clientId ? null : session.clientId)}
            >
              <span className="legend-dot" style={{ background: authorColor(session.key) }} />
              <span className="history-who">{session.label}</span>
              <span className="history-when">
                {session.at > 0 ? timeAgo(new Date(session.at)) : "before history"}
              </span>
            </button>
          ))}
        </>
      )}

      <h3 className="history-section">Versions</h3>
      {versions.length === 0 ? (
        <p className="history-note">
          Versions are saved automatically as the document is edited. None yet.
        </p>
      ) : (
        versions.map((v) => (
          <button
            key={v.id}
            className={"history-item version" + (previewingId === v.id ? " active" : "")}
            onClick={() => onPreview(v.id)}
          >
            <span
              className="legend-dot"
              style={{
                background: authorColor(
                  authorKey(v.authors[0]?.userId ?? "", v.authors[0]?.ai ?? false),
                ),
              }}
            />
            <span className="history-who">{versionLabel(v)}</span>
            <span className="history-when">{timeAgo(v.createdAt)}</span>
            {v.kind === "pre-restore" && <span className="version-badge">before restore</span>}
          </button>
        ))
      )}
    </aside>
  );
}
