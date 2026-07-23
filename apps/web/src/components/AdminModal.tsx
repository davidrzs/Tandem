import { useEffect, useState } from "react";
import { authClient } from "../auth-client.js";
import { friendlyError } from "../errors.js";
import { trpc } from "../trpc.js";
import { Icon } from "./Icon.js";
import { ConfirmDialog, Modal, RowMenu } from "./Modal.js";
import { timeAgo } from "./time.js";

type Mode = "open" | "invite" | "domain" | "closed";

interface AdminUser {
  id: string;
  name: string;
  email: string;
  role?: string | null;
  banned?: boolean | null;
}

/** Server administration: registration policy, the user roster, and
 * server-invite links. Instance config + invites go through tRPC (admin
 * procedures); user management rides the better-auth admin client. */
export function AdminModal({ onClose }: { onClose: () => void }) {
  const utils = trpc.useUtils();
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      // Every successful admin action lands in the audit trail below.
      await utils.admin.audit.invalidate();
    } catch (e) {
      setError(friendlyError(e));
    }
  };

  return (
    <Modal title="Server administration" onClose={onClose} wide>
      <ServerSettings onError={setError} />
      <Users onError={setError} run={run} />
      <Invites run={run} />
      <AdminActivity />
      {error && <div className="modal-error">{error}</div>}
    </Modal>
  );
}

function ServerSettings({ onError }: { onError: (m: string) => void }) {
  const utils = trpc.useUtils();
  const settings = trpc.admin.getSettings.useQuery();
  const update = trpc.admin.updateSettings.useMutation();

  const [mode, setMode] = useState<Mode>("open");
  const [domains, setDomains] = useState("");
  const [name, setName] = useState("");
  const [allowWorkspaces, setAllowWorkspaces] = useState(true);
  const [dirty, setDirty] = useState(false);

  // Seed the form once the settings load (and after a save re-fetches).
  useEffect(() => {
    if (!settings.data || dirty) return;
    setMode(settings.data.registrationMode);
    setDomains(settings.data.allowedEmailDomains.join(", "));
    setName(settings.data.instanceName);
    setAllowWorkspaces(settings.data.allowWorkspaceCreation);
  }, [settings.data, dirty]);

  const save = () =>
    void (async () => {
      try {
        await update.mutateAsync({
          registrationMode: mode,
          allowedEmailDomains: domains.split(",").map((d) => d.trim()).filter(Boolean),
          instanceName: name.trim() || "Tandem",
          allowWorkspaceCreation: allowWorkspaces,
        });
        await Promise.all([
          utils.admin.getSettings.invalidate(),
          utils.admin.audit.invalidate(),
        ]);
        setDirty(false);
      } catch (e) {
        onError(friendlyError(e));
      }
    })();

  const edit = <T,>(setter: (v: T) => void) => (v: T) => {
    setter(v);
    setDirty(true);
  };

  return (
    <>
      <h3>Server settings</h3>
      <div className="dialog-form">
        <label className="field">
          <span>Server name</span>
          <input value={name} onChange={(e) => edit(setName)(e.target.value)} />
        </label>

        <label className="field">
          <span>Who can sign up?</span>
          <select value={mode} onChange={(e) => edit<Mode>(setMode)(e.target.value as Mode)}>
            <option value="invite">Invite only</option>
            <option value="open">Open</option>
            <option value="domain">Specific email domains</option>
            <option value="closed">Closed (admin creates accounts)</option>
          </select>
        </label>
        {mode === "domain" && (
          <label className="field">
            <span>Allowed email domains</span>
            <input
              placeholder="Comma-separated (e.g. acme.com)"
              value={domains}
              onChange={(e) => edit(setDomains)(e.target.value)}
            />
          </label>
        )}
        <div className="switch-row">
          <button
            type="button"
            role="switch"
            aria-checked={allowWorkspaces}
            className="switch-btn"
            aria-label="Members can create additional workspaces"
            onClick={() => edit(setAllowWorkspaces)(!allowWorkspaces)}
          >
            <span className="switch-thumb" />
          </button>
          <span>Members can create additional workspaces</span>
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn primary" disabled={!dirty || update.isPending} onClick={save}>
            {update.isPending ? "Saving…" : "Save settings"}
          </button>
        </div>
      </div>
    </>
  );
}

