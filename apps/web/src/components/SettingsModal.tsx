import { useState } from "react";
import { trpc } from "../trpc.js";
import { Icon } from "./Icon.js";
import { Modal } from "./Modal.js";
import { timeAgo } from "./time.js";

/**
 * Account & AI settings: the per-user MCP kill switch, how to connect an
 * agent, and the workspace's audit trail of agent actions.
 */
export function SettingsModal({
  workspaceId,
  onClose,
}: {
  workspaceId: string | null;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const [error, setError] = useState<string | null>(null);
  const settings = trpc.settings.get.useQuery();
  const audit = trpc.settings.audit.useQuery(
    { workspaceId: workspaceId! },
    { enabled: !!workspaceId },
  );
  const setMcp = trpc.settings.setMcpEnabled.useMutation({
    // Optimistic: the switch flips instantly; the refetch reconciles.
    onMutate: ({ enabled }) => {
      utils.settings.get.setData(undefined, { mcpEnabled: enabled });
    },
    onSettled: () => utils.settings.get.invalidate(),
    onError: (e) => setError(e.message),
  });

  const enabled = settings.data?.mcpEnabled ?? true;
  const endpoint = `${window.location.origin}/mcp`;

  return (
    <Modal title="Settings" onClose={onClose} wide>
      <h3>AI access (MCP)</h3>
      <label className="switch-row">
        <input
          type="checkbox"
          checked={enabled}
          disabled={settings.isLoading || setMcp.isPending}
          onChange={(e) => setMcp.mutate({ enabled: e.target.checked })}
        />
        <span>
          <strong>Allow AI agents to act as me</strong>
          <span className="switch-hint">
            When off, agents connecting with your account are refused. Every
            agent edit is attributed to "your name's AI" in document history.
          </span>
        </span>
      </label>

      <h3>Connect an agent</h3>
      <ol className="connect-steps">
        <li>
          Point any MCP client at{" "}
          <code
            className="copyable"
            title="Click to copy"
            onClick={() => void navigator.clipboard.writeText(endpoint)}
          >
            {endpoint}
          </code>
        </li>
        <li>Sign in when the browser opens — the agent gets your permissions, nothing more.</li>
        <li>
          For a local (stdio) agent, run{" "}
          <code>pnpm --filter @tandem/server mcp</code> with{" "}
          <code>TANDEM_USER=your@email</code> so its edits are yours.
        </li>
      </ol>

      <h3>Agent activity in this workspace</h3>
      {!workspaceId && <p className="modal-note">Select a workspace first.</p>}
      {audit.error && (
        <p className="modal-note">Couldn't load the audit trail: {audit.error.message}</p>
      )}
      {audit.data && audit.data.length === 0 && (
        <p className="modal-note">No agent actions recorded yet.</p>
      )}
      {(audit.data ?? []).length > 0 && (
        <ul className="audit-list">
          {audit.data!.map((entry) => (
            <li key={entry.id}>
              <Icon name="pen" size={13} />
              <span className="audit-what">
                <strong>{entry.userName}'s AI</strong> · {entry.action.replaceAll("_", " ")}
                {entry.detail ? ` ${entry.detail}` : ""}
              </span>
              <span className="audit-when">{timeAgo(entry.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
      {error && <div className="modal-error">{error}</div>}
    </Modal>
  );
}
