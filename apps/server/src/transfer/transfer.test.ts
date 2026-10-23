import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { createDatabase, migrateDatabase, SYSTEM, type FieldKind } from "@tandem/db";
import { WorkspaceService, type DocumentNode } from "@tandem/core";
import { getAuthors, type PropertyOp } from "@tandem/editor";
import * as Y from "yjs";
import { createServices } from "../services.js";
import { buildExportZip } from "./export.js";
import { importZip, ImportError } from "./import.js";
import { SIDECAR_PATH } from "./properties-yaml.js";

const db = createDatabase("memory://");
const services = createServices(
  db,
  { kind: "user", userId: "u1" },
  { userId: "u1", name: "User One", ai: false },
);
let workspaceId = "";

before(async () => {
  process.env.UPLOADS_DIR = await mkdtemp(join(tmpdir(), "tandem-transfer-"));
  await migrateDatabase(db);
  const ws = await new WorkspaceService(db, SYSTEM).provisionForUser("u1", { name: "U1", slug: "u1" });
  workspaceId = ws.id;
});

after(async () => {
  await db.$dispose();
});

/** A nested-wiki-shaped zip: a collection, a tagged doc that links a child + an
 * image, the child doc, and the referenced attachment. */
function wikiZip(): Buffer {
  return Buffer.from(
    zipSync({
      "Handbook/Onboarding.md": strToU8(
        "---\ntags:\n  - intro\n---\n\n# Onboarding\n\nWelcome. See [Laptop](Onboarding/Laptop.md) and ![pic](pic.png).",
      ),
      "Handbook/pic.png": strToU8("not-really-a-png-but-bytes"),
      "Handbook/Onboarding/Laptop.md": strToU8("# Laptop setup\n\nInstall pnpm."),
      "__MACOSX/junk": strToU8("ignore me"),
    }),
  );
}

test("import: wiki zip → tree, tags, rewritten links, uploaded image, importer blame", async () => {
  const summary = await importZip(services, {
    workspaceId,
    uid: "u1",
    zipName: "backup.zip",
    buffer: wikiZip(),
  });
  assert.equal(summary.collections, 1);
  assert.equal(summary.documents, 2);
  assert.equal(summary.images, 1);

  const col = (await services.collections.list()).find((c) => c.name === "Handbook")!;
  assert.ok(col, "collection created from the top folder");
  const tree = await services.documentTree.tree(col.id);
  assert.equal(tree.length, 1);
  const onboarding = tree[0]!;
  assert.equal(onboarding.title, "Onboarding");
  assert.deepEqual(onboarding.tags, ["intro"], "front-matter tags applied");
  assert.equal(onboarding.children[0]!.title, "Laptop setup", "H1 became the child title");

  const doc = await services.documents.get(onboarding.id);
  assert.match(doc!.contentMd, new RegExp(`\\(/d/${onboarding.children[0]!.id}\\)`), "internal link rewritten");
  assert.match(doc!.contentMd, /\/api\/images\/[0-9a-f-]{36}/, "image link rewritten");

  // Blame: every attributed session is the importing human, never UNKNOWN/AI.
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, doc!.ydocState!);
  const authors = [...getAuthors(ydoc).values()];
  assert.ok(authors.length > 0, "content is attributed");
  for (const a of authors) {
    assert.equal(a.userId, "u1", "attributed to the importer");
    assert.equal(a.ai, false, "as a human, not AI");
  }
});

test("export: nested-wiki layout, front matter only when tagged, round-trips", async () => {
  const col = (await services.collections.list()).find((c) => c.name === "Handbook")!;
  const { buffer } = await buildExportZip(services, { collectionId: col.id }, "Handbook");
  const entries = unzipSync(buffer);
  const paths = Object.keys(entries);

  assert.ok(paths.includes("Handbook/Onboarding.md"), "root doc at collection/title.md");
  assert.ok(paths.includes("Handbook/Onboarding/Laptop setup.md"), "child nested in a same-named folder");
  assert.ok(paths.some((p) => /Handbook\/uploads\/.*\/image\./.test(p)), "attachment beside the doc");

  const onboarding = strFromU8(entries["Handbook/Onboarding.md"]!);
  assert.match(onboarding, /^---\ntags:\n {2}- intro\n---/, "tags emitted as front matter");
  assert.match(onboarding, /# Onboarding/, "title as H1");
  assert.match(onboarding, /\]\(\.\/Onboarding\/Laptop%20setup\.md\)/, "internal link relative + encoded");
  assert.match(onboarding, /!\[pic\]\(uploads\/.*\/image\.png\)/, "image link relative");

  const laptop = strFromU8(entries["Handbook/Onboarding/Laptop setup.md"]!);
  assert.doesNotMatch(laptop, /^---/, "no front matter when there are no tags");
});

