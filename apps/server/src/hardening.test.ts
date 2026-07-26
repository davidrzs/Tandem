import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkspaceService } from "@tandem/core";
import {
  createDatabase,
  migrateDatabase,
  SYSTEM,
  user,
  userSettings,
  workspaceMembers,
} from "@tandem/db";
import { eq } from "drizzle-orm";
import { buildHttpServer, mcpAccessError } from "./http.js";
import { mintImageUploadToken, readImageBytes } from "./images.js";
import { createServices } from "./services.js";

process.env.BETTER_AUTH_SECRET ??= "test-secret-value-at-least-16-chars-long";

test("production boot fails fast when public URLs are missing", async () => {
  const saved = {
    NODE_ENV: process.env.NODE_ENV,
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
    WEB_ORIGIN: process.env.WEB_ORIGIN,
  };
  try {
    process.env.NODE_ENV = "production";
    delete process.env.BETTER_AUTH_URL;
    delete process.env.WEB_ORIGIN;
    await assert.rejects(() => buildHttpServer(), /BETTER_AUTH_URL must be set/);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k as keyof typeof saved];
      else process.env[k as keyof typeof saved] = v;
    }
  }
});

test("sign-in attempts are rate limited per IP", async () => {
  const db = createDatabase("memory://");
  await migrateDatabase(db);
  const app = await buildHttpServer(db);
  try {
    await app.ready();
    let limited = false;
    for (let i = 0; i < 21; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        payload: { email: "guess@x.com", password: `wrong-${i}` },
      });
      if (res.statusCode === 429) {
        limited = true;
        assert.ok(i >= 19, `not limited too early (attempt ${i + 1})`);
        break;
      }
      assert.ok(res.statusCode < 500, `no server error (got ${res.statusCode})`);
    }
    assert.ok(limited, "the 21st attempt within a minute is refused");
  } finally {
    await app.close();
    await db.$dispose();
  }
});

test("sign-up attempts are rate limited per IP", async () => {
  const db = createDatabase("memory://");
  await migrateDatabase(db);
  const app = await buildHttpServer(db);
  try {
    await app.ready();
    let limited = false;
    for (let i = 0; i < 11; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/sign-up/email",
        payload: { name: `U${i}`, email: `u${i}@x.com`, password: "password123" },
      });
      if (res.statusCode === 429) {
        limited = true;
        assert.ok(i >= 9, `not limited too early (attempt ${i + 1})`);
        break;
      }
      assert.ok(res.statusCode < 500, `no server error (got ${res.statusCode})`);
    }
    assert.ok(limited, "the 11th sign-up within a minute is refused");
  } finally {
    await app.close();
    await db.$dispose();
  }
});

test("mcpAccessError: missing, banned, and switched-off accounts are refused", async () => {
  const db = createDatabase("memory://");
  await migrateDatabase(db);
  try {
    assert.match((await mcpAccessError(db, "ghost"))!, /no longer exists/);

    await db.insert(user).values({
      id: "u-ok",
      name: "Ok",
      email: "ok@x.com",
      updatedAt: new Date(),
    });
    assert.equal(await mcpAccessError(db, "u-ok"), null, "healthy account allowed");

    await db.insert(user).values({
      id: "u-banned",
      name: "Banned",
      email: "banned@x.com",
      banned: true,
      updatedAt: new Date(),
    });
    assert.match((await mcpAccessError(db, "u-banned"))!, /banned/);

    await db.insert(userSettings).values({ userId: "u-ok", mcpEnabled: false });
    assert.match((await mcpAccessError(db, "u-ok"))!, /turned off/);
  } finally {
    await db.$dispose();
  }
});

test("/mcp body limit fits base64 image uploads but caps runaway payloads", async () => {
  const db = createDatabase("memory://");
  await migrateDatabase(db);
  const app = await buildHttpServer(db);
  try {
    await app.ready();
    const rpc = (filler: number) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "upload_image",
          arguments: { data: "A".repeat(filler), mime: "image/png" },
        },
      });
    // 2MiB: over Fastify's 1MiB default (lifted for this route), so the
    // parser accepts it and auth is what rejects the request.
    const parsed = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { "content-type": "application/json" },
      payload: rpc(2 * 1024 * 1024),
    });
    assert.equal(parsed.statusCode, 401);
    // Over the MCP body limit: refused before anything else runs.
    const oversized = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { "content-type": "application/json" },
      payload: rpc(13 * 1024 * 1024),
    });
    assert.equal(oversized.statusCode, 413);
  } finally {
    await app.close();
    await db.$dispose();
  }
});

