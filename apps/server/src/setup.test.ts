import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import {
  auditLog,
  createDatabase,
  migrateDatabase,
  user,
  workspaceMembers,
  workspaces,
} from "@tandem/db";
import { InstanceService } from "@tandem/core";
import { buildHttpServer } from "./http.js";

// Phase B: the unauthenticated setup/onboarding surface. Drives the real
// Fastify app (with an injected in-memory PGlite) via app.inject, so it also
// proves the routes are registered and the SPA fallback doesn't shadow them.

process.env.BETTER_AUTH_SECRET ??= "test-secret-value-at-least-16-chars-long";

async function freshApp() {
  const db = createDatabase("memory://");
  await migrateDatabase(db);
  const app = await buildHttpServer(db);
  await app.ready();
  return { db, app };
}

test("setup status flips true -> false after the first admin is created", async () => {
  const { db, app } = await freshApp();
  try {
    const before = await app.inject({ method: "GET", url: "/api/setup/status" });
    assert.equal(before.json().needsSetup, true);

    const init = await app.inject({
      method: "POST",
      url: "/api/setup/init",
      payload: {
        name: "Admin",
        email: "admin@acme.com",
        password: "password123",
        registrationMode: "closed",
        instanceName: "Acme Wiki",
      },
    });
    assert.equal(init.statusCode, 200, init.body);
    assert.equal(init.json().ok, true);

    const after = await app.inject({ method: "GET", url: "/api/setup/status" });
    assert.equal(after.json().needsSetup, false);

    // The created account is the server admin.
    const [u] = await db.select({ role: user.role }).from(user).where(eq(user.email, "admin@acme.com"));
    assert.equal(u?.role, "admin");

    // The chosen policy + branding persisted.
    const pub = await app.inject({ method: "GET", url: "/api/instance/public" });
    assert.deepEqual(pub.json(), {
      instanceName: "Acme Wiki",
      registrationMode: "closed",
      allowedEmailDomains: [],
    });
  } finally {
    await app.close();
    await db.$dispose();
  }
});

test("setup init is single-use: a second call is refused", async () => {
  const { db, app } = await freshApp();
  try {
    const first = await app.inject({
      method: "POST",
      url: "/api/setup/init",
      payload: { name: "Admin", email: "admin@acme.com", password: "password123", registrationMode: "open" },
    });
    assert.equal(first.statusCode, 200);

    const second = await app.inject({
      method: "POST",
      url: "/api/setup/init",
      payload: { name: "Intruder", email: "intruder@acme.com", password: "password123", registrationMode: "open" },
    });
    assert.equal(second.statusCode, 403);
    const [u] = await db.select({ id: user.id }).from(user).where(eq(user.email, "intruder@acme.com"));
    assert.equal(u, undefined, "no second account created");
  } finally {
    await app.close();
    await db.$dispose();
  }
});

test("setup init rejects a too-short password without creating anything", async () => {
  const { db, app } = await freshApp();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/init",
      payload: { name: "Admin", email: "admin@acme.com", password: "short", registrationMode: "open" },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(await new InstanceService(db).needsSetup(), true, "still needs setup");
  } finally {
    await app.close();
    await db.$dispose();
  }
});

test("InstanceService: settings upsert, public projection, invite lifecycle", async () => {
  const db = createDatabase("memory://");
  await migrateDatabase(db);
  const svc = new InstanceService(db);

  assert.deepEqual(await svc.getPublicSettings(), {
    instanceName: "Tandem",
    registrationMode: "open",
    allowedEmailDomains: [],
  });

  await svc.updateSettings({ registrationMode: "domain", allowedEmailDomains: ["@Acme.com", " acme.com ", ""] });
  const s = await svc.getSettings();
  assert.equal(s.registrationMode, "domain");
  assert.deepEqual(s.allowedEmailDomains, ["acme.com"], "domains normalized + deduped");

  const inv = await svc.createInvite({ createdBy: "admin", email: "x@acme.com", role: "admin" });
  assert.equal(inv.role, "admin");
  assert.ok(inv.token.length > 0);
  assert.ok((await svc.listInvites()).some((i) => i.id === inv.id));
  await svc.revokeInvite(inv.id);
  assert.equal((await svc.listInvites()).length, 0);

  await db.$dispose();
});