test("import: a non-zip buffer is a clean error; svg attachments are skipped", async () => {
  await assert.rejects(
    importZip(services, { workspaceId, uid: "u1", zipName: "x.zip", buffer: Buffer.from("not a zip") }),
    (e) => e instanceof ImportError,
  );

  const svgZip = Buffer.from(
    zipSync({
      "Vault/note.md": strToU8("# Note\n\n![logo](logo.svg)"),
      "Vault/logo.svg": strToU8("<svg></svg>"),
    }),
  );
  const summary = await importZip(services, { workspaceId, uid: "u1", zipName: "vault.zip", buffer: svgZip });
  assert.equal(summary.images, 0, "svg not uploaded");
  assert.ok(summary.warnings.some((w) => /svg/i.test(w)), "svg skip is warned");
});

/** A page's values by field key, page references as their titles. */
async function valuesOf(docId: string): Promise<Record<string, unknown>> {
  const view = await services.types.view(docId);
  const shown = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(shown) : v && typeof v === "object" && "title" in v ? v.title : v;
  return Object.fromEntries(view.fields.filter((f) => f.id in view.values).map((f) => [f.key, shown(view.values[f.id])]));
}

async function freshWorkspace(slug: string): Promise<string> {
  return (await new WorkspaceService(db, SYSTEM).provisionForUser("u1", { name: slug, slug })).id;
}

async function pagesIn(wsId: string): Promise<Map<string, string>> {
  const byTitle = new Map<string, string>();
  for (const col of (await services.collections.list()).filter((c) => c.workspaceId === wsId)) {
    const walk = (nodes: DocumentNode[]): void => {
      for (const n of nodes) {
        byTitle.set(n.title, n.id);
        walk(n.children);
      }
    };
    walk(await services.documentTree.tree(col.id));
  }
  return byTitle;
}

test("import: front matter keys other than tags become properties", async () => {
  const zip = Buffer.from(
    zipSync({
      "Meetings/Standup.md": strToU8("---\nstatus: draft\ntags: daily\n---\n\n# Standup\n\nNotes."),
      "Meetings/Review.md": strToU8(
        "---\ntag: [q3]\nreview:\n  owner: ana\n  due: 2026-01-02\nstatus: done\n---\nPlain body.",
      ),
      "Meetings/Broken.md": strToU8("---\nstatus: [draft\n---\nKept."),
    }),
  );
  const summary = await importZip(services, { workspaceId, uid: "u1", zipName: "notes.zip", buffer: zip });
  assert.deepEqual(summary, {
    collections: 1,
    documents: 3,
    images: 0,
    warnings: ["Kept the front matter of Meetings/Broken.md as text: it isn't valid YAML"],
  });

  const col = (await services.collections.list()).find((c) => c.name === "Meetings")!;
  const byTitle = new Map((await services.documentTree.tree(col.id)).map((d) => [d.title, d]));
  assert.deepEqual(byTitle.get("Standup")!.tags, ["daily"]);
  assert.deepEqual(byTitle.get("Review")!.tags, ["q3"]);
  assert.equal((await services.documents.get(byTitle.get("Standup")!.id))!.contentMd, "Notes.");
  assert.equal((await services.documents.get(byTitle.get("Review")!.id))!.contentMd, "Plain body.");
  assert.deepEqual(await valuesOf(byTitle.get("Standup")!.id), { status: "draft" });
  assert.deepEqual(await valuesOf(byTitle.get("Review")!.id), {
    review: { owner: "ana", due: "2026-01-02" },
    status: "done",
  });
  assert.deepEqual(
    (await services.types.listFields(workspaceId)).map((f) => [f.key, f.kind]),
    [
      ["review", "json"],
      ["status", "text"],
    ],
  );
});

