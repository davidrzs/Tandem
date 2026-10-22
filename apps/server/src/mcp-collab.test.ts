import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createDatabase,
  migrateDatabase,
  oauthApplication,
  SYSTEM,
  user as userTable,
  workspaceMembers,
} from "@tandem/db";
import { COLLAB_FIELD, blameSpans, getAuthors, jsonToMarkdown, propertiesToJSON, schema } from "@tandem/editor";
import { CollectionService, TypeService, WorkspaceService } from "@tandem/core";
import { yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import type * as Y from "yjs";
import { createAuth } from "./auth.js";
import { createCollabWriter } from "./collab-writer.js";
import { createHocuspocus } from "./collab.js";
import { mcpAuthor } from "./http.js";
import { createMcpServer } from "./mcp.js";
import { createServices } from "./services.js";

const db = createDatabase("memory://");
const hocuspocus = createHocuspocus(db, createAuth(db), { debounce: 50 });
const u1 = { kind: "user", userId: "u1" } as const;
const u1Human = { userId: "u1", name: "User One", ai: false };
const u1Agent = { userId: "u1", name: "User One", ai: true };
const services = createServices(db, u1, u1Human);
const writer = createCollabWriter(hocuspocus, services.documents, u1Agent);
const client = new Client({ name: "test", version: "0.0.0" });

let collectionId = "";
let docId = "";
const auditEntries: Array<{
  action: string;
  detail: string;
  workspaceId: string | null;
  documentId: string | null;
  sessionId: number | null;
}> = [];

async function liveMarkdown(id: string): Promise<string> {
  const conn = await hocuspocus.openDirectConnection(id, { userId: "u1" });
  let md = "";
  await conn.transact((doc) => {
    md = jsonToMarkdown(yXmlFragmentToProsemirrorJSON(doc.getXmlFragment(COLLAB_FIELD)));
  });
  await conn.disconnect();
  return md;
}

/** Blame over the live doc: text of each span joined per author identity. */
async function liveBlame(id: string): Promise<Map<string, string>> {
  const conn = await hocuspocus.openDirectConnection(id, { userId: "u1" });
  const byAuthor = new Map<string, string>();
  await conn.transact((doc) => {
    const authors = getAuthors(doc as unknown as Y.Doc);
    const fragment = doc.getXmlFragment(COLLAB_FIELD);
    const pm = schema.nodeFromJSON(yXmlFragmentToProsemirrorJSON(fragment) as never);
    for (const span of blameSpans(fragment)) {
      const info = authors.get(span.clientId);
      const key = info ? `${info.userId}:${info.ai ? "ai" : "human"}` : "unknown";
      const text = pm.textBetween(span.from, span.to, "\n");
      byAuthor.set(key, (byAuthor.get(key) ?? "") + text);
    }
  });
  await conn.disconnect();
  return byAuthor;
}

function payload(res: any): any {
  assert.ok(!res.isError, `tool errored: ${JSON.stringify(res.content)}`);
  return JSON.parse(res.content[0].text);
}

before(async () => {
  await migrateDatabase(db);
  await new WorkspaceService(db, SYSTEM).provisionForUser("u1", { name: "U1", slug: "u1" });
  const col = await new CollectionService(db, u1).create({ name: "C", slug: "c" });
  collectionId = col.id;
  // Created by the human: the seed content must be attributed to them.
  docId = (
    await services.documents.create({
      collectionId: col.id,
      title: "Doc",
      markdown: "# Spec\n\nHuman wrote this intro.",
    })
  ).id;

  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await createMcpServer(services, {
    publicUrl: "http://app.test",
    writer,
    audit: (action, detail, workspaceId, target) =>
      auditEntries.push({ action, detail, workspaceId, ...target }),
  }).connect(serverT);
  await client.connect(clientT);
});

after(async () => {
  await client.close();
  await db.$dispose();
});

test("MCP edits funnel through the live Y.Doc and stay minimal", async () => {
  payload(
    await client.callTool({
      name: "append_section",
      arguments: { id: docId, markdown: "## Appended\n\nFrom the agent." },
    }),
  );
  let live = await liveMarkdown(docId);
  assert.match(live, /Human wrote this intro\./, "original content retained");
  assert.match(live, /## Appended/, "appended heading present");

  payload(
    await client.callTool({
      name: "edit_document",
      arguments: { id: docId, old_string: "From the agent.", new_string: "From the *agent*, edited." },
    }),
  );
  payload(
    await client.callTool({
      name: "insert_after_heading",
      arguments: { id: docId, heading: "Spec", markdown: "> Agent note." },
    }),
  );
  live = await liveMarkdown(docId);
  assert.match(live, /# Spec\n\n> Agent note\./, "inserted under the heading");
  assert.match(live, /From the \*agent\*, edited\./);

  await new Promise((r) => setTimeout(r, 400));
  const doc = await services.documents.get(docId);
  assert.match(doc!.contentMd, /## Appended/, "persisted to content_md");
  assert.ok(doc!.ydocState && doc!.ydocState.length > 0, "ydoc_state persisted");
});

test("blame: human seed stays human; every agent edit is AI-attributed to the invoking user", async () => {
  const blame = await liveBlame(docId);
  const human = blame.get("u1:human") ?? "";
  const ai = blame.get("u1:ai") ?? "";

  assert.ok(human.includes("Human wrote this intro."), "seed content is the human's");
  assert.ok(human.includes("Spec"), "seed heading is the human's");
  assert.ok(ai.includes("Appended"), "appended section is the AI's");
  assert.ok(ai.includes("Agent note."), "inserted note is the AI's");
  assert.ok(!ai.includes("Human wrote this intro."), "AI never claims human text");

  // Attribution survives persistence (it lives inside ydoc_state).
  await new Promise((r) => setTimeout(r, 400));
  const row = await services.documents.get(docId);
  assert.ok(row?.ydocState);
});

test("replace_section touches only the addressed section", async () => {
  payload(
    await client.callTool({
      name: "replace_section",
      arguments: { id: docId, heading: "Appended", markdown: "Rewritten body." },
    }),
  );
  const live = await liveMarkdown(docId);
  assert.match(live, /## Appended\n\nRewritten body\./);
  assert.match(live, /Human wrote this intro\./, "other sections untouched");
  assert.ok(!live.includes("edited."), "old section body gone");
});

test("agent writes leave a workspace-scoped audit trail; denied writes leave none", async () => {
  const actions = auditEntries.map((e) => e.action);
  for (const expected of ["append_section", "edit_document", "insert_after_heading", "replace_section"]) {
    assert.ok(actions.includes(expected), `audited: ${expected}`);
  }
  assert.ok(
    auditEntries.every((e) => e.workspaceId),
    "every entry is tied to a workspace",
  );
  assert.ok(
    auditEntries.some((e) => e.detail.includes("Doc")),
    "detail names the document",
  );
  assert.ok(
    auditEntries.every((e) => e.documentId === docId && e.sessionId !== null),
    "each edit is deep-linked to its document and exact authorship session",
  );
});

test("an edit through an OAuth client stamps the application name as the agent", async () => {
  await db.insert(userTable).values({ id: "u1", name: "User One", email: "u1@example.test" });
  await db.insert(oauthApplication).values({ id: "app-claude", name: "Claude", clientId: "claude" });
  const author = await mcpAuthor(db, { userId: "u1", clientId: "claude" });
  assert.deepEqual(author, { userId: "u1", name: "User One", ai: true, agent: "Claude" });
  assert.deepEqual(
    await mcpAuthor(db, { userId: "u1", clientId: "deleted-app" }),
    { userId: "u1", name: "User One", ai: true },
    "an unknown application falls back to the plain AI identity",
  );

  const agentServices = createServices(db, u1, author);
  const agentClient = new Client({ name: "test-claude", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await createMcpServer(agentServices, {
    publicUrl: "http://app.test",
    writer: createCollabWriter(hocuspocus, agentServices.documents, author),
  }).connect(serverT);
  await agentClient.connect(clientT);
  try {
    payload(
      await agentClient.callTool({
        name: "append_section",
        arguments: { id: docId, markdown: "Written by Claude." },
      }),
    );
  } finally {
    await agentClient.close();
  }

  const conn = await hocuspocus.openDirectConnection(docId, { userId: "u1" });
  let stamped: unknown;
  await conn.transact((doc) => {
    const authors = getAuthors(doc as unknown as Y.Doc);
    const fragment = doc.getXmlFragment(COLLAB_FIELD);
    const pm = schema.nodeFromJSON(yXmlFragmentToProsemirrorJSON(fragment) as never);
    const span = blameSpans(fragment).find(
      (s) => pm.textBetween(s.from, s.to, "\n") === "Written by Claude.",
    );
    stamped = span && { ...authors.get(span.clientId), at: 0 };
  });
  await conn.disconnect();
  assert.deepEqual(stamped, { userId: "u1", name: "User One", ai: true, agent: "Claude", at: 0 });
});

test("set_properties writes through the live doc; get_document, search, get_authors and read_version show it", async () => {
  const workspaceId = (await services.documents.getMeta(docId))!.workspaceId;
  const types = new TypeService(db, u1);
  const meeting = await types.createType(workspaceId, "Meeting");
  const status = await types.createField({
    workspaceId,
    typeId: meeting.id,
    key: "status",
    kind: "select",
    options: ["Open", "Done"],
  });
  const attendees = await types.createField({
    workspaceId,
    typeId: meeting.id,
    key: "attendees",
    kind: "multi_select",
    options: ["Ann", "Bob", "Cy"],
  });
  const opt = (field: typeof status, label: string) => field.options.find((o) => o.label === label)!.id;
  await services.types.setDocumentType(docId, meeting.id);
  const markdownBefore = payload(await client.callTool({ name: "get_document", arguments: { id: docId } })).markdown;

  const set = payload(
    await client.callTool({
      name: "set_properties",
      arguments: { id: docId, set: { status: "done" }, add: { attendees: ["ann"] } },
    }),
  );
  assert.deepEqual(set.properties, { status: "Done", attendees: ["Ann"] });

  const conn = await hocuspocus.openDirectConnection(docId, { userId: "u1" });
  let live: unknown;
  await conn.transact((doc) => {
    live = propertiesToJSON(doc as unknown as Y.Doc);
  });
  await conn.disconnect();
  assert.deepEqual(live, { [status.id]: opt(status, "Done"), [attendees.id]: [opt(attendees, "Ann")] });

  const got = payload(await client.callTool({ name: "get_document", arguments: { id: docId } }));
  assert.equal(got.markdown, markdownBefore);
  assert.deepEqual(
    { type: got.type, properties: got.properties, property_issues: got.property_issues },
    { type: { id: meeting.id, name: "Meeting" }, properties: { status: "Done", attendees: ["Ann"] }, property_issues: [] },
  );
  assert.ok(
    (await services.documentQueries.search("done")).some((h) => h.id === docId),
    "a search for the value finds the page",
  );
  const audited = auditEntries.at(-1)!;
  assert.deepEqual(
    { ...audited, sessionId: typeof audited.sessionId },
    {
      action: "set_properties",
      detail: '"Doc": status, attendees',
      workspaceId,
      documentId: docId,
      sessionId: "number",
    },
  );

  const authors = payload(await client.callTool({ name: "get_authors", arguments: { id: docId } }));
  assert.deepEqual(
    authors.properties.map(({ at, ...rest }: { at: string }) => rest),
    [
      { field: "status", value: "Done", author: "User One", ai: true },
      { field: "attendees", value: "Ann", author: "User One", ai: true },
    ],
  );

  await services.snapshots.captureBoundary({
    documentId: docId,
    workspaceId,
    ydocState: (await services.documents.get(docId))!.ydocState!,
    sessions: [],
  });
  const [version] = await services.snapshots.list(docId);
  const read = payload(await client.callTool({ name: "read_version", arguments: { id: version!.id } }));
  assert.deepEqual(
    { properties: read.properties, property_issues: read.property_issues, markdown: read.markdown },
    { properties: { status: "Done", attendees: ["Ann"] }, property_issues: [], markdown: markdownBefore },
  );

  await Promise.all(
    ["Bob", "Cy"].map((name) =>
      client.callTool({ name: "set_properties", arguments: { id: docId, add: { attendees: name } } }),
    ),
  );
  const after = payload(await client.callTool({ name: "get_document", arguments: { id: docId } }));
  assert.deepEqual(after.properties.attendees, ["Ann", "Bob", "Cy"]);
});

test("a write to a read-only document is a permission error, not silent success", async () => {
  // u2 is a plain member; the collection only grants members read access.
  await db.insert(workspaceMembers).values({
    workspaceId: (await services.workspaces.listMine())[0]!.id,
    userId: "u2",
    role: "member",
  });
  await new CollectionService(db, u1).setDefaultRole(collectionId, "read");

  const u2Services = createServices(
    db,
    { kind: "user", userId: "u2" },
    { userId: "u2", name: "User Two", ai: true },
  );
  const u2Writer = createCollabWriter(hocuspocus, u2Services.documents, {
    userId: "u2",
    name: "User Two",
    ai: true,
  });
  const u2Client = new Client({ name: "test-u2", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await createMcpServer(u2Services, {
    publicUrl: "http://app.test",
    writer: u2Writer,
  }).connect(serverT);
  await u2Client.connect(clientT);

  try {
    // u2 can read it…
    const fetched = payload(
      await u2Client.callTool({ name: "get_document", arguments: { id: docId } }),
    );
    assert.match(fetched.markdown, /Human wrote this intro\./);

    const before = await liveMarkdown(docId);

    // …but every write surface reports permission denied.
    for (const call of [
      { name: "edit_document", arguments: { id: docId, old_string: "intro", new_string: "x" } },
      { name: "append_section", arguments: { id: docId, markdown: "sneaky" } },
      { name: "replace_section", arguments: { id: docId, heading: "Spec", markdown: "x" } },
      { name: "insert_after_heading", arguments: { id: docId, heading: "Spec", markdown: "x" } },
      { name: "update_document", arguments: { id: docId, title: "hijacked" } },
      { name: "archive_document", arguments: { id: docId } },
    ]) {
      const res: any = await u2Client.callTool(call);
      assert.equal(res.isError, true, `${call.name} must fail`);
      assert.match(res.content[0].text, /permission denied/i, `${call.name} says why`);
    }

    // The live document was never touched by the denied writes, and none of
    // them produced audit entries (u2's server has no successful writes).
    assert.equal(await liveMarkdown(docId), before);
    const meta = await services.documents.getMeta(docId);
    assert.equal(meta!.title, "Doc", "title unchanged");
    assert.equal(meta!.archivedAt, null, "not archived");
  } finally {
    await u2Client.close();
  }
});