test("onUserDeleted clears the user's memberships (no FK cascade otherwise)", async () => {
  const db = createDatabase("memory://");
  await migrateDatabase(db);
  const [ws] = await db.insert(workspaces).values({ name: "W", slug: "w" }).returning();
  await db.insert(workspaceMembers).values({ workspaceId: ws!.id, userId: "gone", role: "owner" });

  await new InstanceService(db).onUserDeleted("gone");
  const rows = await db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, "gone"));
  assert.equal(rows.length, 0, "membership removed");
  await db.$dispose();
});

test("deleting a user cleans memberships and drops their personal workspace", async () => {
  const { db, app } = await freshApp();
  const cookieOf = (r: { headers: Record<string, unknown> }) => {
    const sc = r.headers["set-cookie"];
    const arr = Array.isArray(sc) ? sc : [sc];
    return arr.map((c: string) => c.split(";")[0]).join("; ");
  };
  try {
    await app.inject({
      method: "POST",
      url: "/api/setup/init",
      payload: { name: "Admin", email: "admin@x.com", password: "password123", registrationMode: "open" },
    });
    const signin = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email: "admin@x.com", password: "password123" },
    });
    const admin = cookieOf(signin);
    await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { name: "Bob", email: "bob@x.com", password: "password123" },
    });
    const list = await app.inject({
      method: "GET",
      url: "/api/auth/admin/list-users?limit=50",
      headers: { cookie: admin },
    });
    const bob = (list.json().users as Array<{ id: string; email: string }>).find(
      (u) => u.email === "bob@x.com",
    )!;
    const [bobMembership] = await db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, bob.id));
    assert.ok(bobMembership, "bob has his personal-workspace membership");

    // Origin header required: better-auth guards state-changing admin calls.
    const del = await app.inject({
      method: "POST",
      url: "/api/auth/admin/remove-user",
      headers: { cookie: admin, "content-type": "application/json", origin: "http://localhost:5173" },
      payload: { userId: bob.id },
    });
    assert.equal(del.statusCode, 200, del.body);
    assert.equal(
      (await db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, bob.id))).length,
      0,
      "membership cleaned by the user.delete hook",
    );
    // The sole-member personal workspace goes with the account.
    const [orphanWs] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, bobMembership.workspaceId));
    assert.equal(orphanWs, undefined, "personal workspace deleted");

    // The deletion left an instance-level audit entry naming actor and target.
    const [entry] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "admin_remove_user"));
    assert.ok(entry, "admin_remove_user audited");
    assert.equal(entry!.workspaceId, null, "instance-level entry");
    assert.match(entry!.detail, /bob/i, "target recorded");
  } finally {
    await app.close();
    await db.$dispose();
  }
});

test("closed mode: the admin can still create accounts directly", async () => {
  const { db, app } = await freshApp();
  const cookieOf = (r: { headers: Record<string, unknown> }) => {
    const sc = r.headers["set-cookie"];
    const arr = Array.isArray(sc) ? sc : [sc];
    return arr.map((c: string) => c.split(";")[0]).join("; ");
  };
  try {
    await app.inject({
      method: "POST",
      url: "/api/setup/init",
      payload: { name: "Admin", email: "admin@x.com", password: "password123", registrationMode: "closed" },
    });
    const signin = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email: "admin@x.com", password: "password123" },
    });
    const admin = cookieOf(signin);

    // Self-signup is refused…
    const cold = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { name: "Cold", email: "cold@x.com", password: "password123" },
    });
    assert.equal(cold.statusCode, 403);

    // …but the admin's create-user endpoint bypasses the registration policy.
    const created = await app.inject({
      method: "POST",
      url: "/api/auth/admin/create-user",
      headers: { cookie: admin, "content-type": "application/json", origin: "http://localhost:5173" },
      payload: { name: "Made", email: "made@x.com", password: "password123", role: "user" },
    });
    assert.equal(created.statusCode, 200, created.body);
    const [made] = await db.select().from(user).where(eq(user.email, "made@x.com"));
    assert.ok(made, "account exists");
    assert.notEqual(made!.role, "admin", "created as a regular user");

    // The new account gets the same personal workspace as a signup would.
    const [membership] = await db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, made!.id));
    assert.ok(membership, "personal workspace provisioned");
  } finally {
    await app.close();
    await db.$dispose();
  }
});