test("import: an Obsidian vault gets one inferred kind per key and its [[links]] resolved", async () => {
  const vaultWs = await freshWorkspace("obsidian-vault");
  const zip = Buffer.from(
    zipSync({
      "Ana.md": strToU8(
        [
          "---",
          "# synced from the CRM",
          "rating: 3",
          "done: true",
          "due: 2026-10-01",
          'version: "1.10"',
          'answer: "no"',
          "meta:",
          "  owner: ana",
          "people:",
          '  - "[[Bo]]"',
          '  - "[[Cy|Cyrus]]"',
          'lead: "[[Bo]]"',
          "mixed: 5",
          "labels: [x, y]",
          "---",
          "Ana's notes.",
        ].join("\n"),
      ),
      "Bo.md": strToU8(
        [
          "---",
          "rating: 4.5",
          "done: false",
          'version: "2.0"',
          "people: []",
          'lead: ["[[Ana]]", "[[Nobody]]"]',
          "mixed: five",
          "labels: z",
          "---",
          "Bo's notes.",
        ].join("\n"),
      ),
      "Cy.md": strToU8("No front matter."),
    }),
  );
  const summary = await importZip(services, { workspaceId: vaultWs, uid: "u1", zipName: "vault.zip", buffer: zip });
  assert.deepEqual(summary, {
    collections: 1,
    documents: 3,
    images: 0,
    warnings: [
      '"mixed" holds different kinds of values across notes (number, text), so it became a text field.',
      "Bo.md: lead: unresolved link [[Nobody]]",
      "Front matter became properties, so YAML comments and formatting weren't kept in Ana.md",
    ],
  });

  assert.deepEqual(
    (await services.types.listFields(vaultWs)).map((f) => [f.key, f.kind, f.options.map((o) => o.label)]),
    [
      ["rating", "number", []],
      ["done", "checkbox", []],
      ["due", "date", []],
      ["version", "text", []],
      ["answer", "text", []],
      ["meta", "json", []],
      ["people", "doc_list", []],
      ["lead", "doc_list", []],
      ["mixed", "text", []],
      ["labels", "multi_select", ["x", "y", "z"]],
    ],
  );
  const pages = await pagesIn(vaultWs);
  assert.deepEqual(await valuesOf(pages.get("Ana")!), {
    answer: "no",
    done: true,
    due: "2026-10-01",
    labels: ["x", "y"],
    lead: ["Bo"],
    meta: { owner: "ana" },
    mixed: "5",
    people: ["Bo", "Cy"],
    rating: 3,
    version: "1.10",
  });
  assert.deepEqual(await valuesOf(pages.get("Bo")!), {
    done: false,
    labels: ["z"],
    lead: ["Ana"],
    mixed: "five",
    rating: 4.5,
    version: "2.0",
  });
  assert.deepEqual(await valuesOf(pages.get("Cy")!), {});
});

