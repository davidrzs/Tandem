import { useEffect, useState } from "react";
import { authClient } from "../auth-client.js";
import { timeAgo } from "./time.js";
import { useToast } from "./toast.js";

interface SessionRow {
  token: string;
  createdAt: Date | string;
  userAgent?: string | null;
}

/** Short human label for a session's browser/OS from its user agent. */
function agentLabel(ua: string | null | undefined): string {
  if (!ua) return "Unknown device";
  const browser =
    /firefox\//i.test(ua) ? "Firefox"
    : /edg\//i.test(ua) ? "Edge"
    : /chrome\//i.test(ua) ? "Chrome"
    : /safari\//i.test(ua) ? "Safari"
    : "Browser";
  const os =
    /windows/i.test(ua) ? "Windows"
    : /mac os x/i.test(ua) ? "macOS"
    : /android/i.test(ua) ? "Android"
    : /iphone|ipad|ios/i.test(ua) ? "iOS"
    : /linux/i.test(ua) ? "Linux"
    : "";
  return os ? `${browser} on ${os}` : browser;
}

/** Profile + credentials + active sessions (Settings > Account). */
export function AccountSection() {
  const session = authClient.useSession();
  const toast = useToast();

  const [name, setName] = useState("");
  const [nameLoaded, setNameLoaded] = useState(false);
  useEffect(() => {
    if (!nameLoaded && session.data) {
      setName(session.data.user.name ?? "");
      setNameLoaded(true);
    }
  }, [session.data, nameLoaded]);

  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const loadSessions = () => {
    void authClient.listSessions().then((res) => {
      if (!res.error) setSessions(res.data as SessionRow[]);
    });
  };
  useEffect(loadSessions, []);

  const saveName = async () => {
    setBusy(true);
    setError(null);
    const res = await authClient.updateUser({ name: name.trim() });
    setBusy(false);
    if (res.error) {
      setError(res.error.message ?? "Couldn't update your name");
      return;
    }
    toast("Name updated");
    await session.refetch();
  };

  const changePassword = async () => {
    setBusy(true);
    setError(null);
    const res = await authClient.changePassword({
      currentPassword: currentPw,
      newPassword: newPw,
      revokeOtherSessions: true,
    });
    setBusy(false);
    if (res.error) {
      setError(res.error.message ?? "Couldn't change the password");
      return;
    }
    setCurrentPw("");
    setNewPw("");
    toast("Password changed — other sessions were signed out");
    loadSessions();
  };

  const revoke = async (token: string) => {
    const res = await authClient.revokeSession({ token });
    if (res.error) {
      setError(res.error.message ?? "Couldn't sign out that session");
      return;
    }
    toast("Session signed out");
    loadSessions();
  };

  const currentToken = session.data?.session.token;

  return (
    <>
      <h3>Account</h3>
      <div className="invite-row">
        <input
          value={name}
          placeholder="Display name"
          aria-label="Display name"
          onChange={(e) => setName(e.target.value)}
        />
        <button type="button"
          className="btn"
          disabled={busy || !name.trim() || name.trim() === session.data?.user.name}
          onClick={() => void saveName()}
        >
          Update name
        </button>
      </div>
      <div className="invite-row">
        <input
          type="password"
          placeholder="Current password"
          aria-label="Current password"
          value={currentPw}
          onChange={(e) => setCurrentPw(e.target.value)}
        />
        <input
          type="password"
          placeholder="New password (min 8)"
          aria-label="New password"
          minLength={8}
          value={newPw}
          onChange={(e) => setNewPw(e.target.value)}
        />
        <button type="button"
          className="btn"
          disabled={busy || !currentPw || newPw.length < 8}
          onClick={() => void changePassword()}
        >
          Change password
        </button>
      </div>
      <p className="modal-note">
        Changing your password signs out your other sessions.
      </p>

      {sessions && sessions.length > 0 && (
        <>
          <h3>Active sessions</h3>
          <ul className="member-list">
            {sessions.map((s) => (
              <li key={s.token}>
                <span className="member-name">{agentLabel(s.userAgent)}</span>
                <span className="member-email">
                  {s.token === currentToken
                    ? "This session"
                    : `Signed in ${timeAgo(new Date(s.createdAt))}`}
                </span>
                {s.token !== currentToken && (
                  <button type="button" className="btn" onClick={() => void revoke(s.token)}>
                    Sign out
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {error && <div className="modal-error">{error}</div>}
    </>
  );
}
