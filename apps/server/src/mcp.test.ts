import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDatabase, migrateDatabase, SYSTEM } from "@tandem/db";
import { WorkspaceService } from "@tandem/core";
import { getAuthors } from "@tandem/editor";
import * as Y from "yjs";
import { createServices } from "./services.js";
import { createMcpServer } from "./mcp.js";

// Self-contained: in-memory PGlite, migrated fresh. The MCP server acts as a
// user (with a provisioned workspace) so RLS-scoped writes work. No writer is
// wired, so body edits exercise the stdio fallback (core editBody), which must
// keep ydoc_state and the markdown read model in lockstep.
const db = createDatabase("memory://");
const services = createServices(
  db,
  { kind: "user", userId: "u1" },
  { userId: "u1", name: "User One", ai: true },
);
const client = new Client({ name: "test", version: "0.0.0" });

/** Parse the JSON text payload from a tool result. */
function payload(res: any): any {
  assert.ok(!res.isError, `tool errored: ${JSON.stringify(res.content)}`);
  return JSON.parse(res.content[0].text);
}

before(async () => {
  await migrateDatabase(db);
  await new WorkspaceService(db, SYSTEM).provisionForUser("u1", {
    name: "U1",
    slug: "u1",
  });
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
    "edit_document",
    "get_document",
    "insert_after_heading",
    "list_collections",
    "list_documents",
    "move_document",
    "replace_section",
    "search_documents",
    "update_document",
  ]);
});

test("full lifecycle over MCP: create -> get -> search -> edit -> tree", async () => {
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

  // a targeted edit changes exactly the addressed text
  payload(
    await client.callTool({
      name: "edit_document",
      arguments: {
        id: parent.id,
        old_string: "Deploy with **podman**.",
        new_string: "Now about terraform.",
      },
    }),
  );
  const afterHits = payload(
    await client.callTool({
      name: "search_documents",
      arguments: { query: "terraform" },
    }),
  );
  assert.ok(afterHits.some((h: any) => h.id === parent.id));

  // rename via update_document (title only)
  const renamed = payload(
    await client.callTool({
      name: "update_document",
      arguments: { id: parent.id, title: "Deployment guide" },
    }),
  );
  assert.equal(renamed.title, "Deployment guide");

  // tags via update_document (normalized) then browse by tag
  const tagged = payload(
    await client.callTool({
      name: "update_document",
      arguments: { id: parent.id, tags: ["infra", "Infra", " ops "] },
    }),
  );
  assert.deepEqual(tagged.tags, ["infra", "ops"], "tags normalized and returned");
  const byTag = payload(
    await client.callTool({ name: "search_documents", arguments: { query: "", tag: "ops" } }),
  );
  assert.ok(byTag.some((h: any) => h.id === parent.id), "tag browse finds the doc");

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

test("the stdio fallback keeps ydoc_state consistent and attributed", async () => {
  const col = payload(
    await client.callTool({
      name: "create_collection",
      arguments: { name: "State", slug: "state" },
    }),
  );
  const doc = payload(
    await client.callTool({
      name: "create_document",
      arguments: { collectionId: col.id, title: "S", markdown: "Original body." },
    }),
  );
  payload(
    await client.callTool({
      name: "append_section",
      arguments: { id: doc.id, markdown: "Appended by the agent." },
    }),
  );

  const row = await services.documents.get(doc.id);
  assert.ok(row?.ydocState && row.ydocState.length > 0, "ydoc_state persisted");
  assert.match(row!.contentMd, /Original body\./);
  assert.match(row!.contentMd, /Appended by the agent\./);

  // The Yjs state carries the same content and the author attribution.
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, row!.ydocState!);
  const authors = [...getAuthors(ydoc).values()];
  assert.ok(authors.length >= 2, "seed + edit sessions recorded");
  assert.ok(authors.every((a) => a.userId === "u1"));
  assert.ok(authors.every((a) => a.ai === true), "stdio edits are AI-attributed");
});

test("targeted edit failures are clean errors, not fake success", async () => {
  const col = payload(
    await client.callTool({
      name: "create_collection",
      arguments: { name: "Errs", slug: "errs" },
    }),
  );
  const doc = payload(
    await client.callTool({
      name: "create_document",
      arguments: { collectionId: col.id, markdown: "## A\n\nsame same" },
    }),
  );

  const missing: any = await client.callTool({
    name: "edit_document",
    arguments: { id: doc.id, old_string: "nope", new_string: "x" },
  });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /not found in the document/);

  const ambiguous: any = await client.callTool({
    name: "edit_document",
    arguments: { id: doc.id, old_string: "same", new_string: "x" },
  });
  assert.equal(ambiguous.isError, true);
  assert.match(ambiguous.content[0].text, /appears 2 times/);

  const badHeading: any = await client.callTool({
    name: "insert_after_heading",
    arguments: { id: doc.id, heading: "Missing", markdown: "x" },
  });
  assert.equal(badHeading.isError, true);
  assert.match(badHeading.content[0].text, /Headings in this document/);

  // Nothing changed.
  const fetched = payload(
    await client.callTool({ name: "get_document", arguments: { id: doc.id } }),
  );
  assert.equal(fetched.markdown, "## A\n\nsame same");
});

test("get_document on missing id returns an error result", async () => {
  const res: any = await client.callTool({
    name: "get_document",
    arguments: { id: "00000000-0000-0000-0000-000000000000" },
  });
  assert.equal(res.isError, true);
});