test("export -> import keeps every kind, and a re-import patches only what changed", async () => {
  const teamWs = await freshWorkspace("typed-team");
  const copyWs = await freshWorkspace("typed-copy");
  const col = await services.collections.create({ workspaceId: teamWs, name: "Team", slug: "team" });
  const meeting = await services.types.createType(teamWs, "Meeting");
  const define = (key: string, kind: FieldKind, typeId: string | null, options?: string[]) =>
    services.types.createField({ workspaceId: teamWs, typeId, key, kind, options });
  await define("date", "date", meeting.id);
  const status = await define("status", "select", meeting.id, ["Todo", "Done"]);
  await define("attendees", "doc_list", meeting.id);
  await define("lead", "doc", meeting.id);
  await define("topics", "multi_select", meeting.id, ["Ops", "Sales"]);
  const budget = await define("budget", "number", meeting.id);
  await define("approved", "checkbox", meeting.id);
  await define("start", "datetime", meeting.id);
  await define("link", "url", meeting.id);
  const version = await define("version", "text", null);
  const raw = await define("raw", "json", null);

  const ana = await services.documents.create({ collectionId: col.id, title: "Ana" });
  const bo = await services.documents.create({ collectionId: col.id, title: "Bo" });
  const planned = await services.types.planCreate(col.id, {
    type: "Meeting",
    properties: {
      date: "2026-10-22",
      status: "Done",
      attendees: [ana.id, bo.id],
      lead: bo.id,
      topics: ["Sales", "Ops"],
      budget: 1200,
      approved: true,
      start: "2026-10-22T09:30:00Z",
      link: "https://example.com/agenda",
      version: "1.10",
    },
  });
  const standup = await services.documents.create({
    collectionId: col.id,
    title: "Standup",
    markdown: "Notes.",
    typeId: planned.typeId,
    properties: [...planned.ops, { op: "set", field: raw.id, value: { room: "4B", seats: [1, 2] } }],
  });

  const exported = unzipSync((await buildExportZip(services, { collectionId: col.id }, "Team")).buffer);
  assert.deepEqual(Object.keys(exported).sort(), ["Team/Ana.md", "Team/Bo.md", "Team/Standup.md", "_tandem/fields.json"]);
  const standupMd = strFromU8(exported["Team/Standup.md"]!);
  assert.equal(
    standupMd,
    [
      "---",
      `tandem-id: ${standup.id}`,
      "tandem-type: Meeting",
      "date: 2026-10-22",
      "status: Done",
      "attendees:",
      '  - "[[Ana]]"',
      '  - "[[Bo]]"',
      'lead: "[[Bo]]"',
      "topics:",
      "  - Sales",
      "  - Ops",
      "budget: 1200",
      "approved: true",
      "start: 2026-10-22T09:30:00.000Z",
      "link: https://example.com/agenda",
      "raw:",
      "  room: 4B",
      "  seats:",
      "    - 1",
      "    - 2",
      'version: "1.10"',
      "---",
      "",
      "# Standup",
      "",
      "Notes.",
      "",
    ].join("\n"),
  );
  assert.equal(strFromU8(exported["Team/Ana.md"]!), `---\ntandem-id: ${ana.id}\n---\n\n# Ana\n`);
  const zipOf = (files: Record<string, Uint8Array>) => Buffer.from(zipSync(files));

  const copied = await importZip(services, { workspaceId: copyWs, uid: "u1", zipName: "team.zip", buffer: zipOf(exported) });
  assert.deepEqual(copied, { collections: 1, documents: 3, images: 0, warnings: [] });
  assert.deepEqual(
    (await services.settings.auditTrail(copyWs)).map((e) => `${e.action} ${e.detail}`).sort(),
    [
      'define_field field "approved" (checkbox)',
      'define_field field "attendees" (doc_list)',
      'define_field field "budget" (number)',
      'define_field field "date" (date)',
      'define_field field "lead" (doc)',
      'define_field field "link" (url)',
      'define_field field "raw" (json)',
      'define_field field "start" (datetime)',
      'define_field field "status" (select)',
      'define_field field "topics" (multi_select)',
      'define_field field "version" (text)',
      'define_type type "Meeting"',
    ],
  );
  const copy = await pagesIn(copyWs);
  assert.deepEqual((await services.types.view(copy.get("Standup")!)).type?.name, "Meeting");
  assert.deepEqual(
    (await services.types.listTypes(copyWs)).map((t) => [t.name, t.fields.map((f) => f.key)]),
    [["Meeting", ["date", "status", "attendees", "lead", "topics", "budget", "approved", "start", "link"]]],
  );
  const copiedValues = await services.types.view(copy.get("Standup")!);
  assert.deepEqual(
    Object.fromEntries(copiedValues.fields.map((f) => [f.key, copiedValues.values[f.id]])),
    {
      date: "2026-10-22",
      status: "Done",
      attendees: [
        { id: copy.get("Ana"), title: "Ana" },
        { id: copy.get("Bo"), title: "Bo" },
      ],
      lead: { id: copy.get("Bo"), title: "Bo" },
      topics: ["Sales", "Ops"],
      budget: 1200,
      approved: true,
      start: "2026-10-22T09:30:00.000Z",
      link: "https://example.com/agenda",
      raw: { room: "4B", seats: [1, 2] },
      version: "1.10",
    },
  );

  const writes: Array<{ docId: string; ops: readonly PropertyOp[] }> = [];
  const writer = {
    setProperties: async (docId: string, ops: readonly PropertyOp[]) => {
      writes.push({ docId, ops });
      return null;
    },
  };
  const reimport = (files: Record<string, Uint8Array>) =>
    importZip(services, { workspaceId: teamWs, uid: "u1", zipName: "team.zip", buffer: zipOf(files), writer });
  const edited = (from: string, to: string): Record<string, Uint8Array> => ({
    ...exported,
    "Team/Standup.md": strToU8(standupMd.replace(from, to)),
  });

  assert.deepEqual(await reimport(exported), {
    collections: 0,
    documents: 0,
    images: 0,
    warnings: [
      "3 pages were already in this workspace (matched by tandem-id): updated their properties and left their titles, tags and bodies as they are.",
    ],
  });
  assert.deepEqual(writes, [], "an unchanged export writes nothing");

  await reimport(edited("status: Done", "status: Todo"));
  const todo = status.options.find((o) => o.label === "Todo")!.id;
  assert.deepEqual(writes, [{ docId: standup.id, ops: [{ op: "set", field: status.id, value: todo }] }]);

  writes.length = 0;
  await reimport(edited("budget: 1200\n", ""));
  assert.deepEqual(writes, [{ docId: standup.id, ops: [{ op: "unset", field: budget.id }] }]);

  // A key renamed in Tandem since the export still lands on its field by
  // its old key, even without the sidecar's field ids.
  await services.types.updateField(version.id, { key: "release" });
  const { [SIDECAR_PATH]: _sidecar, ...withoutSidecar } = edited('version: "1.10"', 'version: "1.11"');
  writes.length = 0;
  await reimport(withoutSidecar);
  assert.deepEqual(writes, [{ docId: standup.id, ops: [{ op: "set", field: version.id, value: "1.11" }] }]);

  await importZip(services, {
    workspaceId: teamWs,
    uid: "u1",
    zipName: "team.zip",
    buffer: zipOf(edited("status: Done", "status: Todo")),
  });
  assert.deepEqual((await valuesOf(standup.id)).status, "Todo");
  assert.deepEqual((await pagesIn(teamWs)).size, 3, "no copies of the re-imported pages");

  await reimport(edited("status: Done", "status: Blocked"));
  const [optionAudit] = await services.settings.auditTrail(teamWs);
  assert.deepEqual([optionAudit!.action, optionAudit!.detail], [
    "update_field",
    'field "status": options; options added "Blocked"',
  ]);
});

