import { useState } from "react";
import type { CollectionInfo } from "../App.js";
import { friendlyError } from "../errors.js";
import { trpc } from "../trpc.js";
import { Icon } from "./Icon.js";
import { Modal } from "./Modal.js";

/**
 * Per-collection access: the workspace-wide default role plus explicit
 * user/group grants. Backend enforcement is RLS; this is just the dial.
 */
export function ShareModal({
  collection,
  onClose,
}: {
  collection: CollectionInfo;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const [error, setError] = useState<string | null>(null);

  const permissions = trpc.collections.permissions.useQuery({ id: collection.id });
  const members = trpc.workspaces.members.useQuery({
    workspaceId: collection.workspaceId,
  });
  const groups = trpc.groups.list.useQuery({ workspaceId: collection.workspaceId });

  const setDefaultRole = trpc.collections.setDefaultRole.useMutation();
  const grant = trpc.collections.grant.useMutation();
  const revoke = trpc.collections.revoke.useMutation();

  const [principal, setPrincipal] = useState("");
  const [role, setRole] = useState<"read" | "read_write">("read");

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await Promise.all([
        utils.collections.permissions.invalidate({ id: collection.id }),
        utils.collections.list.invalidate(),
      ]);
    } catch (e) {
      setError(friendlyError(e));
    }
  };

  const principalName = (type: string, id: string): string => {
    if (type === "user") {
      const m = (members.data ?? []).find((m) => m.userId === id);
      return m ? `${m.name} (${m.email})` : id;
    }
    const g = (groups.data ?? []).find((g) => g.id === id);
    return g ? `${g.name} (group)` : `${id} (group)`;
  };

  // Only admins/owners may read grants; a FORBIDDEN error here means the
  // viewer can't manage sharing at all.
  const canManage = !permissions.error;

  return (
    <Modal title={`Share "${collection.name}"`} onClose={onClose}>
      {!canManage ? (
        <p className="modal-note">
          Only a workspace owner or admin can manage sharing for this collection.
        </p>
      ) : (
        <>
          <label className="field">
            <span>Everyone in the workspace</span>
            <select
              value={collection.defaultRole}
              onChange={(e) =>
                void run(() =>
                  setDefaultRole.mutateAsync({
                    id: collection.id,
                    role: e.target.value as "none" | "read" | "read_write",
                  }),
                )
              }
            >
              <option value="read_write">Can edit</option>
              <option value="read">Can view</option>
              <option value="none">No access (invited people only)</option>
            </select>
          </label>

          <h3>People and groups with explicit access</h3>
          {permissions.isLoading && <p className="modal-note">Loading…</p>}
          {(permissions.data ?? []).length === 0 && !permissions.isLoading && (
            <p className="modal-note">No explicit grants yet.</p>
          )}
          <ul className="grant-list">
            {(permissions.data ?? []).map((p) => (
              <li key={p.id}>
                <span className="grant-who">
                  {principalName(p.principalType, p.principalId)}
                </span>
                <span className="grant-role">
                  {p.role === "read_write" ? "can edit" : "can view"}
                </span>
                <button type="button"
                  className="row-action"
                  title="Revoke" aria-label="Revoke"
                  onClick={() =>
                    void run(() =>
                      revoke.mutateAsync({
                        id: collection.id,
                        principalType: p.principalType as "user" | "group",
                        principalId: p.principalId,
                      }),
                    )
                  }
                >
                  <Icon name="close" size={14} />
                </button>
              </li>
            ))}
          </ul>

          <div className="grant-add">
            <select value={principal} onChange={(e) => setPrincipal(e.target.value)}>
              <option value="">Add a person or group…</option>
              {(members.data ?? []).map((m) => (
                <option key={m.userId} value={`user:${m.userId}`}>
                  {m.name} ({m.email})
                </option>
              ))}
              {(groups.data ?? []).map((g) => (
                <option key={g.id} value={`group:${g.id}`}>
                  {g.name} (group)
                </option>
              ))}
            </select>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as "read" | "read_write")}
            >
              <option value="read">Can view</option>
              <option value="read_write">Can edit</option>
            </select>
            <button type="button"
              className="btn primary"
              disabled={!principal || grant.isPending}
              onClick={() => {
                const [type, id] = principal.split(/:(.*)/s) as [string, string];
                void run(() =>
                  grant.mutateAsync({
                    id: collection.id,
                    principalType: type as "user" | "group",
                    principalId: id,
                    role,
                  }),
                ).then(() => setPrincipal(""));
              }}
            >
              Grant
            </button>
          </div>
        </>
      )}
      {error && <div className="modal-error">{error}</div>}
    </Modal>
  );
}
