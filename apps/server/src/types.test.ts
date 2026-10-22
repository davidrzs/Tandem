import assert from "node:assert/strict";
import { test } from "node:test";
import { createDatabase, migrateDatabase, SYSTEM, workspaceMembers } from "@tandem/db";
import { WorkspaceService } from "@tandem/core";
import { createServices } from "./services.js";
import { appRouter, type AuthUser } from "./trpc.js";

const owner: AuthUser = { id: "own", email: "own@x.com", name: "Owner" };
const member: AuthUser = { id: "mem", email: "mem@x.com", name: "Member" };

test("tRPC: owners define audited types and fields; members set types and values but not definitions", async () => {
  const db = createDatabase("memory://");
  await migrateDatabase(db);
  const callerFor = (user: AuthUser) =>
    appRouter.createCaller({
      services: createServices(db, { kind: "user", userId: user.id }, { userId: user.id, name: user.name, ai: false }),
      user,
    });
  try {
    const ws = await new WorkspaceService(db, SYSTEM).provisionForUser(owner.id, { name: "W", slug: "w" });
    await db.insert(workspaceMembers).values({ workspaceId: ws.id, userId: member.id, role: "member" });
    const asOwner = callerFor(owner);
    const asMember = callerFor(member);

    const type = await asOwner.types.create({ workspaceId: ws.id, name: "Paper" });
    const venue = await asOwner.types.createField({
      workspaceId: ws.id,
      typeId: type.id,
      key: "venue",
      kind: "select",
      options: ["NeurIPS", "ICML"],
    });
    await assert.rejects(() => asMember.types.create({ workspaceId: ws.id, name: "Talk" }), /FORBIDDEN|owner or admin/);
    await assert.rejects(
      () => asMember.types.updateField({ id: venue.id, key: "conference" }),
      /owner or admin/,
    );

    const col = await asOwner.collections.create({ name: "Research", slug: "research" });
    const doc = await asMember.documents.create({ collectionId: col.id, title: "Draft" });
    await asMember.documents.setType({ id: doc.id, typeId: type.id });
    const view = await asMember.documents.setProperties({ id: doc.id, set: { venue: "icml" } });
    assert.deepEqual(
      { type: view.type, values: view.values, fields: view.fields.map((f) => f.key) },
      { type: { id: type.id, name: "Paper" }, values: { [venue.id]: "ICML" }, fields: ["venue"] },
    );

    const detached = await asMember.documents.setType({ id: doc.id, typeId: null });
    assert.deepEqual({ type: detached.type, values: detached.values }, { type: null, values: { [venue.id]: "ICML" } });

    await asOwner.types.updateField({ id: venue.id, key: "conference" });
    await asOwner.types.retireField({ id: venue.id });
    const audit = await asOwner.settings.audit({ workspaceId: ws.id });
    assert.deepEqual(
      audit.map((e) => [e.action, e.detail]).reverse(),
      [
        ["define_type", 'type "Paper"'],
        ["define_field", 'field "venue" (select)'],
        ["update_field", 'field "conference": key'],
        ["retire_field", 'field "conference"'],
      ],
    );
  } finally {
    await db.$dispose();
  }
});
