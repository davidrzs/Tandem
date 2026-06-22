import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDatabase, migrateDatabase } from "@realtime/db";
import { createServices } from "./services.js";
import { createMcpServer } from "./mcp.js";

// Self-contained: in-memory PGlite, migrated fresh. No external DB needed.
const db = createDatabase("memory://");
const services = createServices(db);
const client = new Client({ name: "test", version: "0.0.0" });

/** Parse the JSON text payload from a tool result. */
function payload(res: any): any {
  assert.ok(!res.isError, `tool errored: ${JSON.stringify(res.content)}`);
  return JSON.parse(res.content[0].text);
}

before(async () => {
  await migrateDatabase(db);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await createMcpServer(services).connect(serverT);
  await client.connect(clientT);
});

after(async () => {
  await client.close();
  await db.$dispose();
});

test("tools are advertised", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "append_section",
    "archive_document",
    "create_collection",
    "create_document",
    "get_document",
    "list_collections",
    "list_documents",
    "move_document",
    "search_documents",
    "update_document",
  ]);
});

test("full lifecycle over MCP: create -> get -> search -> update -> tree", async () => {
  const col = payload(
    await client.callTool({
      name: "create_collection",
      arguments: { name: "Docs", slug: "docs" },
    }),
  );

  const parent = payload(
    await client.callTool({
      name: "create_document",
      arguments: {
        collectionId: col.id,
        title: "Guide",
        markdown: "# Guide\n\nDeploy with **podman**.",
      },
    }),
  );

  const child = payload(
    await client.callTool({
      name: "create_document",
      arguments: {
        collectionId: col.id,
        parentDocumentId: parent.id,
        title: "Networking",
        markdown: "Configure the kubernetes ingress.",
      },
    }),
  );

  // get_document returns markdown
  const fetched = payload(
    await client.callTool({ name: "get_document", arguments: { id: parent.id } }),
  );
  assert.match(fetched.markdown, /Deploy with \*\*podman\*\*/);

  // search finds the child by body text
  const hits = payload(
    await client.callTool({
      name: "search_documents",
      arguments: { query: "kubernetes ingress", collectionId: col.id },
    }),
  );
  assert.ok(hits.some((h: any) => h.id === child.id));

  // update changes the body
  payload(
    await client.callTool({
      name: "update_document",
      arguments: { id: parent.id, markdown: "# Guide\n\nNow about terraform." },
    }),
  );
  const afterHits = payload(
    await client.callTool({
      name: "search_documents",
      arguments: { query: "terraform" },
    }),
  );
  assert.ok(afterHits.some((h: any) => h.id === parent.id));

  // tree nests child under parent
  const tree = payload(
    await client.callTool({
      name: "list_documents",
      arguments: { collectionId: col.id },
    }),
  );
  assert.equal(tree.length, 1);
  assert.equal(tree[0].children[0].id, child.id);
});

test("get_document on missing id returns an error result", async () => {
  const res: any = await client.callTool({
    name: "get_document",
    arguments: { id: "00000000-0000-0000-0000-000000000000" },
  });
  assert.equal(res.isError, true);
});
