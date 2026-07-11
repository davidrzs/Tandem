import { useState } from "react";
import { friendlyError } from "../errors.js";
import { trpc } from "../trpc.js";
import { Icon } from "./Icon.js";
import { Modal } from "./Modal.js";
import { timeAgo } from "./time.js";
import { useToast } from "./toast.js";
import { TwoFactorSection } from "./TwoFactorSection.js";

/**
 * Account & AI settings: the per-user MCP kill switch, how to connect an
 * agent, and the workspace's activity trail (agent actions plus sensitive
 * human actions: sharing, invites, import/export).
 */
export function SettingsModal({
  workspaceId,
  onClose,
}: {
  workspaceId: string | null;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const settings = trpc.settings.get.useQuery();
  const audit = trpc.settings.audit.useQuery(
    { workspaceId: workspaceId! },
    { enabled: !!workspaceId },
  );
  // The switch is backed by LOCAL state, seeded from the query: React state
  // set inside the click handler flushes synchronously, so the checkbox never
  // visibly snaps back while the round trip is in flight. (Driving it from the
  // query cache reverts the native flip for a microtask — a real dropped-click
  // window for fast users and automation.)
  const [localEnabled, setLocalEnabled] = useState<boolean | null>(null);
  const setMcp = trpc.settings.setMcpEnabled.useMutation({
    onSettled: () => utils.settings.get.invalidate(),
    onError: (e, vars) => {
      setLocalEnabled(!vars.enabled);
      setError(friendlyError(e));
    },
  });

  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{
    collections: number;
    documents: number;
    images: number;
    warnings: string[];
  } | null>(null);

  const onImportFile = async (file: File) => {
    if (!workspaceId) return;
    setImporting(true);
    setImportResult(null);
    setError(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch(`/api/import?workspace=${workspaceId}`, {
        method: "POST",
        body,
        credentials: "include",
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(detail.error ?? "The import couldn't be completed.");
      }
      setImportResult(await res.json());
      await Promise.all([utils.collections.list.invalidate(), utils.documents.tree.invalidate()]);
    } catch (e) {
      setError(friendlyError(e, "The import couldn't be completed."));
    } finally {
      setImporting(false);
    }
  };

  const enabled = localEnabled ?? settings.data?.mcpEnabled ?? true;
  const endpoint = `${window.location.origin}/mcp`;

  return (
    <Modal title="Settings" onClose={onClose} wide>
      <h3>AI access (MCP)</h3>
      <div className="switch-row">
        {/* A button-backed switch: unlike a controlled checkbox, a button has
            no native checked state for React to revert mid-render, so a click
            can never be silently dropped. */}
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          className="switch-btn"
          // Disabled while the save is in flight: the flip is instant (local
          // state), so this is the only signal that it has actually persisted.
          disabled={settings.isLoading || setMcp.isPending}
          aria-label="Allow AI agents to act as me"
          onClick={() => {
            const next = !enabled;
            setLocalEnabled(next);
            setMcp.mutate({ enabled: next });
          }}
        >
          <span className="switch-thumb" />
        </button>
        <span>
          <strong>Allow AI agents to act as me</strong>
          <span className="switch-hint">
            When off, agents connecting with your account are refused. Every
            agent edit is attributed to "your name's AI" in document history.
          </span>
        </span>
      </div>

      <h3>Connect an agent</h3>
      <ol className="connect-steps">
        <li>
          Point any MCP client at{" "}
          <button
            type="button"
            className="copyable"
            title="Copy MCP endpoint"
            onClick={() =>
              void navigator.clipboard.writeText(endpoint).then(() => toast("Copied"))
            }
          >
            <code>{endpoint}</code>
          </button>
        </li>
        <li>Sign in when the browser opens — the agent gets your permissions, nothing more.</li>
      </ol>

      <h3>Activity in this workspace</h3>
      <p className="modal-note">
        Agent edits, sharing changes, invites, and imports/exports.
      </p>
      {!workspaceId && <p className="modal-note">Select a workspace first.</p>}
      {audit.error && (
        <p className="modal-note">{friendlyError(audit.error, "Couldn't load the audit trail.")}</p>
      )}
      {audit.data && audit.data.length === 0 && (
        <p className="modal-note">No activity recorded yet.</p>
      )}
      {(audit.data ?? []).length > 0 && (
        <ul className="audit-list">
          {audit.data!.map((entry) => (
            <li key={entry.id}>
              <Icon name="pen" size={13} />
              <span className="audit-what">
                <strong>
                  {entry.userName}
                  {entry.ai ? "'s AI" : ""}
                </strong>{" "}
                · {entry.action.replaceAll("_", " ")}
                {entry.detail ? ` ${entry.detail}` : ""}
              </span>
              <span className="audit-when">{timeAgo(entry.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}

      <TwoFactorSection />

      <h3>Data</h3>
      {!workspaceId ? (
        <p className="modal-note">Select a workspace first.</p>
      ) : (
        <>
          <div className="data-actions">
            <a className="btn" href={`/api/export?workspace=${workspaceId}`}>
              Export workspace
            </a>
            <label className={"btn" + (importing ? " disabled" : "")}>
              {importing ? "Importing…" : "Import a zip"}
              <input
                type="file"
                accept=".zip,application/zip"
                hidden
                disabled={importing}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void onImportFile(file);
                }}
              />
            </label>
          </div>
          <p className="switch-hint">
            Export downloads every document you can read as markdown. Import
            accepts Outline backups and Obsidian-style vaults.
          </p>
          {importResult && (
            <div className="import-summary">
              Imported {importResult.collections} collection
              {importResult.collections === 1 ? "" : "s"}, {importResult.documents} document
              {importResult.documents === 1 ? "" : "s"}, {importResult.images} image
              {importResult.images === 1 ? "" : "s"}.
              {importResult.warnings.length > 0 && (
                <details>
                  <summary>
                    {importResult.warnings.length} thing
                    {importResult.warnings.length === 1 ? "" : "s"} to review
                  </summary>
                  <ul>
                    {importResult.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
        </>
      )}
      {error && <div className="modal-error">{error}</div>}
    </Modal>
  );
}
