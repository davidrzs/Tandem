// Minimal OAuth-flow plumbing for the no-router SPA. Better Auth's MCP authorize
// endpoint drives the browser here via two redirects:
//   - unauthenticated -> loginPage `/?<original authorize query>`
//   - authenticated + prompt=consent -> `/oauth/consent?consent_code&client_id&scope`

export interface ConsentRequest {
  consentCode: string;
  clientId: string;
  scope: string;
}

/** The consent screen context, if the browser is on the consent page. */
export function consentContext(): ConsentRequest | null {
  if (window.location.pathname !== "/oauth/consent") return null;
  const p = new URLSearchParams(window.location.search);
  const consentCode = p.get("consent_code");
  if (!consentCode) return null;
  return {
    consentCode,
    clientId: p.get("client_id") ?? "",
    scope: p.get("scope") ?? "",
  };
}

/** If we're on `/` with a pending authorize request, the query to resume with. */
export function authorizeResumeQuery(): string | null {
  if (window.location.pathname !== "/") return null;
  const p = new URLSearchParams(window.location.search);
  if (!p.get("client_id") || !p.get("redirect_uri")) return null;
  return window.location.search; // includes leading "?"
}

/** Approve/deny consent; returns the URL to send the browser back to the client. */
export async function submitConsent(
  accept: boolean,
  consentCode: string,
): Promise<string> {
  const res = await fetch("/api/auth/oauth2/consent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ accept, consent_code: consentCode }),
  });
  const data = (await res.json()) as { redirectURI?: string };
  if (!data.redirectURI) throw new Error("consent failed");
  return data.redirectURI;
}
