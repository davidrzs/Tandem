import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { authClient } from "../auth-client.js";

interface PublicSettings {
  instanceName: string;
  registrationMode: "open" | "invite" | "domain" | "closed";
  allowedEmailDomains: string[];
  /** True when the server can send email (SMTP configured) — gates the
   * self-service "forgot password" flow. */
  emailEnabled: boolean;
}

export function AuthGate({ children }: { children: ReactNode }) {
  const { data: session, isPending } = authClient.useSession();
  // A 2FA-enrolled sign-in has no session until the second factor verifies.
  // This lives here, not in AuthForm: the sign-in attempt triggers a session
  // refetch that briefly remounts AuthForm, which would drop the flag.
  const [twoFactorPending, setTwoFactorPending] = useState(false);

  if (twoFactorPending && !session) return <TwoFactorChallenge />;
  if (isPending) return <div className="empty">Loading…</div>;
  if (!session) return <AuthForm onTwoFactorRequired={() => setTwoFactorPending(true)} />;
  return <>{children}</>;
}

function AuthForm({ onTwoFactorRequired }: { onTwoFactorRequired: () => void }) {
  const [mode, setMode] = useState<"signin" | "signup" | "forgot">("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [instance, setInstance] = useState<PublicSettings | null>(null);

  useEffect(() => {
    fetch("/api/instance/public")
      .then((r) => r.json())
      .then((d: PublicSettings) => setInstance(d))
      .catch(() => setInstance(null));
  }, []);

  // Self-registration is only offered when the server allows it. In invite-only
  // and closed modes there's no public signup path (invitees sign up through
  // their invite link), so the toggle is hidden and we stay on sign-in.
  const canSelfRegister =
    instance?.registrationMode === "open" || instance?.registrationMode === "domain";
  const showSignup = mode === "signup" && canSelfRegister;
  const showForgot = mode === "forgot";

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    if (showForgot) {
      // Deliberately the same response whether or not the account exists.
      const res = await authClient.requestPasswordReset({
        email,
        redirectTo: "/reset-password",
      });
      setBusy(false);
      if (res.error) {
        setError(res.error.message ?? "Couldn't send the reset email");
        return;
      }
      setNotice("If that account exists, a reset link is on its way.");
      return;
    }
    const res = showSignup
      ? await authClient.signUp.email({ email, password, name })
      : await authClient.signIn.email({ email, password });
    setBusy(false);
    if (res.error) {
      setError(res.error.message ?? "Something went wrong");
      return;
    }
    // An enrolled account needs its second factor before a session exists.
    if (res.data && "twoFactorRedirect" in res.data && res.data.twoFactorRedirect) {
      onTwoFactorRequired();
    }
    // Otherwise the session updates reactively and the gate re-renders.
  }

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <div className="wordmark">{instance?.instanceName || "Tandem"}</div>
        <p className="auth-tagline">The wiki that knows who wrote what.</p>
        <h1>
          {showForgot ? "Reset your password" : showSignup ? "Create your account" : "Sign in"}
        </h1>
        {showForgot && (
          <p className="setup-hint">
            Enter your account email and we'll send a reset link.
          </p>
        )}
        {showSignup && (
          <input
            placeholder="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        )}
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        {!showForgot && (
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
          />
        )}
        {showSignup && instance?.registrationMode === "domain" && instance.allowedEmailDomains.length > 0 && (
          <p className="setup-hint">
            Sign-ups are limited to: {instance.allowedEmailDomains.join(", ")}
          </p>
        )}
        {error && <div className="auth-error">{error}</div>}
        {notice && <p className="setup-hint">{notice}</p>}
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? "…" : showForgot ? "Send reset link" : showSignup ? "Sign up" : "Sign in"}
        </button>
        {canSelfRegister && !showForgot && (
          <button
            type="button"
            className="auth-toggle"
            onClick={() => setMode(mode === "signup" ? "signin" : "signup")}
          >
            {mode === "signup"
              ? "Have an account? Sign in"
              : "Need an account? Sign up"}
          </button>
        )}
        {instance?.emailEnabled && mode === "signin" && (
          <button type="button" className="auth-toggle" onClick={() => setMode("forgot")}>
            Forgot your password?
          </button>
        )}
        {showForgot && (
          <button
            type="button"
            className="auth-toggle"
            onClick={() => {
              setMode("signin");
              setNotice(null);
              setError(null);
            }}
          >
            Back to sign in
          </button>
        )}
      </form>
    </div>
  );
}

/** Landing page for the emailed reset link (`/reset-password?token=…`).
 * Renders outside AuthGate — the user has no session here. */
export function ResetPassword({ token }: { token: string }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError("Passwords don't match");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await authClient.resetPassword({ newPassword: password, token });
    setBusy(false);
    if (res.error) {
      setError(res.error.message ?? "That link is invalid or expired");
      return;
    }
    setDone(true);
  }

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <div className="wordmark">Tandem</div>
        <h1>Choose a new password</h1>
        {done ? (
          <>
            <p className="setup-hint">Your password is updated.</p>
            <button type="button" className="btn primary" onClick={() => window.location.assign("/")}>
              Sign in
            </button>
          </>
        ) : (
          <>
            <input
              type="password"
              placeholder="New password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              autoFocus
            />
            <input
              type="password"
              placeholder="Repeat new password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              minLength={8}
            />
            {error && <div className="auth-error">{error}</div>}
            <button type="submit" className="btn primary" disabled={busy}>
              {busy ? "…" : "Set new password"}
            </button>
          </>
        )}
      </form>
    </div>
  );
}

/** Second step of sign-in for a 2FA-enrolled account: a TOTP code from the
 * authenticator app, or one of the single-use backup codes. */
function TwoFactorChallenge() {
  const [code, setCode] = useState("");
  const [useBackup, setUseBackup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const trimmed = code.trim();
    const res = useBackup
      ? await authClient.twoFactor.verifyBackupCode({ code: trimmed })
      : await authClient.twoFactor.verifyTotp({ code: trimmed });
    setBusy(false);
    if (res.error) {
      setError(res.error.message ?? "That code didn't work");
      return;
    }
    // The verified session cookie is set; reload so the gate re-evaluates.
    window.location.assign("/");
  }

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <div className="wordmark">Tandem</div>
        <h1>Two-factor authentication</h1>
        <p className="setup-hint">
          {useBackup
            ? "Enter one of your single-use backup codes."
            : "Enter the 6-digit code from your authenticator app."}
        </p>
        <input
          placeholder={useBackup ? "Backup code" : "123456"}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoFocus
          required
        />
        {error && <div className="auth-error">{error}</div>}
        <button type="submit" className="btn primary" disabled={busy || !code.trim()}>
          {busy ? "…" : "Verify"}
        </button>
        <button
          type="button"
          className="auth-toggle"
          onClick={() => {
            setUseBackup((b) => !b);
            setCode("");
            setError(null);
          }}
        >
          {useBackup ? "Use an authenticator code" : "Use a backup code"}
        </button>
      </form>
    </div>
  );
}
