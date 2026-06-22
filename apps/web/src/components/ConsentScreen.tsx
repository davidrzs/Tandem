import { useState } from "react";
import { submitConsent, type ConsentRequest } from "../oauth.js";

export function ConsentScreen({ request }: { request: ConsentRequest }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(accept: boolean) {
    setBusy(true);
    setError(null);
    try {
      window.location.href = await submitConsent(accept, request.consentCode);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
      setBusy(false);
    }
  }

  const scopes = request.scope.split(/\s+/).filter(Boolean);

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <h1>Authorize access</h1>
        <p>
          An application (<code>{request.clientId}</code>) wants to access your
          wiki on your behalf.
        </p>
        {scopes.length > 0 && (
          <ul className="consent-scopes">
            {scopes.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        )}
        {error && <div className="auth-error">{error}</div>}
        <button type="button" onClick={() => decide(true)} disabled={busy}>
          {busy ? "…" : "Allow"}
        </button>
        <button
          type="button"
          className="auth-toggle"
          onClick={() => decide(false)}
          disabled={busy}
        >
          Deny
        </button>
      </div>
    </div>
  );
}
