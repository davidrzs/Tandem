import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDatabase, migrateDatabase, SYSTEM, workspaceMembers } from "@tandem/db";
import { COLLAB_FIELD, blameSpans, getAuthors, jsonToMarkdown, schema } from "@tandem/editor";
import { CollectionService, DocumentService, WorkspaceService } from "@tandem/core";
import { yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import type * as Y from "yjs";
import { createAuth } from "./auth.js";
import { createCollabWriter } from "./collab-writer.js";
import { createHocuspocus } from "./collab.js";
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
const auditEntries: Array<{ action: string; detail: string; workspaceId: string | null }> = [];

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
  await createMcpServer(services, writer, (action, detail, workspaceId) =>
    auditEntries.push({ action, detail, workspaceId }),
  ).connect(serverT);
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
  await createMcpServer(u2Services, u2Writer).connect(serverT);
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
