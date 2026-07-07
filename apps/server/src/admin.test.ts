import assert from "node:assert/strict";
import { test } from "node:test";
import { createDatabase, migrateDatabase } from "@tandem/db";
import { createServices } from "./services.js";
import { appRouter, type AuthUser } from "./trpc.js";

// Phase C: the admin tRPC surface and its role gate. Exercised through a
// direct caller with a hand-built context (no HTTP needed) — the guard only
// reads ctx.user.role, and the procedures only touch the instance service.

async function fresh() {
  const db = createDatabase("memory://");
  await migrateDatabase(db);
  return db;
}

function callerFor(db: Awaited<ReturnType<typeof fresh>>, user: AuthUser | null) {
  const actor = { kind: "user" as const, userId: user?.id ?? "" };
  return appRouter.createCaller({
    services: createServices(db, actor, user ? { userId: user.id, name: user.name, ai: false } : undefined),
    user,
  });
}

const admin: AuthUser = { id: "a1", email: "a@x.com", name: "Admin", role: "admin" };
const member: AuthUser = { id: "u1", email: "u@x.com", name: "User", role: "user" };

test("admin procedures reject anonymous and non-admin callers", async () => {
  const db = await fresh();
  try {
    await assert.rejects(() => callerFor(db, null).admin.getSettings(), /UNAUTHORIZED/);
    await assert.rejects(() => callerFor(db, member).admin.getSettings(), /admin/i);
    await assert.rejects(
      () => callerFor(db, member).admin.updateSettings({ registrationMode: "closed" }),
      /admin/i,
    );
  } finally {
    await db.$dispose();
  }
});

test("an admin can read/update settings and manage server invites", async () => {
  const db = await fresh();
  try {
    const caller = callerFor(db, admin);

    const initial = await caller.admin.getSettings();
    assert.equal(initial.registrationMode, "open");

    const updated = await caller.admin.updateSettings({
      registrationMode: "domain",
      allowedEmailDomains: ["acme.com"],
      instanceName: "Acme",
    });
    assert.equal(updated.registrationMode, "domain");
    assert.deepEqual(updated.allowedEmailDomains, ["acme.com"]);
    assert.equal((await caller.admin.getSettings()).instanceName, "Acme");

    const invite = await caller.admin.createInvite({ role: "admin", expiresInDays: 7 });
    assert.equal(invite.role, "admin");
    assert.ok(invite.token.length > 0);
    assert.equal(invite.createdBy, admin.id, "invite pinned to the creating admin");

    const list = await caller.admin.listInvites();
    assert.ok(list.some((i) => i.id === invite.id));

    await caller.admin.revokeInvite({ id: invite.id });
    assert.equal((await caller.admin.listInvites()).length, 0);
  } finally {
    await db.$dispose();
  }
});
