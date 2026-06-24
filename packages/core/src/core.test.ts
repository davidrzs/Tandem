import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createDatabase, migrateDatabase, SYSTEM, type Actor } from "@realtime/db";
import { CollectionService } from "./services/collections.js";
import { DocumentService } from "./services/documents.js";
import { GroupService } from "./services/groups.js";
import { WorkspaceService } from "./services/workspaces.js";
import { normalizeMarkdown } from "./markdown.js";

const db = createDatabase("memory://");
const user = (userId: string): Actor => ({ kind: "user", userId });

before(async () => {
  await migrateDatabase(db);
  // Provision a workspace per user (what the signup hook does).
  await new WorkspaceService(db, SYSTEM).provisionForUser("u1", { name: "U1", slug: "u1" });
  await new WorkspaceService(db, SYSTEM).provisionForUser("u2", { name: "U2", slug: "u2" });
});

after(async () => {
  await db.$dispose();
});

test("markdown round-trips through the document model", () => {
  const normalized = normalizeMarkdown("# Title\n\nSome **bold** and a list:\n\n* one\n* two");
  assert.match(normalized, /# Title/);
  assert.match(normalized, /\*\*bold\*\*/);
  assert.match(normalized, /\* one/);
});

test("workspace-scoped CRUD, tree, and search (user actor under RLS)", async () => {
  const collections = new CollectionService(db, user("u1"));
  const documents = new DocumentService(db, user("u1"));

  const col = await collections.create({ name: "Handbook", slug: "handbook" });
  assert.ok(col.workspaceId, "collection got a workspace");

  const parent = await documents.create({
    collectionId: col.id,
    title: "Onboarding",
    markdown: "# Onboarding\n\nWelcome to the team.",
  });
  const child = await documents.create({
    collectionId: col.id,
    parentDocumentId: parent.id,
    title: "Laptop setup",
    markdown: "Install **pnpm** and clone the monorepo.",
  });
  assert.equal(parent.workspaceId, col.workspaceId, "doc inherits workspace");

  const tree = await documents.tree(col.id);
  assert.equal(tree[0]!.children[0]!.id, child.id);

  const hits = await documents.search("pnpm monorepo", { collectionId: col.id });
  assert.ok(hits.some((h) => h.id === child.id));
});

test("tenant isolation: a user cannot see or write another workspace's data", async () => {
  // u1 creates content.
  const c1 = new CollectionService(db, user("u1"));
  const d1 = new DocumentService(db, user("u1"));
  const col = await c1.create({ name: "Secret", slug: "secret" });
  const doc = await d1.create({ collectionId: col.id, title: "Private", markdown: "top secret" });

  // u2 sees none of it.
  const c2 = new CollectionService(db, user("u2"));
  const d2 = new DocumentService(db, user("u2"));
  assert.ok(
    !(await c2.list()).some((c) => c.id === col.id),
    "u2 collection list excludes u1's collection",
  );
  assert.equal(await d2.get(doc.id), null, "u2 cannot fetch u1's document");
  assert.equal((await d2.search("secret")).length, 0, "u2 search finds nothing of u1's");

  // u2 cannot create a document inside u1's collection (collection invisible).
  await assert.rejects(
    () => d2.create({ collectionId: col.id, title: "intrusion", markdown: "x" }),
    /collection not found/,
  );

  // u1 still sees their own.
  assert.ok((await c1.list()).some((c) => c.id === col.id));
  assert.ok(await d1.get(doc.id));
});

test("invite: a user who accepts an invite gains access to that workspace", async () => {
  const w1 = new WorkspaceService(db, user("u1"));
  const w2 = new WorkspaceService(db, user("u2"));
  const c1 = new CollectionService(db, user("u1"));

  const [ws] = await w1.listMine();
  const col = await c1.create({ name: "Shared", slug: "shared-team" });

  // Before accepting, u2 can't see it.
  assert.ok(!(await new CollectionService(db, user("u2")).list()).some((c) => c.id === col.id));

  // u1 (owner) invites; u2 accepts.
  const invite = await w1.createInvite({ workspaceId: ws!.id });
  await w2.acceptInvite(invite.token, "u2");

  // Now u2 is a member and sees the workspace's collection.
  assert.ok((await w2.listMine()).some((w) => w.id === ws!.id), "u2 joined the workspace");
  assert.ok(
    (await new CollectionService(db, user("u2")).list()).some((c) => c.id === col.id),
    "u2 now sees the shared collection",
  );

  // A non-owner cannot create invites.
  await assert.rejects(
    () => w2.createInvite({ workspaceId: ws!.id }),
    /owner or admin/,
  );
});

test("move rejects a cross-collection or self parent", async () => {
  const c1 = new CollectionService(db, user("u1"));
  const d1 = new DocumentService(db, user("u1"));
  const colA = await c1.create({ name: "A", slug: "move-a" });
  const colB = await c1.create({ name: "B", slug: "move-b" });
  const a1 = await d1.create({ collectionId: colA.id, title: "a1" });
  const a2 = await d1.create({ collectionId: colA.id, title: "a2" });
  const b1 = await d1.create({ collectionId: colB.id, title: "b1" });

  await assert.rejects(
    () => d1.move(a1.id, { parentDocumentId: b1.id }),
    /same collection/,
    "cross-collection parent rejected",
  );
  await assert.rejects(
    () => d1.move(a1.id, { parentDocumentId: a1.id }),
    /own parent/,
    "self-parent rejected",
  );
  // Same-collection move is allowed.
  const moved = await d1.move(a1.id, { parentDocumentId: a2.id });
  assert.equal(moved!.parentDocumentId, a2.id);
});

test("invite role can't exceed the inviter's: an admin cannot grant owner", async () => {
  const w1 = new WorkspaceService(db, user("u1")); // u1 is owner of its workspace
  const [ws] = await w1.listMine();

  // u1 (owner) invites u3 as admin; u3 accepts.
  const adminInvite = await w1.createInvite({ workspaceId: ws!.id, role: "admin" });
  await new WorkspaceService(db, user("u3")).acceptInvite(adminInvite.token, "u3");
  const w3 = new WorkspaceService(db, user("u3"));

  // The admin can invite members/admins...
  assert.ok(await w3.createInvite({ workspaceId: ws!.id, role: "member" }));
  // ...but not owners.
  await assert.rejects(
    () => w3.createInvite({ workspaceId: ws!.id, role: "owner" }),
    /only an owner can grant the owner role/,
  );
});

test("per-collection ACLs: default none, explicit read, read_write, and groups", async () => {
  // u2 is a regular member of u1's workspace (joined via the invite test above).
  const c1 = new CollectionService(db, user("u1"));
  const c2 = new CollectionService(db, user("u2"));
  const d2 = new DocumentService(db, user("u2"));

  const col = await c1.create({ name: "Restricted", slug: "restricted" });
  await c1.setDefaultRole(col.id, "none");

  // No access: u2 (member, not owner/admin) can't see a default-none collection.
  assert.ok(!(await c2.list()).some((c) => c.id === col.id), "hidden at default none");
  await assert.rejects(() => d2.create({ collectionId: col.id, title: "x" }), /not found/);

  // Explicit read: visible but not writable.
  await c1.grant(col.id, "user", "u2", "read");
  const seen = (await c2.list()).find((c) => c.id === col.id);
  assert.ok(seen, "u2 can see it with read grant");
  assert.equal(seen!.writable, false, "read grant is not writable");
  await assert.rejects(() => d2.create({ collectionId: col.id, title: "x" }), "read-only blocks create");

  // Upgrade to read_write: now writable.
  await c1.grant(col.id, "user", "u2", "read_write");
  assert.equal((await c2.list()).find((c) => c.id === col.id)!.writable, true);
  assert.ok(await d2.create({ collectionId: col.id, title: "ok" }), "read_write allows create");

  // Group grant: a separate collection shared with a group u2 belongs to.
  const [ws] = await new WorkspaceService(db, user("u1")).listMine();
  const grouped = await c1.create({ name: "Grouped", slug: "grouped" });
  await c1.setDefaultRole(grouped.id, "none");
  const groups = new GroupService(db, user("u1"));
  const g = await groups.create(ws!.id, "Editors");
  await groups.addMember(g.id, "u2");
  await c1.grant(grouped.id, "group", g.id, "read_write");
  assert.equal((await c2.list()).find((c) => c.id === grouped.id)?.writable, true, "group grant propagates");
});
