import { useState } from "react";
import { trpc } from "../trpc.js";
import { Icon } from "./Icon.js";
import { ConfirmDialog, Modal, RowMenu } from "./Modal.js";

/** Workspace people: member list, invites (role + expiry), and groups. */
export function PeopleModal({
  workspaceId,
  onClose,
}: {
  workspaceId: string;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const [error, setError] = useState<string | null>(null);

  const members = trpc.workspaces.members.useQuery({ workspaceId });
  const groups = trpc.groups.list.useQuery({ workspaceId });
  const createInvite = trpc.workspaces.createInvite.useMutation();
  const createGroup = trpc.groups.create.useMutation();

  const [inviteRole, setInviteRole] = useState<"member" | "admin">("member");
  const [inviteExpiry, setInviteExpiry] = useState<string>("14");
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [newGroup, setNewGroup] = useState("");

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    }
  };

  return (
    <Modal title="People & groups" onClose={onClose} wide>
      <h3>Members</h3>
      {members.error && (
        <p className="modal-note">Couldn't load members: {members.error.message}</p>
      )}
      <ul className="member-list">
        {(members.data ?? []).map((m) => (
          <li key={m.userId}>
            <span className="member-name">{m.name}</span>
            <span className="member-email">{m.email}</span>
            <span className="member-role">{m.role}</span>
          </li>
        ))}
      </ul>

      <h3>Invite someone</h3>
      <div className="invite-row">
        <select
          value={inviteRole}
          onChange={(e) => setInviteRole(e.target.value as "member" | "admin")}
        >
          <option value="member">As member</option>
          <option value="admin">As admin</option>
        </select>
        <select value={inviteExpiry} onChange={(e) => setInviteExpiry(e.target.value)}>
          <option value="1">Expires in 1 day</option>
          <option value="7">Expires in 7 days</option>
          <option value="14">Expires in 14 days</option>
          <option value="">Never expires</option>
        </select>
        <button
          className="btn"
          disabled={createInvite.isPending}
          onClick={() =>
            void run(async () => {
              setInviteLink(null);
              const { token } = await createInvite.mutateAsync({
                workspaceId,
                role: inviteRole,
                ...(inviteExpiry ? { expiresInDays: Number(inviteExpiry) } : {}),
              });
              setInviteLink(`${window.location.origin}/invite?token=${token}`);
            })
          }
        >
          Create invite link
        </button>
      </div>
      {inviteLink && (
        <input
          className="invite-link"
          readOnly
          value={inviteLink}
          onFocus={(e) => e.currentTarget.select()}
        />
      )}

      <h3>Groups</h3>
      {(groups.data ?? []).map((g) => (
        <GroupRow key={g.id} groupId={g.id} name={g.name} workspaceId={workspaceId} onError={setError} />
      ))}
      <div className="invite-row">
        <input
          placeholder="New group name"
          value={newGroup}
          onChange={(e) => setNewGroup(e.target.value)}
        />
        <button
          className="btn"
          disabled={!newGroup.trim() || createGroup.isPending}
          onClick={() =>
            void run(async () => {
              await createGroup.mutateAsync({ workspaceId, name: newGroup.trim() });
              setNewGroup("");
              await utils.groups.list.invalidate({ workspaceId });
            })
          }
        >
          Create group
        </button>
      </div>

      {error && <div className="modal-error">{error}</div>}
    </Modal>
  );
}

function GroupRow({
  groupId,
  name,
  workspaceId,
  onError,
}: {
  groupId: string;
  name: string;
  workspaceId: string;
  onError: (msg: string) => void;
}) {
  const utils = trpc.useUtils();
  const [expanded, setExpanded] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const members = trpc.workspaces.members.useQuery({ workspaceId });
  const groupMembers = trpc.groups.members.useQuery({ groupId }, { enabled: expanded });
  const addMember = trpc.groups.addMember.useMutation();
  const removeMember = trpc.groups.removeMember.useMutation();
  const deleteGroup = trpc.groups.delete.useMutation();

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await Promise.all([
        utils.groups.members.invalidate({ groupId }),
        utils.groups.list.invalidate({ workspaceId }),
      ]);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Something went wrong");
    }
  };

  const inGroup = new Set(groupMembers.data ?? []);
  const memberName = (userId: string) => {
    const m = (members.data ?? []).find((m) => m.userId === userId);
    return m ? `${m.name} (${m.email})` : userId;
  };

  return (
    <div className="group-row">
      <div className="group-head">
        <button className="group-name" onClick={() => setExpanded((e) => !e)}>
          <Icon name="chevron" className={"twist" + (expanded ? " open" : "")} />
          {name}
        </button>
        <RowMenu
          items={[
            {
              label: "Delete group",
              icon: "trash",
              danger: true,
              onClick: () => setConfirmingDelete(true),
            },
          ]}
        />
        {confirmingDelete && (
          <ConfirmDialog
            title="Delete group"
            body={`"${name}" will be deleted; collections shared with it lose that access.`}
            confirmLabel="Delete group"
            onClose={() => setConfirmingDelete(false)}
            onConfirm={() => void run(() => deleteGroup.mutateAsync({ groupId }))}
          />
        )}
      </div>
      {expanded && (
        <div className="group-body">
          {(groupMembers.data ?? []).map((userId) => (
            <div key={userId} className="group-member">
              <span>{memberName(userId)}</span>
              <button
                className="row-action"
                title="Remove from group"
                onClick={() => void run(() => removeMember.mutateAsync({ groupId, userId }))}
              >
                <Icon name="close" size={14} />
              </button>
            </div>
          ))}
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) {
                void run(() => addMember.mutateAsync({ groupId, userId: e.target.value }));
              }
            }}
          >
            <option value="">Add member…</option>
            {(members.data ?? [])
              .filter((m) => !inGroup.has(m.userId))
              .map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name} ({m.email})
                </option>
              ))}
          </select>
        </div>
      )}
    </div>
  );
}
