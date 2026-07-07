import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import {
  createDatabase,
  migrateDatabase,
  instanceInvites,
  instanceSettings,
  user,
  workspaceInvites,
  workspaces,
} from "@tandem/db";
import { createAuth } from "./auth.js";
import { INVITE_TOKEN_HEADER } from "./registration.js";

// The registration gate (databaseHooks.user.create.before in auth.ts) enforces
// the instance policy. Each test gets its own in-memory PGlite so the
// "first user" bootstrap is deterministic. We drive it through the real
// better-auth signup endpoint, so this also proves the admin() plugin composes
// and that the invite token survives the request → hook boundary via a header.

async function fresh() {
  const db = createDatabase("memory://");
  await migrateDatabase(db);
  return { db, auth: createAuth(db) };
}

type Auth = Awaited<ReturnType<typeof fresh>>["auth"];

function signup(auth: Auth, email: string, token?: string) {
  return auth.api.signUpEmail({
    body: { name: email.split("@")[0]!, email, password: "password123" },
    ...(token ? { headers: new Headers({ [INVITE_TOKEN_HEADER]: token }) } : {}),
  });
}

async function roleOf(db: Awaited<ReturnType<typeof fresh>>["db"], email: string) {
  const [row] = await db.select({ role: user.role }).from(user).where(eq(user.email, email));
  return row?.role ?? null;
}

async function setMode(
  db: Awaited<ReturnType<typeof fresh>>["db"],
  registrationMode: string,
  allowedEmailDomains: string[] = [],
) {
  await db
    .insert(instanceSettings)
    .values({ registrationMode, allowedEmailDomains })
    .onConflictDoUpdate({
      target: instanceSettings.id,
      set: { registrationMode, allowedEmailDomains },
    });
}

/** Sign up the founder (always allowed, becomes admin) so later signups are
 * gated by policy rather than the bootstrap path. */
async function seedAdmin(auth: Auth, db: Awaited<ReturnType<typeof fresh>>["db"]) {
  await signup(auth, "founder@acme.com");
  assert.equal(await roleOf(db, "founder@acme.com"), "admin", "first user is admin");
}

test("the very first user is always allowed and becomes the server admin", async () => {
  const { db, auth } = await fresh();
  await setMode(db, "closed"); // even in the most locked mode
  await signup(auth, "founder@acme.com");
  assert.equal(await roleOf(db, "founder@acme.com"), "admin");
  await db.$dispose();
});

test("open mode: a second user may register and gets the default (non-admin) role", async () => {
  const { db, auth } = await fresh();
  await seedAdmin(auth, db);
  await setMode(db, "open");
  await signup(auth, "second@wherever.com");
  assert.notEqual(await roleOf(db, "second@wherever.com"), "admin", "not promoted");
  await db.$dispose();
});

test("closed mode: a second signup is rejected", async () => {
  const { db, auth } = await fresh();
  await seedAdmin(auth, db);
  await setMode(db, "closed");
  await assert.rejects(() => signup(auth, "nope@acme.com"), /closed/i);
  const [row] = await db.select().from(user).where(eq(user.email, "nope@acme.com"));
  assert.equal(row, undefined, "no account was created");
  await db.$dispose();
});

test("invite mode: rejected without a token, allowed with a valid instance invite", async () => {
  const { db, auth } = await fresh();
  await seedAdmin(auth, db);
  await setMode(db, "invite");

  await assert.rejects(() => signup(auth, "cold@acme.com"), /invite is required/i);

  await db.insert(instanceInvites).values({ token: "inv-tok", createdBy: "founder" });
  await signup(auth, "warm@acme.com", "inv-tok");
  assert.notEqual(await roleOf(db, "warm@acme.com"), null, "invited user created");
  await db.$dispose();
});

test("invite mode: a valid workspace invite token also lets a new user sign up", async () => {
  const { db, auth } = await fresh();
  await seedAdmin(auth, db);
  await setMode(db, "invite");

  const [ws] = await db
    .insert(workspaces)
    .values({ name: "W", slug: "w-invite" })
    .returning();
  await db
    .insert(workspaceInvites)
    .values({ workspaceId: ws!.id, token: "ws-tok", role: "member", createdBy: "founder" });

  await signup(auth, "joiner@acme.com", "ws-tok");
  assert.notEqual(await roleOf(db, "joiner@acme.com"), null, "workspace-invited user created");
  await db.$dispose();
});

test("instance invites are single-use: the second signup with the same token is rejected", async () => {
  const { db, auth } = await fresh();
  await seedAdmin(auth, db);
  await setMode(db, "invite");
  await db.insert(instanceInvites).values({ token: "once-tok", createdBy: "founder" });

  await signup(auth, "first@acme.com", "once-tok");
  const [row] = await db
    .select({ acceptedAt: instanceInvites.acceptedAt, acceptedBy: instanceInvites.acceptedBy })
    .from(instanceInvites)
    .where(eq(instanceInvites.token, "once-tok"));
  assert.ok(row?.acceptedAt, "invite consumed on signup");
  assert.ok(row?.acceptedBy, "consumer recorded");

  await assert.rejects(() => signup(auth, "second@acme.com", "once-tok"), /invite is required/i);
  await db.$dispose();
});

test("an admin-role instance invite grants the server-admin role at signup", async () => {
  const { db, auth } = await fresh();
  await seedAdmin(auth, db);
  await setMode(db, "closed");
  await db
    .insert(instanceInvites)
    .values({ token: "admin-tok", role: "admin", createdBy: "founder" });

  await signup(auth, "second-admin@acme.com", "admin-tok");
  assert.equal(await roleOf(db, "second-admin@acme.com"), "admin");
  await db.$dispose();
});

test("invite mode: an email-bound invite rejects a mismatched address", async () => {
  const { db, auth } = await fresh();
  await seedAdmin(auth, db);
  await setMode(db, "invite");
  await db
    .insert(instanceInvites)
    .values({ token: "bound-tok", email: "invited@acme.com", createdBy: "founder" });

  await assert.rejects(() => signup(auth, "someone-else@acme.com", "bound-tok"), /invite is required/i);
  await signup(auth, "invited@acme.com", "bound-tok");
  assert.notEqual(await roleOf(db, "invited@acme.com"), null, "bound address accepted");
  await db.$dispose();
});

test("domain mode: in-list domains register, others are rejected", async () => {
  const { db, auth } = await fresh();
  await seedAdmin(auth, db);
  await setMode(db, "domain", ["acme.com"]);

  await signup(auth, "alice@acme.com");
  assert.notEqual(await roleOf(db, "alice@acme.com"), null, "allowed domain registers");

  await assert.rejects(() => signup(auth, "bob@evil.com"), /domain/i);
  await db.$dispose();
});
