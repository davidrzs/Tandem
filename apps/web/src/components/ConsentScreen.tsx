import { useEffect, useState } from "react";
import { authClient } from "../auth-client.js";
import { submitConsent, type ConsentRequest } from "../oauth.js";
import { trpc } from "../trpc.js";
import { Icon } from "./Icon.js";

// OIDC scopes the MCP flow asks for, in plain words. Grants beyond these are
// listed raw so nothing requested is ever hidden.
const IDENTITY_SCOPES = new Set(["openid", "profile", "email"]);
const KNOWN_SCOPES = new Set([...IDENTITY_SCOPES, "offline_access"]);

export function ConsentScreen({ request }: { request: ConsentRequest }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [instanceName, setInstanceName] = useState("Tandem");
  const { data: session } = authClient.useSession();
  const client = trpc.settings.oauthClient.useQuery(
    { clientId: request.clientId },
    { enabled: !!request.clientId, retry: false },
  );
  const settings = trpc.settings.get.useQuery();

  useEffect(() => {
    fetch("/api/instance/public")
      .then((r) => r.json())
      .then((d: { instanceName?: string }) => d.instanceName && setInstanceName(d.instanceName))
      .catch(() => {});
  }, []);

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
  const otherScopes = scopes.filter((s) => !KNOWN_SCOPES.has(s));
  const name = client.data?.name;
  const hosts = client.data?.redirectHosts ?? [];
  const user = session?.user;

  return (
    <div className="auth-screen">
      <div className="auth-card consent-card">
        <div className="wordmark">{instanceName}</div>
        <h1>{name ? `Connect ${name}` : "Connect an application"}</h1>
        <p className="consent-lede">
          {name ?? "This application"} will be able to act as you in {instanceName}:
        </p>

        <ul className="consent-perms">
          <li>
            <Icon name="pen" />
            <span>Read, create, and edit the documents you can access</span>
          </li>
          {scopes.some((s) => IDENTITY_SCOPES.has(s)) && (
            <li>
              <Icon name="users" />
              <span>See your name and email address</span>
            </li>
          )}
          {scopes.includes("offline_access") && (
            <li>
              <Icon name="restore" />
              <span>Stay connected until you turn off AI access in Settings</span>
            </li>
          )}
          {otherScopes.map((s) => (
            <li key={s}>
              <Icon name="check" />
              <code>{s}</code>
            </li>
          ))}
        </ul>
        <p className="setup-hint">
          Its edits are labeled as {user?.name ? `${user.name}'s` : "your"} AI in
          document history.
        </p>

        <dl className="consent-meta">
          {user && (
            <>
              <dt>Account</dt>
              <dd title={user.email}>{user.email}</dd>
            </>
          )}
          {hosts.length > 0 && (
            <>
              <dt>Returns to</dt>
              <dd title={hosts.join(", ")}>{hosts.join(", ")}</dd>
            </>
          )}
          {!name && (
            <>
              <dt>Client ID</dt>
              <dd title={request.clientId}>{request.clientId}</dd>
            </>
          )}
        </dl>

        {settings.data?.mcpEnabled === false && (
          <p className="consent-warn">
            AI access is turned off in your Settings. This connection will be
            refused until you turn it back on.
          </p>
        )}
        {error && <div className="auth-error">{error}</div>}
        <button
          type="button"
          className="btn primary"
          onClick={() => decide(true)}
          disabled={busy}
        >
          {busy ? "…" : "Allow access"}
        </button>
        <button
          type="button"
          className="auth-toggle"
          onClick={() => decide(false)}
          disabled={busy}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
