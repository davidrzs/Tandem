import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  collectionPermissions,
  createDatabase,
  groupMembers,
  groups,
  migrateDatabase,
  runAsActor,
  SYSTEM,
  workspaceInvites,
  workspaceMembers,
  workspaces,
  type Actor,
} from "@tandem/db";
import { eq } from "drizzle-orm";
import { CollectionService } from "./services/collections.js";
import { GroupService } from "./services/groups.js";
import { WorkspaceService } from "./services/workspaces.js";

/**
 * RLS backstop for the sharing tables (groups, group_members,
 * collection_permissions, workspace_invites). These assert the DATABASE refuses
 * an unauthorized write even when the service-layer owner/admin check is
 * bypassed entirely — every case here issues a RAW actor-scoped query, not a
 * service call. If someone later adds a service method that forgets its check,
 * these guarantees still hold. The regex tolerates either failure mode: a
 * WITH CHECK violation ("row-level security") or a missing grant.
 */
const db = createDatabase("memory://");
const actor = (userId: string): Actor => ({ kind: "user", userId });
const DENIED = /row-level security|permission denied/i;

let wsO = ""; // owner's workspace
let colO = ""; // a collection in wsO
let groupO = ""; // a group in wsO

before(async () => {
  await migrateDatabase(db);
  // owner owns wsO; outsider owns a separate workspace and is a stranger to wsO.
  wsO = (await new WorkspaceService(db, SYSTEM).provisionForUser("owner", { name: "O", slug: "o" })).id;
  await new WorkspaceService(db, SYSTEM).provisionForUser("outsider", { name: "X", slug: "x" });
  // "member" is a plain (non-admin) member of wsO.
  await runAsActor(db, SYSTEM, (tx) =>
    tx.insert(workspaceMembers).values({ workspaceId: wsO, userId: "member", role: "member" }),
  );
  // Legit admin setup: owner creates a collection and a group in wsO.
  colO = (await new CollectionService(db, actor("owner")).create({ name: "C", slug: "c", workspaceId: wsO })).id;
  groupO = (await new GroupService(db, actor("owner")).create(wsO, "G")).id;
});

after(() => db.$dispose());

test("groups: a non-admin member cannot create a group (DB refuses the raw insert)", async () => {
  await assert.rejects(
    () => runAsActor(db, actor("member"), (tx) => tx.insert(groups).values({ workspaceId: wsO, name: "sneaky" })),
    DENIED,
  );
});

test("groups: an outsider cannot create a group in a workspace they don't belong to", async () => {
  await assert.rejects(
    () => runAsActor(db, actor("outsider"), (tx) => tx.insert(groups).values({ workspaceId: wsO, name: "intrusion" })),
    DENIED,
  );
  // ...but an owner/admin may — the policy admits legitimate writes.
  const [g] = await runAsActor(db, actor("owner"), (tx) =>
    tx.insert(groups).values({ workspaceId: wsO, name: "legit" }).returning(),
  );
  assert.ok(g?.id, "owner can create a group");
});

test("groups: members may read their workspace's groups (not over-restricted)", async () => {
  const rows = await runAsActor(db, actor("member"), (tx) =>
    tx.select().from(groups).where(eq(groups.workspaceId, wsO)),
  );
  assert.ok(rows.some((r) => r.id === groupO), "a member sees the workspace's groups");
  // An outsider sees none of them.
  const none = await runAsActor(db, actor("outsider"), (tx) =>
    tx.select().from(groups).where(eq(groups.workspaceId, wsO)),
  );
  assert.equal(none.length, 0, "an outsider sees no groups");
});

test("group_members: a non-admin cannot add anyone to a group", async () => {
  await assert.rejects(
    () => runAsActor(db, actor("member"), (tx) => tx.insert(groupMembers).values({ groupId: groupO, userId: "member" })),
    DENIED,
  );
});

test("collection_permissions: a member cannot self-grant access to a collection", async () => {
  // The self-escalation case: bypass the service and try to hand yourself
  // read_write on a collection you only (at most) read.
  await assert.rejects(
    () =>
      runAsActor(db, actor("member"), (tx) =>
        tx.insert(collectionPermissions).values({
          collectionId: colO,
          principalType: "user",
          principalId: "member",
          role: "read_write",
        }),
      ),
    DENIED,
  );
  // An outsider cannot even see a collection's grants.
  await new CollectionService(db, actor("owner")).grant(colO, "user", "member", "read");
  const seen = await runAsActor(db, actor("outsider"), (tx) =>
    tx.select().from(collectionPermissions).where(eq(collectionPermissions.collectionId, colO)),
  );
  assert.equal(seen.length, 0, "an outsider sees no sharing grants");
});

test("workspace_invites: a non-admin cannot forge an invite", async () => {
  await assert.rejects(
    () =>
      runAsActor(db, actor("member"), (tx) =>
        tx.insert(workspaceInvites).values({
          workspaceId: wsO,
          token: "forged-token",
          role: "admin",
          createdBy: "member",
        }),
      ),
    DENIED,
  );
});

test("invite redemption: a valid token joins as yourself; reuse and bogus tokens are refused", async () => {
  const invite = await new WorkspaceService(db, actor("owner")).createInvite({ workspaceId: wsO, role: "member" });

  // A fresh user (not yet a member) redeems the invite as themselves.
  const joined = await new WorkspaceService(db, actor("newbie")).acceptInvite(invite.token);
  assert.equal(joined.id, wsO);
  const mine = await runAsActor(db, actor("newbie"), (tx) =>
    tx.select().from(workspaces).where(eq(workspaces.id, wsO)),
  );
  assert.equal(mine.length, 1, "newbie now sees the workspace");

  // Single-use: a second redemption of the same token fails.
  await assert.rejects(
    () => new WorkspaceService(db, actor("someone")).acceptInvite(invite.token),
    /invalid or already-used/,
  );
  // A bogus token fails.
  await assert.rejects(
    () => new WorkspaceService(db, actor("someone")).acceptInvite("not-a-real-token"),
    /invalid or already-used/,
  );
});