test("direct image upload: token-gated, mime-checked, bytes land on disk", async () => {
  const db = createDatabase("memory://");
  await migrateDatabase(db);
  const savedUploads = process.env.UPLOADS_DIR;
  const uploadsTmp = await mkdtemp(join(tmpdir(), "tandem-upload-"));
  process.env.UPLOADS_DIR = uploadsTmp;
  const app = await buildHttpServer(db);
  const secret = process.env.BETTER_AUTH_SECRET!;
  try {
    await app.ready();
    await db.insert(user).values({
      id: "up1",
      name: "Uploader",
      email: "uploader@x.com",
      updatedAt: new Date(),
    });
    const ws = await new WorkspaceService(db, SYSTEM).provisionForUser("up1", {
      name: "Up",
      slug: "up",
    });

    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    // The file is the ONLY part: alt rides in the token, because a multipart
    // field that trails the file is silently dropped whenever the parser
    // finishes the file stream before reaching it.
    const boundary = "----tandem-test-boundary";
    const multipart = (mime: string) =>
      Buffer.concat([
        Buffer.from(
          `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="dot.png"\r\n` +
            `content-type: ${mime}\r\n\r\n`,
        ),
        png,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
    const post = (token: string | null, mime = "image/png") =>
      app.inject({
        method: "POST",
        url: "/api/images/upload",
        headers: {
          "content-type": `multipart/form-data; boundary=${boundary}`,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        payload: multipart(mime),
      });

    // No token / garbage / tampered signature / expired: all refused.
    assert.equal((await post(null)).statusCode, 401);
    assert.equal((await post("garbage")).statusCode, 401);
    const { token } = mintImageUploadToken(secret, {
      userId: "up1",
      workspaceId: ws.id,
      alt: "tiny [dot]\non disk",
    });
    const [payload64, sig] = token.split(".");
    assert.equal((await post(`${payload64}.${sig!.slice(0, -2)}xx`)).statusCode, 401);
    const stale = Buffer.from(
      JSON.stringify({ u: "up1", w: ws.id, a: "", exp: Date.now() - 1000 }),
    ).toString("base64url");
    const staleToken = `${stale}.${createHmac("sha256", secret).update(stale).digest("base64url")}`;
    assert.equal((await post(staleToken)).statusCode, 401);

    // Wrong content type is refused even with a valid token.
    assert.equal((await post(token, "image/svg+xml")).statusCode, 415);

    // Valid token: bytes land on disk, metadata is workspace-scoped, and the
    // response carries the embeddable snippet with the token's alt text
    // (brackets and newlines stripped so the snippet stays one markdown node).
    const ok = await post(token);
    assert.equal(ok.statusCode, 200);
    const img = ok.json();
    assert.equal(img.url, `/api/images/${img.id}`);
    assert.equal(img.markdown, `![tiny dot on disk](/api/images/${img.id})`);
    assert.deepEqual(await readImageBytes(img.id), png);
    const services = createServices(db, { kind: "user", userId: "up1" });
    const row = await services.images.get(img.id);
    assert.equal(row?.workspaceId, ws.id);
    assert.equal(row?.uploadedBy, "up1");

    // Membership lost since the mint: a clean 403, not a failed insert.
    await db.delete(workspaceMembers).where(eq(workspaceMembers.userId, "up1"));
    assert.equal((await post(token)).statusCode, 403);
    await db.insert(workspaceMembers).values({ workspaceId: ws.id, userId: "up1", role: "owner" });

    // The per-user MCP kill switch severs direct uploads too.
    await db.insert(userSettings).values({ userId: "up1", mcpEnabled: false });
    assert.equal((await post(token)).statusCode, 403);
  } finally {
    await app.close();
    await db.$dispose();
    if (savedUploads === undefined) delete process.env.UPLOADS_DIR;
    else process.env.UPLOADS_DIR = savedUploads;
    await rm(uploadsTmp, { recursive: true, force: true });
  }
});