test("role changes, bans, and account creation leave audit entries", async () => {
  const { db, app } = await freshApp();
  const cookieOf = (r: { headers: Record<string, unknown> }) => {
    const sc = r.headers["set-cookie"];
    const arr = Array.isArray(sc) ? sc : [sc];
    return arr.map((c: string) => c.split(";")[0]).join("; ");
  };
  const H = (cookie: string) => ({
    cookie,
    "content-type": "application/json",
    origin: "http://localhost:5173",
  });
  try {
    await app.inject({
      method: "POST",
      url: "/api/setup/init",
      payload: { name: "Admin", email: "admin@x.com", password: "password123", registrationMode: "open" },
    });
    const signin = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email: "admin@x.com", password: "password123" },
    });
    const admin = cookieOf(signin);

    const created = await app.inject({
      method: "POST",
      url: "/api/auth/admin/create-user",
      headers: H(admin),
      payload: { name: "Bob", email: "bob@x.com", password: "password123", role: "user" },
    });
    assert.equal(created.statusCode, 200, created.body);
    const bobId = (created.json() as { user: { id: string } }).user.id;

    for (const [url, payload] of [
      ["/api/auth/admin/set-role", { userId: bobId, role: "admin" }],
      ["/api/auth/admin/ban-user", { userId: bobId }],
      ["/api/auth/admin/unban-user", { userId: bobId }],
    ] as const) {
      const res = await app.inject({ method: "POST", url, headers: H(admin), payload });
      assert.equal(res.statusCode, 200, `${url}: ${res.body}`);
    }

    const entries = await db.select().from(auditLog);
    const [adminUser] = await db.select({ id: user.id }).from(user).where(eq(user.email, "admin@x.com"));
    for (const action of ["admin_create_user", "admin_set_role", "admin_ban_user", "admin_unban_user"]) {
      const entry = entries.find((e) => e.action === action);
      assert.ok(entry, `audited: ${action}`);
      assert.equal(entry!.workspaceId, null, `${action} is instance-level`);
      assert.equal(entry!.userId, adminUser!.id, `${action} attributed to the acting admin`);
      assert.match(entry!.detail, /bob@x\.com|bob/i, `${action} names the target`);
    }
    const roleEntry = entries.find((e) => e.action === "admin_set_role");
    assert.match(roleEntry!.detail, /role=admin/, "set-role records the granted role");
  } finally {
    await app.close();
    await db.$dispose();
  }
});

test("deleting the sole owner of a shared workspace is refused", async () => {
  const { db, app } = await freshApp();
  const cookieOf = (r: { headers: Record<string, unknown> }) => {
    const sc = r.headers["set-cookie"];
    const arr = Array.isArray(sc) ? sc : [sc];
    return arr.map((c: string) => c.split(";")[0]).join("; ");
  };
  try {
    await app.inject({
      method: "POST",
      url: "/api/setup/init",
      payload: { name: "Admin", email: "admin@x.com", password: "password123", registrationMode: "open" },
    });
    const signin = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email: "admin@x.com", password: "password123" },
    });
    const admin = cookieOf(signin);
    await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { name: "Bob", email: "bob@x.com", password: "password123" },
    });
    const list = await app.inject({
      method: "GET",
      url: "/api/auth/admin/list-users?limit=50",
      headers: { cookie: admin },
    });
    const users = list.json().users as Array<{ id: string; email: string }>;
    const bob = users.find((u) => u.email === "bob@x.com")!;
    const adminUser = users.find((u) => u.email === "admin@x.com")!;

    // Bob's personal workspace gains a second (non-owner) member.
    const [bobMembership] = await db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, bob.id));
    await db.insert(workspaceMembers).values({
      workspaceId: bobMembership!.workspaceId,
      userId: adminUser.id,
      role: "member",
    });

    const del = await app.inject({
      method: "POST",
      url: "/api/auth/admin/remove-user",
      headers: { cookie: admin, "content-type": "application/json", origin: "http://localhost:5173" },
      payload: { userId: bob.id },
    });
    assert.ok(del.statusCode >= 400 && del.statusCode < 500, `refused (got ${del.statusCode})`);
    assert.match(del.body, /only owner|transfer ownership/i);
    const [stillThere] = await db.select().from(user).where(eq(user.id, bob.id));
    assert.ok(stillThere, "bob was not deleted");
  } finally {
    await app.close();
    await db.$dispose();
  }
});
