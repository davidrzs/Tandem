import assert from "node:assert/strict";
import { test } from "node:test";
import { createDatabase, migrateDatabase, user, userSettings } from "@tandem/db";
import { buildHttpServer, mcpAccessError } from "./http.js";

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