test("re-import keeps page references the export couldn't show", async () => {
  const ws = await freshWorkspace("hidden-refs");
  const col = await services.collections.create({ workspaceId: ws, name: "Refs", slug: "refs" });
  const attendees = await services.types.createField({ workspaceId: ws, typeId: null, key: "attendees", kind: "doc_list" });
  const lead = await services.types.createField({ workspaceId: ws, typeId: null, key: "lead", kind: "doc" });
  const ana = await services.documents.create({ collectionId: col.id, title: "Ana" });
  const gone = await services.documents.create({ collectionId: col.id, title: "Gone" });
  const binned = await services.documents.create({ collectionId: col.id, title: "Binned" });
  const meeting = await services.documents.create({
    collectionId: col.id,
    title: "Meeting",
    properties: [
      { op: "setList", field: attendees.id, values: [gone.id, ana.id, binned.id] },
      { op: "set", field: lead.id, value: gone.id },
    ],
  });
  await services.documentTree.archive(gone.id);
  await services.documentTree.softDelete(binned.id);

  const exported = unzipSync((await buildExportZip(services, { collectionId: col.id }, "Refs")).buffer);
  const md = strFromU8(exported["Refs/Meeting.md"]!);
  assert.equal(md, `---\ntandem-id: ${meeting.id}\nattendees:\n  - "[[Ana]]"\n---\n\n# Meeting\n`);
  const writes: Array<readonly PropertyOp[]> = [];
  const writer = {
    setProperties: async (_docId: string, ops: readonly PropertyOp[]) => {
      writes.push(ops);
      return null;
    },
  };
  const reimport = (text: string) =>
    importZip(services, {
      workspaceId: ws,
      uid: "u1",
      zipName: "refs.zip",
      buffer: Buffer.from(zipSync({ ...exported, "Refs/Meeting.md": strToU8(text) })),
      writer,
    });

  await reimport(md);
  assert.deepEqual(writes, [], "an unchanged export keeps the hidden references");
  await reimport(md.replace('attendees:\n  - "[[Ana]]"\n', ""));
  assert.deepEqual(writes, [[{ op: "setList", field: attendees.id, values: [gone.id, binned.id] }]]);
});

