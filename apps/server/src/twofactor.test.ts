import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { createDatabase, migrateDatabase, user } from "@tandem/db";
import { buildHttpServer } from "./http.js";

process.env.BETTER_AUTH_SECRET ??= "test-secret-value-at-least-16-chars-long";

// Minimal RFC 6238 TOTP (SHA-1 unless the otpauth URI says otherwise) so the
// test can act as the authenticator app without adding a dependency.
function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of input.replace(/=+$/, "").toUpperCase()) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function totpFromUri(totpURI: string, at = Date.now()): string {
  const params = new URL(totpURI).searchParams;
  const secret = params.get("secret")!;
  const digits = Number(params.get("digits") ?? 6);
  const period = Number(params.get("period") ?? 30);
  const algorithm = (params.get("algorithm") ?? "SHA1").toLowerCase().replace("-", "");
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / period)));
  const h = createHmac(algorithm, base32Decode(secret)).update(counter).digest();
  const off = h[h.length - 1]! & 0xf;
  const code =
    (((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!) %
    10 ** digits;
  return code.toString().padStart(digits, "0");
}

const ORIGIN = { origin: "http://localhost:5173", "content-type": "application/json" };

function cookieOf(r: { headers: Record<string, unknown> }): string {
  const sc = r.headers["set-cookie"];
  if (!sc) return "";
  const arr = Array.isArray(sc) ? sc : [sc];
  return arr.map((c: string) => c.split(";")[0]).join("; ");
}

test("TOTP 2FA: enroll, challenge on sign-in, backup code is single-use", async () => {
  const db = createDatabase("memory://");
  await migrateDatabase(db);
  const app = await buildHttpServer(db);
  try {
    await app.ready();
    await app.inject({
      method: "POST",
      url: "/api/setup/init",
      payload: { name: "Dana", email: "dana@x.com", password: "password123", registrationMode: "closed" },
    });
    const signin1 = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: ORIGIN,
      payload: { email: "dana@x.com", password: "password123" },
    });
    const session1 = cookieOf(signin1);

    // Enrollment: password -> totpURI + backup codes; inactive until verified.
    const enable = await app.inject({
      method: "POST",
      url: "/api/auth/two-factor/enable",
      headers: { ...ORIGIN, cookie: session1 },
      payload: { password: "password123" },
    });
    assert.equal(enable.statusCode, 200, enable.body);
    const { totpURI, backupCodes } = enable.json() as { totpURI: string; backupCodes: string[] };
    assert.ok(totpURI.startsWith("otpauth://totp/"));
    assert.ok(backupCodes.length > 0);

    const verifySetup = await app.inject({
      method: "POST",
      url: "/api/auth/two-factor/verify-totp",
      headers: { ...ORIGIN, cookie: session1 },
      payload: { code: totpFromUri(totpURI) },
    });
    assert.equal(verifySetup.statusCode, 200, verifySetup.body);
    const [row] = await db
      .select({ enabled: user.twoFactorEnabled })
      .from(user)
      .where(eq(user.email, "dana@x.com"));
    assert.equal(row!.enabled, true, "twoFactorEnabled set after verification");

    // Fresh sign-in now returns the 2FA challenge instead of a session.
    const signin2 = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: ORIGIN,
      payload: { email: "dana@x.com", password: "password123" },
    });
    assert.equal(signin2.statusCode, 200, signin2.body);
    assert.equal((signin2.json() as { twoFactorRedirect?: boolean }).twoFactorRedirect, true);
    const challengeCookie = cookieOf(signin2);
    const noSession = await app.inject({
      method: "GET",
      url: "/api/auth/get-session",
      headers: { cookie: challengeCookie },
    });
    assert.ok(!noSession.json(), "no session before the second factor");

    // A valid code completes the sign-in.
    const verify2 = await app.inject({
      method: "POST",
      url: "/api/auth/two-factor/verify-totp",
      headers: { ...ORIGIN, cookie: challengeCookie },
      payload: { code: totpFromUri(totpURI) },
    });
    assert.equal(verify2.statusCode, 200, verify2.body);
    const full = await app.inject({
      method: "GET",
      url: "/api/auth/get-session",
      headers: { cookie: cookieOf(verify2) },
    });
    assert.equal(full.json()?.user?.email, "dana@x.com", "session established");

    // Backup code path: works once, then never again.
    const signin3 = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: ORIGIN,
      payload: { email: "dana@x.com", password: "password123" },
    });
    const backup = backupCodes[0]!;
    const useBackup = await app.inject({
      method: "POST",
      url: "/api/auth/two-factor/verify-backup-code",
      headers: { ...ORIGIN, cookie: cookieOf(signin3) },
      payload: { code: backup },
    });
    assert.equal(useBackup.statusCode, 200, useBackup.body);

    const signin4 = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: ORIGIN,
      payload: { email: "dana@x.com", password: "password123" },
    });
    const reuse = await app.inject({
      method: "POST",
      url: "/api/auth/two-factor/verify-backup-code",
      headers: { ...ORIGIN, cookie: cookieOf(signin4) },
      payload: { code: backup },
    });
    assert.ok(reuse.statusCode >= 400, `spent backup code refused (got ${reuse.statusCode})`);
  } finally {
    await app.close();
    await db.$dispose();
  }
});
