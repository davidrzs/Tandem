import { useState, type FormEvent } from "react";
import { authClient } from "../auth-client.js";

type Mode = "open" | "invite" | "domain" | "closed";

const MODE_HINTS: Record<Mode, string> = {
  open: "Anyone who reaches this server can create an account.",
  invite: "New accounts require an invite link you send from the admin console.",
  domain: "Only people with an email on an allowed domain can sign up.",
  closed: "No self sign-up. You create every account from the admin console.",
};

/**
 * First-run onboarding, shown only while the server has no users. Creates the
 * first administrator and the initial registration policy, then signs the new
 * admin in. Rendered above AuthGate (see main.tsx), so it stands in for the
 * login screen on a brand-new install.
 */
export function SetupWizard({ onComplete }: { onComplete: () => void }) {
  const [instanceName, setInstanceName] = useState("Tandem");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<Mode>("invite");
  const [domains, setDomains] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/setup/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          email,
          password,
          instanceName: instanceName.trim() || "Tandem",
          registrationMode: mode,
          allowedEmailDomains:
            mode === "domain"
              ? domains.split(",").map((d) => d.trim()).filter(Boolean)
              : [],
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Setup failed");
      }
      // Sign the new admin in to obtain a session, then hand off to the app.
      const signIn = await authClient.signIn.email({ email, password });
      if (signIn.error) throw new Error(signIn.error.message ?? "Sign-in failed");
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Setup failed");
      setBusy(false);
    }
  }

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <div className="wordmark">Tandem</div>
        <p className="auth-tagline">Set up your server.</p>
        <h1>Create the admin account</h1>

        <label className="setup-label">Server name</label>
        <input
          placeholder="Server name"
          value={instanceName}
          onChange={(e) => setInstanceName(e.target.value)}
        />

        <label className="setup-label">Your account</label>
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

        <label className="setup-label">Who can sign up?</label>
        <select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
          <option value="invite">Invite only</option>
          <option value="open">Open</option>
          <option value="domain">Specific email domains</option>
          <option value="closed">Closed (admin creates accounts)</option>
        </select>
        <p className="setup-hint">{MODE_HINTS[mode]}</p>
        {mode === "domain" && (
          <input
            placeholder="Allowed domains, comma-separated (e.g. acme.com)"
            value={domains}
            onChange={(e) => setDomains(e.target.value)}
          />
        )}

        {error && <div className="auth-error">{error}</div>}
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? "…" : "Create admin & finish"}
        </button>
      </form>
    </div>
  );
}
