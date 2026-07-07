import { useEffect, useRef, useState, type FormEvent } from "react";
import { WS_KEY } from "../App.js";
import { authClient } from "../auth-client.js";
import { trpc } from "../trpc.js";

// Carries the invite token through signup so the server's registration gate
// allows the account even in invite-only/closed mode (see registration.ts).
const INVITE_TOKEN_HEADER = "x-tandem-invite-token";

/**
 * Redeem an invite link. Rendered above AuthGate, so it works whether or not
 * the visitor already has an account: a logged-out invitee signs up through
 * the invite first, then the invite is redeemed. Handles both workspace
 * invites (join a workspace) and instance invites (the account itself is the
 * grant — nothing to join, just land in the app).
 */
export function InviteAccept({ token }: { token: string }) {
  const { data: session, isPending } = authClient.useSession();
  const accept = trpc.workspaces.acceptInvite.useMutation();
  const [error, setError] = useState<string | null>(null);
  const didSignup = useRef(false);
  const accepting = useRef(false);

  useEffect(() => {
    if (isPending || !session || accepting.current) return;
    accepting.current = true;
    accept
      .mutateAsync({ token })
      .then((ws) => {
        // Land in the workspace that was just joined, not the previous one.
        localStorage.setItem(WS_KEY, ws.id);
        window.location.assign("/");
      })
      .catch((e: { message?: string }) => {
        // A fresh signup whose token wasn't a workspace invite was an instance
        // invite — the account is already created, so just enter the app.
        if (didSignup.current) window.location.assign("/");
        else setError(e.message ?? "Failed to join");
      });
  }, [isPending, session, token, accept]);

  if (isPending) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <h1>Loading…</h1>
        </div>
      </div>
    );
  }

  if (!session) {
    return <InviteSignup token={token} onSignedUp={() => (didSignup.current = true)} />;
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <h1>{error ? "Couldn't join" : "Joining…"}</h1>
        {error && <div className="auth-error">{error}</div>}
        {error && (
          <a className="auth-toggle" href="/">
            Back to app
          </a>
        )}
      </div>
    </div>
  );
}

/** Sign-up form shown to a logged-out invitee; passes the invite token so the
 * registration gate accepts it regardless of the server's registration mode. */
function InviteSignup({ token, onSignedUp }: { token: string; onSignedUp: () => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await authClient.signUp.email(
      { email, password, name },
      { headers: { [INVITE_TOKEN_HEADER]: token } },
    );
    if (res.error) {
      setError(res.error.message ?? "Sign-up failed");
      setBusy(false);
      return;
    }
    // Session now exists; InviteAccept's effect redeems the invite.
    onSignedUp();
  }

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <div className="wordmark">Tandem</div>
        <p className="auth-tagline">You've been invited.</p>
        <h1>Create your account</h1>
        <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required />
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          type="password"
          placeholder="Password (min 8 characters)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={8}
        />
        {error && <div className="auth-error">{error}</div>}
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? "…" : "Sign up & join"}
        </button>
        <a className="auth-toggle" href="/">
          Already have an account? Sign in
        </a>
      </form>
    </div>
  );
}
