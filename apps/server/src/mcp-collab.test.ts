import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDatabase, migrateDatabase } from "@realtime/db";
import { COLLAB_FIELD, jsonToMarkdown } from "@realtime/editor";
import { yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import { createAuth } from "./auth.js";
import { createCollabWriter } from "./collab-writer.js";
import { createHocuspocus } from "./collab.js";
import { createMcpServer } from "./mcp.js";
import { createServices } from "./services.js";

const db = createDatabase("memory://");
const services = createServices(db);
const hocuspocus = createHocuspocus(services, createAuth(db), { debounce: 50 });
const writer = createCollabWriter(hocuspocus);
const client = new Client({ name: "test", version: "0.0.0" });

let docId = "";

/** Read the current text of the LIVE Y.Doc (not the DB) for this document. */
async function liveMarkdown(id: string): Promise<string> {
  const conn = await hocuspocus.openDirectConnection(id, { userId: "probe" });
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
  const col = await services.collections.create({ name: "C", slug: "c" });
  docId = (await services.documents.create({ collectionId: col.id, title: "Doc" })).id;
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await createMcpServer(services, writer).connect(serverT);
  await client.connect(clientT);
});

after(async () => {
  await client.close();
  await db.$dispose();
});

test("MCP writes funnel through the live Y.Doc (uniform write path)", async () => {
  // update_document replaces the body via the live document.
  payload(
    await client.callTool({
      name: "update_document",
      arguments: { id: docId, markdown: "# Spec\n\nInitial body." },
    }),
  );
  let live = await liveMarkdown(docId);
  assert.match(live, /# Spec/);
  assert.match(live, /Initial body\./);

  // append_section adds to the end of the SAME live document.
  payload(
    await client.callTool({
      name: "append_section",
      arguments: { id: docId, markdown: "## Appended\n\nFrom the agent." },
    }),
  );
  live = await liveMarkdown(docId);
  assert.match(live, /Initial body\./, "original content retained");
  assert.match(live, /## Appended/, "appended heading present");
  assert.match(live, /From the agent\./, "appended body present");

  // And it persisted to the DB read model (past the 50ms store debounce).
  await new Promise((r) => setTimeout(r, 400));
  const doc = await services.documents.get(docId);
  assert.match(doc!.contentMd, /## Appended/, "persisted to content_md");
  assert.ok(doc!.ydocState && doc!.ydocState.length > 0, "ydoc_state persisted");
});