test("import: a date next to date-times in one key is kept as midnight UTC", async () => {
  const ws = await freshWorkspace("date-and-datetime");
  const zip = Buffer.from(
    zipSync({
      "Repro/Date Only.md": strToU8("---\ndeadline: 2024-06-01\n---\nA."),
      "Repro/Date Time.md": strToU8("---\ndeadline: 2024-06-02T10:00:00Z\n---\nB."),
    }),
  );
  const summary = await importZip(services, { workspaceId: ws, uid: "u1", zipName: "repro.zip", buffer: zip });
  assert.deepEqual(summary.warnings, []);
  assert.deepEqual(
    (await services.types.listFields(ws)).map((f) => [f.key, f.kind]),
    [["deadline", "datetime"]],
  );
  const pages = await pagesIn(ws);
  assert.deepEqual(await valuesOf(pages.get("Date Only")!), { deadline: "2024-06-01T00:00:00.000Z" });
  assert.deepEqual(await valuesOf(pages.get("Date Time")!), { deadline: "2024-06-02T10:00:00.000Z" });
});

test("import: reserved keys in any case are tags and Tandem keys, never fields", async () => {
  const ws = await freshWorkspace("reserved-case");
  const zip = Buffer.from(
    zipSync({
      "Vault/Weird Keys.md": strToU8("---\nTags: [capital-tag]\ntags: 5\n---\nW."),
      "Vault/Ghostly.md": strToU8("---\nTandem-Type: Ghost\nTANDEM-ID: not-an-id\nTAGS:\n  nested: map\n---\nG."),
    }),
  );
  const summary = await importZip(services, { workspaceId: ws, uid: "u1", zipName: "vault.zip", buffer: zip });
  assert.deepEqual(summary.warnings, [
    'Vault/Ghostly.md: TAGS: {"nested":"map"} isn\'t a list of tags',
    'Imported pages of type "Ghost" without a type: this workspace has no such type.',
  ]);
  assert.deepEqual(await services.types.listFields(ws), []);
  const col = (await services.collections.list()).find((c) => c.workspaceId === ws)!;
  const byTitle = new Map((await services.documentTree.tree(col.id)).map((d) => [d.title, d]));
  assert.deepEqual(byTitle.get("Weird Keys")!.tags, ["capital-tag", "5"]);
  assert.deepEqual(byTitle.get("Ghostly")!.tags, []);
});

test("import: a __proto__ key is reported, not dropped silently or made a field", async () => {
  const ws = await freshWorkspace("proto-keys");
  const zip = Buffer.from(
    zipSync({ "Vault/Proto.md": strToU8("---\n__proto__: x\nconstructor: y\nstatus: ok\n---\nP.") }),
  );
  const summary = await importZip(services, { workspaceId: ws, uid: "u1", zipName: "vault.zip", buffer: zip });
  assert.deepEqual(summary.warnings, [
    'Vault/Proto.md: __proto__: a key named "__proto__" can\'t be imported',
    'Vault/Proto.md: constructor: a key named "constructor" can\'t be imported',
  ]);
  assert.deepEqual(
    (await services.types.listFields(ws)).map((f) => f.key),
    ["status"],
  );
});
