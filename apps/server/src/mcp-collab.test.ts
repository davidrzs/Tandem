import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDatabase, migrateDatabase, SYSTEM } from "@realtime/db";
import { COLLAB_FIELD, jsonToMarkdown } from "@realtime/editor";
import { CollectionService, DocumentService, WorkspaceService } from "@realtime/core";
import { yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import { createAuth } from "./auth.js";
import { createCollabWriter } from "./collab-writer.js";
import { createHocuspocus } from "./collab.js";
import { createMcpServer } from "./mcp.js";
import { createServices } from "./services.js";

const db = createDatabase("memory://");
const hocuspocus = createHocuspocus(db, createAuth(db), { debounce: 50 });
const writer = createCollabWriter(hocuspocus, "u1");
const u1 = { kind: "user", userId: "u1" } as const;
const client = new Client({ name: "test", version: "0.0.0" });

let docId = "";

async function liveMarkdown(id: string): Promise<string> {
  const conn = await hocuspocus.openDirectConnection(id, { userId: "u1" });
  let md = "";
  await conn.transact((doc) => {
    md = jsonToMarkdown(yXmlFragmentToProsemirrorJSON(doc.getXmlFragment(COLLAB_FIELD)));
  });
  await conn.disconnect();
  return md;
}

function payload(res: any): any {
  assert.ok(!res.isError, `tool errored: ${JSON.stringify(res.content)}`);
  return JSON.parse(res.content[0].text);
}

before(async () => {
  await migrateDatabase(db);
  await new WorkspaceService(db, SYSTEM).provisionForUser("u1", { name: "U1", slug: "u1" });
  const col = await new CollectionService(db, u1).create({ name: "C", slug: "c" });
  docId = (await new DocumentService(db, u1).create({ collectionId: col.id, title: "Doc" })).id;

  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await createMcpServer(createServices(db, u1), writer).connect(serverT);
  await client.connect(clientT);
});

after(async () => {
  await client.close();
  await db.$dispose();
});

test("MCP writes funnel through the live Y.Doc (uniform write path)", async () => {
  payload(
    await client.callTool({
      name: "update_document",
      arguments: { id: docId, markdown: "# Spec\n\nInitial body." },
    }),
  );
  let live = await liveMarkdown(docId);
  assert.match(live, /# Spec/);
  assert.match(live, /Initial body\./);

  payload(
    await client.callTool({
      name: "append_section",
      arguments: { id: docId, markdown: "## Appended\n\nFrom the agent." },
    }),
  );
  live = await liveMarkdown(docId);
  assert.match(live, /Initial body\./, "original content retained");
  assert.match(live, /## Appended/, "appended heading present");

  await new Promise((r) => setTimeout(r, 400));
  const doc = await new DocumentService(db, u1).get(docId);
  assert.match(doc!.contentMd, /## Appended/, "persisted to content_md");
  assert.ok(doc!.ydocState && doc!.ydocState.length > 0, "ydoc_state persisted");
});
