import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { authClient } from "../auth-client.js";

interface PublicSettings {
  instanceName: string;
  registrationMode: "open" | "invite" | "domain" | "closed";
  allowedEmailDomains: string[];
}

export function AuthGate({ children }: { children: ReactNode }) {
  const { data: session, isPending } = authClient.useSession();

  if (isPending) return <div className="empty">Loading…</div>;
  if (!session) return <AuthForm />;
  return <>{children}</>;
}

function AuthForm() {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
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

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = showSignup
      ? await authClient.signUp.email({ email, password, name })
      : await authClient.signIn.email({ email, password });
    setBusy(false);
    if (res.error) setError(res.error.message ?? "Something went wrong");
    // On success the session updates reactively and the gate re-renders.
  }

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <div className="wordmark">{instance?.instanceName || "Tandem"}</div>
        <p className="auth-tagline">The wiki that knows who wrote what.</p>
        <h1>{showSignup ? "Create your account" : "Sign in"}</h1>
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
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={8}
        />
        {showSignup && instance?.registrationMode === "domain" && instance.allowedEmailDomains.length > 0 && (
          <p className="setup-hint">
            Sign-ups are limited to: {instance.allowedEmailDomains.join(", ")}
          </p>
        )}
        {error && <div className="auth-error">{error}</div>}
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? "…" : showSignup ? "Sign up" : "Sign in"}
        </button>
        {canSelfRegister && (
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
      </form>
    </div>
  );
}
