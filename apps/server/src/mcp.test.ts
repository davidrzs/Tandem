import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDatabase, migrateDatabase, SYSTEM, user } from "@tandem/db";
import { WorkspaceService } from "@tandem/core";
import { getAuthors } from "@tandem/editor";
import * as Y from "yjs";
import { createServices } from "./services.js";
import { createMcpServer } from "./mcp.js";

// Self-contained: in-memory PGlite, migrated fresh. The MCP server acts as a
// user (with a provisioned workspace) so RLS-scoped writes work. No writer is
// wired, so body edits exercise the persisted-state fallback (core editBody),
// which must keep ydoc_state and the markdown read model in lockstep.
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
  // A real auth user row: members/my_tasks join the user table for name/email.
  await db.insert(user).values({ id: "u1", name: "User One", email: "alice@acme.com" });
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
    "add_comment",
    "append_section",
    "archive_document",
    "create_collection",
    "create_document",
    "edit_document",
    "get_authors",
    "get_document",
    "insert_after_heading",
    "list_archived",
    "list_backlinks",
    "list_collections",
    "list_comments",
    "list_documents",
    "list_members",
    "list_tags",
    "list_versions",
    "move_document",
    "my_tasks",
    "read_version",
    "replace_section",
    "resolve_comment",
    "restore_document",
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

test("the writer-less fallback keeps ydoc_state consistent and attributed", async () => {
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
  assert.ok(authors.every((a) => a.ai === true), "fallback edits are AI-attributed");
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

test("create_collection on a duplicate slug returns a clean error, not the raw DB message", async () => {
  await client.callTool({
    name: "create_collection",
    arguments: { name: "Dup", slug: "dup-slug" },
  });
  const res: any = await client.callTool({
    name: "create_collection",
    arguments: { name: "Dup Again", slug: "dup-slug" },
  });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /already exists/);
  assert.doesNotMatch(res.content[0].text, /constraint|duplicate key/i);
});

test("colleague parity: comments, tasks, members, versions, blame, archive round-trip", async () => {
  const col = payload(
    await client.callTool({
      name: "create_collection",
      arguments: { name: "Parity", slug: "parity" },
    }),
  );
  const doc = payload(
    await client.callTool({
      name: "create_document",
      arguments: {
        collectionId: col.id,
        title: "Plan",
        markdown: "# Plan\n\nShip it.\n\n- [ ] @alice write the intro",
      },
    }),
  );

  // Comments: add -> reply -> list -> resolve.
  const top = payload(
    await client.callTool({
      name: "add_comment",
      arguments: { documentId: doc.id, body: "Should this section move?" },
    }),
  );
  payload(
    await client.callTool({
      name: "add_comment",
      arguments: { documentId: doc.id, body: "Yes — under Setup.", parentId: top.id },
    }),
  );
  const thread = payload(
    await client.callTool({ name: "list_comments", arguments: { documentId: doc.id } }),
  );
  assert.equal(thread.length, 2, "top-level + reply");
  assert.equal(thread[1].parentId, top.id);
  const resolved = payload(
    await client.callTool({ name: "resolve_comment", arguments: { id: top.id } }),
  );
  assert.ok(resolved.resolvedAt, "thread resolved");

  // Tasks: the checkbox mentioning @alice (u1's handle) is visible.
  const tasks = payload(await client.callTool({ name: "my_tasks", arguments: {} }));
  assert.ok(
    tasks.some((t: any) => t.documentId === doc.id && /write the intro/.test(t.text)),
    "assigned task surfaced",
  );

  // Members: handle derived from the email local part.
  const members = payload(
    await client.callTool({ name: "list_members", arguments: { workspaceId: col.workspaceId } }),
  );
  assert.ok(members.some((m: any) => m.userId === "u1" && m.handle === "alice"));

  // Versions: capture one, list it, read its markdown.
  const row = await services.documents.get(doc.id);
  await services.snapshots.captureBoundary({
    documentId: doc.id,
    workspaceId: col.workspaceId,
    ydocState: row!.ydocState!,
    sessions: [{ userId: "u1", name: "User One", ai: true, at: Date.now() }],
  });
  const versions = payload(
    await client.callTool({ name: "list_versions", arguments: { documentId: doc.id } }),
  );
  assert.equal(versions.length, 1);
  const version = payload(
    await client.callTool({ name: "read_version", arguments: { id: versions[0].id } }),
  );
  assert.match(version.markdown, /Ship it\./);

  // Blame: creation content is attributed to the AI session of User One.
  const blame = payload(await client.callTool({ name: "get_authors", arguments: { id: doc.id } }));
  assert.ok(
    blame.contributors.some((c: any) => c.userId === "u1" && c.ai === true),
    "AI contributor listed",
  );
  assert.ok(
    blame.spans.some((s: any) => /Ship it\./.test(s.text) && s.author === "User One" && s.ai),
    "text spans attributed",
  );

  // Tags: set + discover.
  payload(
    await client.callTool({
      name: "update_document",
      arguments: { id: doc.id, tags: ["roadmap"] },
    }),
  );
  const tags = payload(await client.callTool({ name: "list_tags", arguments: {} }));
  assert.ok(JSON.stringify(tags).includes("roadmap"));

  // Backlinks: a second doc linking here shows up.
  const other = payload(
    await client.callTool({
      name: "create_document",
      arguments: {
        collectionId: col.id,
        title: "Notes",
        markdown: `See [Plan](/d/${doc.id}).`,
      },
    }),
  );
  const backlinks = payload(
    await client.callTool({ name: "list_backlinks", arguments: { id: doc.id } }),
  );
  assert.ok(backlinks.some((b: any) => b.id === other.id));

  // Archive -> listed as archived -> restore.
  payload(await client.callTool({ name: "archive_document", arguments: { id: other.id } }));
  const archived = payload(
    await client.callTool({ name: "list_archived", arguments: { collectionId: col.id } }),
  );
  assert.ok(archived.some((a: any) => a.id === other.id));
  const restoredDoc = payload(
    await client.callTool({ name: "restore_document", arguments: { id: other.id } }),
  );
  assert.equal(restoredDoc.archivedAt, null);
});

// Must run last: every earlier test relies on u1 having exactly one workspace.
test("create_collection without workspaceId is ambiguous once the actor has two workspaces", async () => {
  await new WorkspaceService(db, SYSTEM).provisionForUser("u1", {
    name: "U1 Second",
    slug: "u1-second",
  });
  const res: any = await client.callTool({
    name: "create_collection",
    arguments: { name: "Ambiguous", slug: "ambiguous" },
  });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /more than one workspace/);
});
