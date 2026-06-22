// End-to-end OAuth verification against a running server (PORT 3001): the full
// flow the SPA consent UI + an MCP client drive — sign up, dynamic client
// registration, PKCE authorize, consent approval, token exchange, then an
// authenticated /mcp call. No browser needed; this exercises the server side.
import { createHash, randomBytes } from "node:crypto";

const BASE = "http://localhost:3001";
const b64url = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// --- cookie jar (merge by name so each response augments, not replaces) ---
const jar = new Map();
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    redirect: "manual",
    headers: {
      origin: "http://localhost:5173", // a trusted origin (Better Auth CSRF check)
      ...(init.headers ?? {}),
      ...(jar.size ? { cookie: cookieHeader() } : {}),
    },
  });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return res;
}

// 1. Sign up (establishes a session).
const email = `oauth${Date.now()}@example.com`;
const signup = await api("/api/auth/sign-up/email", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password: "supersecret123", name: "OAuth User" }),
});
if (jar.size === 0) {
  throw new Error(
    `no session cookie after sign-up (status ${signup.status}): ${(await signup.text()).slice(0, 200)}`,
  );
}

// 2. Dynamic client registration.
const reg = await (await api("/api/auth/mcp/register", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    redirect_uris: ["http://localhost:9999/cb"],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"],
    client_name: "Flow Test Client",
  }),
})).json();
const clientId = reg.client_id;
if (!clientId) throw new Error(`no client_id from DCR: ${JSON.stringify(reg)}`);

// 3. PKCE + authorize (logged in, prompt=consent -> redirect to consent page).
const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash("sha256").update(verifier).digest());
const authQ = new URLSearchParams({
  response_type: "code",
  client_id: clientId,
  redirect_uri: "http://localhost:9999/cb",
  code_challenge: challenge,
  code_challenge_method: "S256",
  scope: "openid profile",
  state: "xyz",
  prompt: "consent",
});
const authRes = await api(`/api/auth/mcp/authorize?${authQ}`);
const consentLocation = authRes.headers.get("location") ?? "";
if (!consentLocation.includes("/oauth/consent")) {
  throw new Error(`expected redirect to consent page, got ${authRes.status} -> ${consentLocation}`);
}
const consentCode = new URL(consentLocation, BASE).searchParams.get("consent_code");
if (!consentCode) throw new Error("no consent_code in consent redirect");

// 4. Approve consent (what the SPA ConsentScreen does).
const consent = await (await api("/api/auth/oauth2/consent", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ accept: true, consent_code: consentCode }),
})).json();
const redirectURI = consent.redirectURI;
const code = new URL(redirectURI).searchParams.get("code");
if (!code) throw new Error(`no code in redirectURI: ${redirectURI}`);

// 5. Token exchange (PKCE).
const tokenRes = await (await api("/api/auth/mcp/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: "http://localhost:9999/cb",
    client_id: clientId,
    code_verifier: verifier,
  }).toString(),
})).json();
const accessToken = tokenRes.access_token;
if (!accessToken) throw new Error(`no access_token: ${JSON.stringify(tokenRes)}`);

// 6. Authenticated MCP call with the bearer token.
const mcpRes = await fetch(`${BASE}/mcp`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${accessToken}`,
  },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
});
if (mcpRes.status !== 200) throw new Error(`/mcp with token returned ${mcpRes.status}`);
const text = await mcpRes.text();
if (!text.includes("append_section")) throw new Error(`tools/list missing tools: ${text.slice(0, 200)}`);

console.log("OAUTH FLOW PASS — DCR -> PKCE authorize -> consent -> token -> authenticated /mcp tools/list");