function Users({
  onError,
  run,
}: {
  onError: (m: string) => void;
  run: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const meId = authClient.useSession().data?.user.id;
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [confirming, setConfirming] = useState<AdminUser | null>(null);

  const load = async () => {
    const res = await authClient.admin.listUsers({ query: { limit: 200 } });
    if (res.error) throw new Error(res.error.message ?? "Couldn't load users");
    setUsers((res.data?.users ?? []) as AdminUser[]);
  };
  useEffect(() => {
    void run(load);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const act = (fn: () => Promise<{ error?: { message?: string } | null }>) =>
    void run(async () => {
      const res = await fn();
      if (res.error) throw new Error(res.error.message ?? "Action failed");
      await load();
    });

  return (
    <>
      <h3>Users</h3>
      <ul className="member-list">
        {users.map((u) => {
          const isAdmin = u.role === "admin";
          const isSelf = u.id === meId;
          return (
            <li key={u.id}>
              <span className="member-name">
                {u.name}
                {isAdmin && " · admin"}
                {u.banned && " · banned"}
              </span>
              <span className="member-email">{u.email}</span>
              {!isSelf && (
                <RowMenu
                  items={[
                    {
                      label: isAdmin ? "Revoke admin" : "Make admin",
                      icon: "users",
                      onClick: () =>
                        act(() =>
                          authClient.admin.setRole({
                            userId: u.id,
                            role: isAdmin ? "user" : "admin",
                          }),
                        ),
                    },
                    {
                      label: u.banned ? "Unban" : "Ban",
                      onClick: () =>
                        act(() =>
                          u.banned
                            ? authClient.admin.unbanUser({ userId: u.id })
                            : authClient.admin.banUser({ userId: u.id }),
                        ),
                    },
                    {
                      label: "Delete user",
                      icon: "trash",
                      danger: true,
                      onClick: () => setConfirming(u),
                    },
                  ]}
                />
              )}
            </li>
          );
        })}
      </ul>
      {confirming && (
        <ConfirmDialog
          title="Delete user"
          body={`${confirming.name} (${confirming.email}) will be permanently removed. Their authored content stays but is no longer attributed to an active account.`}
          confirmLabel="Delete user"
          onClose={() => setConfirming(null)}
          onConfirm={() =>
            act(() => authClient.admin.removeUser({ userId: confirming.id }))
          }
        />
      )}

      <CreateUser onCreated={() => void run(load)} onError={onError} />
    </>
  );
}

/** Direct account creation — the only way in when registration is closed. */
function CreateUser({
  onCreated,
  onError,
}: {
  onCreated: () => void;
  onError: (m: string) => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      const res = await authClient.admin.createUser({ name, email, password, role: "user" });
      if (res.error) throw new Error(res.error.message ?? "Couldn't create the user");
      setName("");
      setEmail("");
      setPassword("");
      onCreated();
    } catch (e) {
      onError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="invite-row">
      <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
      <input
        type="email"
        placeholder="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <input
        type="password"
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <button type="button"
        className="btn"
        disabled={busy || !name.trim() || !email.trim() || password.length < 8}
        onClick={() => void create()}
      >
        Create user
      </button>
    </div>
  );
}

/** Instance-level audit: who changed settings, roles, bans, invites, accounts. */
function AdminActivity() {
  const audit = trpc.admin.audit.useQuery();
  return (
    <>
      <h3>Admin activity</h3>
      {audit.data && audit.data.length === 0 && (
        <p className="modal-note">No admin actions recorded yet.</p>
      )}
      {(audit.data ?? []).length > 0 && (
        <ul className="audit-list">
          {audit.data!.map((entry) => (
            <li key={entry.id}>
              <Icon name="pen" size={13} />
              <span className="audit-what">
                <strong>{entry.userName}</strong> · {entry.action.replaceAll("_", " ")}
                {entry.detail ? ` ${entry.detail}` : ""}
              </span>
              <span className="audit-when">{timeAgo(entry.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function Invites({
  run,
}: {
  run: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const utils = trpc.useUtils();
  const invites = trpc.admin.listInvites.useQuery();
  const create = trpc.admin.createInvite.useMutation();
  const revoke = trpc.admin.revokeInvite.useMutation();

  const [role, setRole] = useState<"user" | "admin">("user");
  const [expiry, setExpiry] = useState("14");
  const [email, setEmail] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  return (
    <>
      <h3>Invite people to the server</h3>
      <div className="invite-row">
        <input
          type="email"
          placeholder="Email (optional)"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <select value={role} onChange={(e) => setRole(e.target.value as "user" | "admin")}>
          <option value="user">As member</option>
          <option value="admin">As admin</option>
        </select>
        <select value={expiry} onChange={(e) => setExpiry(e.target.value)}>
          <option value="1">Expires in 1 day</option>
          <option value="7">Expires in 7 days</option>
          <option value="14">Expires in 14 days</option>
          <option value="">Never expires</option>
        </select>
        <button type="button"
          className="btn"
          disabled={create.isPending}
          onClick={() =>
            void run(async () => {
              setLink(null);
              setNote(null);
              const to = email.trim();
              const inv = await create.mutateAsync({
                role,
                ...(to ? { email: to } : {}),
                ...(expiry ? { expiresInDays: Number(expiry) } : {}),
              });
              setLink(`${window.location.origin}/invite?token=${inv.token}`);
              if (to) {
                setNote(
                  inv.emailed
                    ? `Invite emailed to ${to}.`
                    : "Couldn't email the invite — share the link below instead.",
                );
              }
              setEmail("");
              await utils.admin.listInvites.invalidate();
            })
          }
        >
          Create invite link
        </button>
      </div>
      {note && <p className="modal-note">{note}</p>}
      {link && (
        <input
          className="invite-link"
          readOnly
          value={link}
          onFocus={(e) => e.currentTarget.select()}
        />
      )}
      <ul className="member-list">
        {(invites.data ?? []).map((inv) => (
          <li key={inv.id}>
            <span className="member-name">{inv.email || "Anyone with the link"}</span>
            <span className="member-email">{inv.role}</span>
            <RowMenu
              items={[
                {
                  label: "Revoke",
                  icon: "trash",
                  danger: true,
                  onClick: () =>
                    void run(async () => {
                      await revoke.mutateAsync({ id: inv.id });
                      await utils.admin.listInvites.invalidate();
                    }),
                },
              ]}
            />
          </li>
        ))}
      </ul>
    </>
  );
}
