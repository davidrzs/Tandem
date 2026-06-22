// Verifies the OAuth consent SCREEN in the browser: a logged-in user hitting
// the authorize endpoint (prompt=consent) is shown the consent UI, and Allow
// sends them back to the client's redirect_uri with an authorization code.
// Assumes web (5173) + api (3001) running (run.sh).
import { createHash, randomBytes } from "node:crypto";
import { chromium } from "playwright";

const BASE = "http://localhost:5173";
const b64url = (b) =>
  b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash("sha256").update(verifier).digest());

// Register an OAuth client (dynamic client registration — no session needed).
const reg = await (
  await fetch(`${BASE}/api/auth/mcp/register`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({
      redirect_uris: ["http://localhost:9999/cb"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      client_name: "Browser Consent Test",
    }),
  })
).json();
const clientId = reg.client_id;
if (!clientId) throw new Error(`DCR failed: ${JSON.stringify(reg)}`);

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

try {
  // Stub the client's redirect target so the final redirect lands somewhere.
  await page.route("http://localhost:9999/**", (r) =>
    r.fulfill({ status: 200, contentType: "text/html", body: "<html>ok</html>" }),
  );

  // Sign up (establishes a session in the browser).
  await page.goto(BASE);
  await page.getByText("Need an account? Sign up").click();
  await page.fill('input[placeholder="Name"]', "Consent User");
  await page.fill('input[type="email"]', `consent${Date.now()}@example.com`);
  await page.fill('input[type="password"]', "supersecret123");
  await page.click('button[type="submit"]');
  await page.waitForSelector(".sidebar");

  // Hit the authorize endpoint -> redirects to the consent screen.
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "http://localhost:9999/cb",
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "openid profile",
    state: "st",
    prompt: "consent",
  });
  await page.goto(`${BASE}/api/auth/mcp/authorize?${q}`);

  // The consent UI renders.
  await page.waitForSelector(".auth-card");
  const cardText = await page.textContent(".auth-card");
  if (!cardText.includes("Authorize access"))
    throw new Error(`consent screen not shown: ${cardText}`);
  if (!cardText.includes(clientId)) throw new Error("client id not shown on consent");

  // Allow -> back to the client redirect_uri with a code.
  await page.getByRole("button", { name: "Allow" }).click();
  await page.waitForURL(/localhost:9999\/cb/, { timeout: 10000 });
  const code = new URL(page.url()).searchParams.get("code");
  if (!code) throw new Error(`no authorization code in redirect: ${page.url()}`);

  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
  console.log("CONSENT PASS — consent screen shown, Allow returns an auth code to the client");
} finally {
  await browser.close();
}
