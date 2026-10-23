import assert from "node:assert/strict";
import { test } from "node:test";
import { createDatabase, migrateDatabase, SYSTEM, workspaceMembers } from "@tandem/db";
import { WorkspaceService } from "@tandem/core";
import { stateProperties } from "@tandem/editor";
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

    const neurips = venue.options.find((o) => o.label === "NeurIPS")!.id;
    const relabelled = await asOwner.types.updateField({ id: venue.id, options: [{ id: neurips, label: "NeurIPS 2026" }, { label: "ICLR" }] });
    const iclr = relabelled.options.find((o) => o.label === "ICLR")!.id;
    await asOwner.types.updateField({ id: venue.id, key: "conference" });

    const tpl = await asMember.documents.create({ collectionId: col.id, title: "Paper template" });
    await asMember.templates.templatize({ documentId: tpl.id, name: "Paper" });
    await asOwner.templates.setDefaultType({ templateId: tpl.id, typeId: type.id });
    await asOwner.templates.setFieldDefault({ templateId: tpl.id, fieldId: venue.id, default: { kind: "value", value: "ICLR" } });
    await asMember.templates.untemplatize({ documentId: tpl.id });

    await asOwner.types.retireField({ id: venue.id });
    const audit = await asOwner.settings.audit({ workspaceId: ws.id });
    assert.deepEqual(
      audit.map((e) => [e.action, e.detail]).reverse(),
      [
        ["define_type", 'type "Paper"'],
        ["define_field", 'field "venue" (select)'],
        ["update_field", 'field "venue": options; options "NeurIPS" -> "NeurIPS 2026", retired "ICML", added "ICLR"'],
        ["update_field", 'field "conference": key'],
        ["templatize", 'template "Paper"'],
        ["set_template_type", `template "Paper": type ${type.id}`],
        ["set_template_default", `template "Paper": ${venue.id} = {"kind":"value","value":"${iclr}"}`],
        ["untemplatize", 'template "Paper"'],
        ["retire_field", 'field "conference"'],
      ],
    );
  } finally {
    await db.$dispose();
  }
});

test("tRPC: attaching a type creates its list fields as empty arrays; detaching creates none", async () => {
  const db = createDatabase("memory://");
  await migrateDatabase(db);
  const services = createServices(db, { kind: "user", userId: owner.id }, { userId: owner.id, name: owner.name, ai: false });
  const caller = appRouter.createCaller({ services, user: owner });
  try {
    const ws = await new WorkspaceService(db, SYSTEM).provisionForUser(owner.id, { name: "W", slug: "w" });
    const type = await caller.types.create({ workspaceId: ws.id, name: "Meeting" });
    await caller.types.createField({ workspaceId: ws.id, typeId: type.id, key: "status", kind: "select", options: ["Open"] });
    const topics = await caller.types.createField({
      workspaceId: ws.id,
      typeId: type.id,
      key: "topics",
      kind: "multi_select",
      options: ["Budget"],
    });
    const notes = await caller.types.createField({ workspaceId: ws.id, typeId: type.id, key: "notes", kind: "doc_list" });
    await caller.types.createField({ workspaceId: ws.id, typeId: null, key: "tags", kind: "multi_select", options: ["x"] });

    const col = await caller.collections.create({ name: "Notes", slug: "notes" });
    const doc = await caller.documents.create({ collectionId: col.id, title: "Standup" });
    const stored = async () => {
      const state = (await services.documents.get(doc.id))?.ydocState;
      return state ? stateProperties(state) : {};
    };

    await caller.documents.setType({ id: doc.id, typeId: null });
    assert.deepEqual(await stored(), {});
    await caller.documents.setType({ id: doc.id, typeId: type.id });
    assert.deepEqual(await stored(), { [topics.id]: [], [notes.id]: [] });
  } finally {
    await db.$dispose();
  }
});
