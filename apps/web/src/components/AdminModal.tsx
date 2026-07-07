import { useEffect, useState } from "react";
import { authClient } from "../auth-client.js";
import { friendlyError } from "../errors.js";
import { trpc } from "../trpc.js";
import { ConfirmDialog, Modal, RowMenu } from "./Modal.js";

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
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(friendlyError(e));
    }
  };

  return (
    <Modal title="Server administration" onClose={onClose} wide>
      <ServerSettings onError={setError} />
      <Users onError={setError} run={run} />
      <Invites onError={setError} run={run} />
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
  const [dirty, setDirty] = useState(false);

  // Seed the form once the settings load (and after a save re-fetches).
  useEffect(() => {
    if (!settings.data || dirty) return;
    setMode(settings.data.registrationMode);
    setDomains(settings.data.allowedEmailDomains.join(", "));
    setName(settings.data.instanceName);
  }, [settings.data, dirty]);

  const save = () =>
    void (async () => {
      try {
        await update.mutateAsync({
          registrationMode: mode,
          allowedEmailDomains: domains.split(",").map((d) => d.trim()).filter(Boolean),
          instanceName: name.trim() || "Tandem",
        });
        await utils.admin.getSettings.invalidate();
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
      <label className="setup-label">Server name</label>
      <input value={name} onChange={(e) => edit(setName)(e.target.value)} />

      <label className="setup-label">Who can sign up?</label>
      <select value={mode} onChange={(e) => edit<Mode>(setMode)(e.target.value as Mode)}>
        <option value="invite">Invite only</option>
        <option value="open">Open</option>
        <option value="domain">Specific email domains</option>
        <option value="closed">Closed (admin creates accounts)</option>
      </select>
      {mode === "domain" && (
        <input
          placeholder="Allowed domains, comma-separated (e.g. acme.com)"
          value={domains}
          onChange={(e) => edit(setDomains)(e.target.value)}
        />
      )}
      <div className="dialog-actions">
        <button className="btn primary" disabled={!dirty || update.isPending} onClick={save}>
          {update.isPending ? "Saving…" : "Save settings"}
        </button>
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
    </>
  );
}

function Invites({
  onError,
  run,
}: {
  onError: (m: string) => void;
  run: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const utils = trpc.useUtils();
  const invites = trpc.admin.listInvites.useQuery();
  const create = trpc.admin.createInvite.useMutation();
  const revoke = trpc.admin.revokeInvite.useMutation();

  const [role, setRole] = useState<"user" | "admin">("user");
  const [expiry, setExpiry] = useState("14");
  const [link, setLink] = useState<string | null>(null);

  return (
    <>
      <h3>Invite people to the server</h3>
      <div className="invite-row">
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
        <button
          className="btn"
          disabled={create.isPending}
          onClick={() =>
            void run(async () => {
              setLink(null);
              const inv = await create.mutateAsync({
                role,
                ...(expiry ? { expiresInDays: Number(expiry) } : {}),
              });
              setLink(`${window.location.origin}/invite?token=${inv.token}`);
              await utils.admin.listInvites.invalidate();
            })
          }
        >
          Create invite link
        </button>
      </div>
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
