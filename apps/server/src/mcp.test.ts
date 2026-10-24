import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createDatabase, migrateDatabase, SYSTEM, user } from "@tandem/db";
import { TypeService, WorkspaceService } from "@tandem/core";
import { getAuthors, propertyBlame } from "@tandem/editor";
import * as Y from "yjs";
import { readImageBytes, verifyImageUploadToken } from "./images.js";
import { createServices } from "./services.js";
import { createMcpServer, MCP_IMAGE_MAX_BYTES } from "./mcp.js";

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

let uploadsTmp: string;

before(async () => {
  uploadsTmp = await mkdtemp(join(tmpdir(), "tandem-mcp-"));
  process.env.UPLOADS_DIR = uploadsTmp;
  await migrateDatabase(db);
  // A real auth user row: members/my_tasks join the user table for name/email.
  await db.insert(user).values({ id: "u1", name: "User One", email: "alice@acme.com" });
  await new WorkspaceService(db, SYSTEM).provisionForUser("u1", {
    name: "U1",
    slug: "u1",
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await createMcpServer(services, {
    publicUrl: "http://app.test",
    uploads: {
      secret: "test-secret-value-at-least-16-chars-long",
    },
  }).connect(serverT);
  await client.connect(clientT);
});

after(async () => {
  await client.close();
  await db.$dispose();
  await rm(uploadsTmp, { recursive: true, force: true });
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
    "create_from_template",
    "edit_document",
    "get_authors",
    "get_document",
    "insert_after_heading",
    "list_archived",
    "list_backlinks",
    "list_collections",
    "list_comments",
    "list_documents",
    "list_fields",
    "list_members",
    "list_tags",
    "list_templates",
    "list_types",
    "list_versions",
    "move_document",
    "my_tasks",
    "open_tasks",
    "read_version",
    "recent_documents",
    "replace_section",
    "request_image_upload",
    "resolve_comment",
    "restore_document",
    "search_documents",
    "set_properties",
    "update_document",
    "upload_image",
  ]);
});

test("oversized inputs are rejected by the shared limits", async () => {
  const res: any = await client
    .callTool({
      name: "create_document",
      arguments: { collectionId: "00000000-0000-4000-8000-000000000000", title: "x".repeat(501) },
    })
    .catch((e: Error) => ({ isError: true, content: [{ text: e.message }] }));
  assert.ok(res.isError, "title over the limit is refused");
  assert.match(JSON.stringify(res.content), /500|too_big|at most/i);
});

test("templates over MCP: list_templates, then create_from_template with and without dryRun", async () => {
  const col = payload(
    await client.callTool({ name: "create_collection", arguments: { name: "Rituals", slug: "rituals" } }),
  );
  const tpl = payload(
    await client.callTool({
      name: "create_document",
      arguments: { collectionId: col.id, title: "Standup {{date}}", markdown: "Hi {{me}}, client {{client}}" },
    }),
  );
  await client.callTool({
    name: "create_document",
    arguments: { collectionId: col.id, parentDocumentId: tpl.id, title: "Agenda", markdown: "For {{parent}}" },
  });
  await services.templates.templatize(tpl.id, "Standup");

  const listed = payload(await client.callTool({ name: "list_templates", arguments: {} }));
  assert.deepEqual(
    listed.map((t: any) => [t.name, t.url]),
    [["Standup", `http://app.test/d/${tpl.id}`]],
  );

  const dry = payload(
    await client.callTool({
      name: "create_from_template",
      arguments: { templateId: tpl.id, collectionId: col.id, variables: { date: "2026-03-04" }, dryRun: true },
    }),
  );
  assert.equal(dry.document, null);
  assert.deepEqual(dry.missing, ["client"]);
  assert.deepEqual(dry.page, {
    title: "Standup 2026-03-04",
    markdown: "Hi User One, client ",
    children: [{ title: "Agenda", markdown: "For Standup 2026-03-04", children: [] }],
  });
  assert.equal((await services.documentTree.tree(col.id)).length, 1, "the dry run created nothing");

  await services.templates.setDefault({ collectionId: col.id }, tpl.id);
  const made = payload(
    await client.callTool({
      name: "create_from_template",
      arguments: { collectionId: col.id, variables: { date: "2026-03-04", client: "Acme" } },
    }),
  );
  assert.equal(made.template.id, tpl.id, "no templateId: the collection default");
  assert.deepEqual(made.missing, []);
  assert.equal(made.document.title, "Standup 2026-03-04");
  assert.equal(made.document.url, `http://app.test/d/${made.document.id}`);
  assert.equal((await services.documents.get(made.document.id))!.contentMd, "Hi User One, client Acme");
  const copied = await services.documentTree.subtree(made.document.id, 5);
  assert.deepEqual(copied.nodes.map((n) => n.title), ["Agenda"]);

  const fetched = payload(await client.callTool({ name: "get_document", arguments: { id: made.document.id } }));
  assert.deepEqual(fetched.origin, { templateId: tpl.id, templateName: "Standup", version: made.template.version });
  const plain = payload(await client.callTool({ name: "get_document", arguments: { id: tpl.id } }));
  assert.equal(plain.origin, null);
  await services.templates.untemplatize(tpl.id);
  const orphan = payload(await client.callTool({ name: "get_document", arguments: { id: made.document.id } }));
  assert.deepEqual(orphan.origin, { templateId: tpl.id, templateName: null, version: made.template.version });
});

test("full lifecycle over MCP: create -> get -> search -> edit -> tree", async () => {
  const col = payload(
    await client.callTool({
      name: "create_collection",
      arguments: { name: "Docs", slug: "docs" },
    }),
  );
  assert.equal(col.url, `http://app.test/c/${col.id}`);
  const listedCollections = payload(
    await client.callTool({ name: "list_collections", arguments: {} }),
  );
  assert.equal(
    listedCollections.find((item: any) => item.id === col.id)?.url,
    col.url,
    "collection list returns the same canonical URL as creation",
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
  assert.equal(parent.url, `http://app.test/d/${parent.id}`);
  assert.equal(child.url, `http://app.test/d/${child.id}`);

  // get_document returns markdown
  const fetched = payload(
    await client.callTool({ name: "get_document", arguments: { id: parent.id } }),
  );
  assert.match(fetched.markdown, /Deploy with \*\*podman\*\*/);
  assert.equal(fetched.url, parent.url);

  // search finds the child by body text
  const hits = payload(
    await client.callTool({
      name: "search_documents",
      arguments: { query: "kubernetes ingress", collectionId: col.id },
    }),
  );
  const searchHit = hits.find((h: any) => h.id === child.id);
  assert.ok(searchHit);
  assert.equal(searchHit.url, child.url);
  assert.equal(searchHit.collectionName, "Docs");
  assert.equal(searchHit.path, "Docs / Guide / Networking");
  assert.equal(searchHit.match.kind, "phrase");
  assert.deepEqual(searchHit.match.matchedTerms, ["kubernetes", "ingress"]);
  assert.match(searchHit.match.explanation, /2\/2 query terms matched/);
  assert.match(searchHit.snippet, /\*\*kubernetes\*\*/);
  assert.ok(searchHit.updatedAt);

  const partialHits = payload(
    await client.callTool({
      name: "search_documents",
      arguments: { query: "kubernetes unrelated", collectionId: col.id },
    }),
  );
  const partialHit = partialHits.find((h: any) => h.id === child.id);
  assert.equal(partialHit.match.kind, "partial_terms");
  assert.deepEqual(partialHit.match.matchedTerms, ["kubernetes"]);

  // The caller can keep a document that quotes its own query out of the way.
  const excludedById = payload(
    await client.callTool({
      name: "search_documents",
      arguments: {
        query: "kubernetes ingress",
        collectionId: col.id,
        excludeDocumentIds: [child.id],
      },
    }),
  );
  assert.deepEqual(
    excludedById.map((h: any) => h.id),
    hits.filter((h: any) => h.id !== child.id).map((h: any) => h.id),
    "excludeDocumentIds drops exactly that hit",
  );

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
  assert.equal(renamed.url, parent.url, "rename keeps the canonical document URL stable");

  // tags via update_document (normalized) then browse by tag
  const tagged = payload(
    await client.callTool({
      name: "update_document",
      arguments: { id: parent.id, tags: ["infra", "Infra", " ops "] },
    }),
  );
  assert.deepEqual(tagged.tags, ["infra", "ops"], "tags normalized and returned");
  const excludedByTag = payload(
    await client.callTool({
      name: "search_documents",
      arguments: { query: "terraform", excludeTags: ["ops"] },
    }),
  );
  assert.deepEqual(
    excludedByTag.map((h: any) => h.id),
    afterHits.filter((h: any) => h.id !== parent.id).map((h: any) => h.id),
    "excludeTags drops exactly the tagged hit",
  );
  const byTag = payload(
    await client.callTool({ name: "search_documents", arguments: { query: "", tag: "ops" } }),
  );
  assert.ok(byTag.some((h: any) => h.id === parent.id), "tag browse finds the doc");

  // The default listing is compact and shallow for quick collection orientation.
  const topLevel = payload(
    await client.callTool({
      name: "list_documents",
      arguments: { collectionId: col.id },
    }),
  );
  assert.equal(topLevel.documents.length, 1);
  assert.deepEqual(Object.keys(topLevel.documents[0]).sort(), [
    "id",
    "path",
    "tags",
    "title",
    "updatedAt",
    "url",
  ]);
  assert.equal(topLevel.documents[0].url, parent.url, "listings carry the canonical URL by default");
  assert.equal(topLevel.documents[0].id, parent.id);
  assert.equal(topLevel.documents[0].path, "Deployment guide");
  assert.equal(topLevel.nextCursor, null);

  // Deeper traversal stays flat, carries a readable path, and is paginated.
  const firstPage = payload(
    await client.callTool({
      name: "list_documents",
      arguments: {
        collectionId: col.id,
        depth: 2,
        limit: 1,
        fields: ["id", "path", "url"],
      },
    }),
  );
  assert.equal(firstPage.documents[0].id, parent.id);
  assert.equal(firstPage.documents[0].url, parent.url);
  assert.ok(firstPage.nextCursor);
  const secondPage = payload(
    await client.callTool({
      name: "list_documents",
      arguments: {
        collectionId: col.id,
        depth: 2,
        limit: 1,
        fields: ["id", "path", "url"],
        cursor: firstPage.nextCursor,
      },
    }),
  );
  assert.equal(secondPage.documents[0].id, child.id);
  assert.equal(secondPage.documents[0].path, "Deployment guide / Networking");
  assert.equal(secondPage.documents[0].url, child.url);
  assert.equal(secondPage.nextCursor, null);

  // Subtree listing: one document's descendants, paths still collection-relative.
  const subtree = payload(
    await client.callTool({
      name: "list_documents",
      arguments: {
        collectionId: col.id,
        parentDocumentId: parent.id,
        fields: ["id", "path", "depth"],
      },
    }),
  );
  assert.deepEqual(subtree.documents, [
    { id: child.id, path: "Deployment guide / Networking", depth: 2 },
  ]);
  const missingRoot = await client.callTool({
    name: "list_documents",
    arguments: { collectionId: col.id, parentDocumentId: randomUUID() },
  });
  assert.ok(missingRoot.isError, "an unknown subtree root is reported, not listed as empty");

  const noFutureUpdates = payload(
    await client.callTool({
      name: "list_documents",
      arguments: {
        collectionId: col.id,
        depth: 2,
        updated_after: new Date(Date.now() + 60_000).toISOString(),
      },
    }),
  );
  assert.deepEqual(noFutureUpdates.documents, []);

  const recentFirst = payload(
    await client.callTool({
      name: "recent_documents",
      arguments: { collectionId: col.id, limit: 1 },
    }),
  );
  assert.equal(recentFirst.documents.length, 1);
  assert.ok(recentFirst.nextCursor);
  assert.equal(recentFirst.documents[0].url, `http://app.test/d/${recentFirst.documents[0].id}`);
  const recentSecond = payload(
    await client.callTool({
      name: "recent_documents",
      arguments: { collectionId: col.id, limit: 1, cursor: recentFirst.nextCursor },
    }),
  );
  assert.equal(recentSecond.documents.length, 1);
  assert.notEqual(recentSecond.documents[0].id, recentFirst.documents[0].id);
  assert.equal(recentSecond.nextCursor, null);

  const moved = payload(
    await client.callTool({
      name: "move_document",
      arguments: { id: child.id, parentDocumentId: null },
    }),
  );
  assert.equal(moved.url, child.url, "move keeps the canonical document URL stable");
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

/** The message of a tool result that must be an error. */
function errorText(res: unknown): string {
  const parsed = CallToolResultSchema.parse(res);
  assert.equal(parsed.isError, true, `expected an error: ${JSON.stringify(parsed.content)}`);
  const first = parsed.content[0];
  return first?.type === "text" ? first.text : "";
}

test("markdown that opens with YAML front matter is refused, not stored as a rule and heading", async () => {
  const message =
    "markdown starts with a YAML front matter block (---). Properties are not part of the " +
    "markdown body: send the body without the front matter block, and set the values with " +
    "set_properties (or create_document's properties).";
  const col = payload(
    await client.callTool({ name: "create_collection", arguments: { name: "Props", slug: "props" } }),
  );

  const created = await client.callTool({
    name: "create_document",
    arguments: { collectionId: col.id, markdown: "---\nstatus: draft\n---\n\nBody" },
  });
  assert.equal(errorText(created), message);
  const listed = payload(
    await client.callTool({ name: "list_documents", arguments: { collectionId: col.id } }),
  );
  assert.deepEqual(listed.documents, []);

  const doc = payload(
    await client.callTool({
      name: "create_document",
      arguments: { collectionId: col.id, markdown: "Intro\n\n---\n\nAfter the rule" },
    }),
  );
  for (const [name, args] of [
    ["append_section", { markdown: "---\nstatus: draft\n---" }],
    ["edit_document", { old_string: "Intro", new_string: "---\ntags: [a]\n---\nIntro" }],
  ] as const) {
    const res = await client.callTool({ name, arguments: { id: doc.id, ...args } });
    assert.equal(errorText(res), message, name);
  }
  const fetched = payload(await client.callTool({ name: "get_document", arguments: { id: doc.id } }));
  assert.equal(fetched.markdown, "Intro\n\n---\n\nAfter the rule");
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
  const reply = payload(
    await client.callTool({
      name: "add_comment",
      arguments: { documentId: doc.id, body: "Yes — under Setup.", parentId: top.id },
    }),
  );
  assert.equal(top.url, `http://app.test/d/${doc.id}?comment=${top.id}`);
  assert.equal(reply.url, `http://app.test/d/${doc.id}?comment=${reply.id}`);
  const thread = payload(
    await client.callTool({ name: "list_comments", arguments: { documentId: doc.id } }),
  );
  assert.equal(thread.length, 2, "top-level + reply");
  assert.equal(thread[1].parentId, top.id);
  assert.equal(thread[0].url, top.url);
  assert.equal(thread[1].url, reply.url);
  const resolved = payload(
    await client.callTool({ name: "resolve_comment", arguments: { id: top.id } }),
  );
  assert.ok(resolved.resolvedAt, "thread resolved");
  assert.equal(resolved.url, top.url);

  // Tasks: the checkbox mentioning @alice (u1's handle) is visible.
  const tasks = payload(await client.callTool({ name: "my_tasks", arguments: {} }));
  assert.ok(
    tasks.some((t: any) => t.documentId === doc.id && /write the intro/.test(t.text)),
    "assigned task surfaced",
  );
  assert.equal(
    tasks.find((t: any) => t.documentId === doc.id)?.url,
    doc.url,
    "tasks link to their document",
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
  assert.deepEqual(
    tags.find((t: any) => t.tag === "roadmap"),
    { tag: "roadmap", count: 1 },
    "tags come with their document counts",
  );

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

// 1x1 PNG — the smallest well-formed raster image.
const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("upload_image stores bytes and returns an embeddable snippet", async () => {
  const img = payload(
    await client.callTool({
      name: "upload_image",
      arguments: { data: PNG_1PX, mime: "image/png", alt: "diagram" },
    }),
  );
  assert.equal(img.url, `/api/images/${img.id}`);
  assert.equal(img.markdown, `![diagram](/api/images/${img.id})`);
  assert.equal(img.mime, "image/png");
  assert.equal(img.size, Buffer.from(PNG_1PX, "base64").length);

  assert.deepEqual(await readImageBytes(img.id), Buffer.from(PNG_1PX, "base64"));
  const row = await services.images.get(img.id);
  assert.equal(row?.uploadedBy, "u1");
  const [ws] = await services.workspaces.listMine();
  assert.equal(row?.workspaceId, ws!.id);

  // The snippet survives the markdown round-trip through document content.
  const col = payload(
    await client.callTool({
      name: "create_collection",
      arguments: { name: "Media", slug: "media" },
    }),
  );
  const doc = payload(
    await client.callTool({
      name: "create_document",
      arguments: { collectionId: col.id, title: "Pics", markdown: `Intro.\n\n${img.markdown}` },
    }),
  );
  const fetched = payload(
    await client.callTool({ name: "get_document", arguments: { id: doc.id } }),
  );
  assert.ok(fetched.markdown.includes(`![diagram](/api/images/${img.id})`));
});

test("upload_image tolerates a data: URL prefix", async () => {
  const img = payload(
    await client.callTool({
      name: "upload_image",
      arguments: { data: `data:image/png;base64,${PNG_1PX}`, mime: "image/png" },
    }),
  );
  assert.deepEqual(await readImageBytes(img.id), Buffer.from(PNG_1PX, "base64"));
});

test("upload_image rejects bad mime, bad data, oversize, and foreign workspaces", async () => {
  const errorOf = async (args: Record<string, unknown>) => {
    const res: any = await client.callTool({ name: "upload_image", arguments: args });
    assert.equal(res.isError, true);
    return res.content[0].text as string;
  };

  assert.match(
    await errorOf({ data: PNG_1PX, mime: "image/svg+xml" }),
    /not a supported image type/,
  );
  assert.match(await errorOf({ data: PNG_1PX, mime: "text/plain" }), /not a supported image type/);
  assert.match(await errorOf({ data: "not-base64!!!", mime: "image/png" }), /valid base64/);
  assert.match(
    await errorOf({
      data: Buffer.alloc(MCP_IMAGE_MAX_BYTES + 3).toString("base64"),
      mime: "image/png",
    }),
    /exceeds 3MB/,
  );
  assert.match(
    await errorOf({ data: PNG_1PX, mime: "image/png", workspaceId: randomUUID() }),
    /workspace not found/,
  );
});

test("request_image_upload mints a verifiable short-lived token carrying the alt", async () => {
  const res = payload(
    await client.callTool({
      name: "request_image_upload",
      arguments: { alt: "a [bracketed] caption" },
    }),
  );
  const url = new URL(res.uploadUrl);
  assert.equal(url.origin, "http://app.test");
  assert.equal(url.pathname, "/api/images/upload");
  // The token must not ride in the URL — it would land in access logs.
  assert.equal(url.search, "");
  assert.ok(new Date(res.expiresAt).getTime() > Date.now());
  assert.match(res.example, /Authorization: Bearer /);

  const grant = verifyImageUploadToken("test-secret-value-at-least-16-chars-long", res.token);
  const [ws] = await services.workspaces.listMine();
  assert.deepEqual(grant, {
    userId: "u1",
    workspaceId: ws!.id,
    alt: "a [bracketed] caption",
  });
  // A different secret (or a tampered token) never verifies.
  assert.equal(verifyImageUploadToken("another-secret-not-the-right-one", res.token), null);

  const foreign: any = await client.callTool({
    name: "request_image_upload",
    arguments: { workspaceId: randomUUID() },
  });
  assert.equal(foreign.isError, true);
  assert.match(foreign.content[0].text, /workspace not found/);
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

  const upload: any = await client.callTool({
    name: "upload_image",
    arguments: { data: PNG_1PX, mime: "image/png" },
  });
  assert.equal(upload.isError, true);
  assert.match(upload.content[0].text, /more than one workspace/);
});

test("properties over MCP: create_document with type and values, set_properties, and get_document agree", async () => {
  const ws = (await services.workspaces.listMine()).find((w) => w.slug === "u1")!;
  const col = payload(
    await client.callTool({
      name: "create_collection",
      arguments: { workspaceId: ws.id, name: "Projects", slug: "projects" },
    }),
  );
  const types = new TypeService(db, { kind: "user", userId: "u1" });
  const project = await types.createType(ws.id, "Project");
  const stage = await types.createField({
    workspaceId: ws.id,
    typeId: project.id,
    key: "stage",
    kind: "select",
    options: ["Idea", "Active", "Done"],
  });
  const owners = await types.createField({
    workspaceId: ws.id,
    typeId: project.id,
    key: "owners",
    kind: "multi_select",
    options: ["Ann", "Bob"],
  });
  const budget = await types.createField({ workspaceId: ws.id, typeId: null, key: "budget", kind: "number" });
  const brief = payload(
    await client.callTool({ name: "create_document", arguments: { collectionId: col.id, title: "Brief" } }),
  );

  const created = payload(
    await client.callTool({
      name: "create_document",
      arguments: {
        collectionId: col.id,
        title: "Apollo",
        markdown: "Plan.",
        type: "project",
        properties: { Stage: "idea", owners: ["ann"] },
      },
    }),
  );
  assert.deepEqual(
    { type: created.type, properties: created.properties, property_issues: created.property_issues },
    {
      type: { id: project.id, name: "Project" },
      properties: { stage: "Idea", owners: ["Ann"] },
      property_issues: [],
    },
  );

  const set = payload(
    await client.callTool({
      name: "set_properties",
      arguments: { id: created.id, set: { stage: "Active", budget: "1200" }, add: { owners: "Bob" } },
    }),
  );
  assert.deepEqual(set, {
    id: created.id,
    url: `http://app.test/d/${created.id}`,
    type: { id: project.id, name: "Project" },
    properties: { stage: "Active", owners: ["Ann", "Bob"], budget: 1200 },
    property_issues: [],
  });

  const doc = payload(await client.callTool({ name: "get_document", arguments: { id: created.id } }));
  assert.equal(doc.markdown, "Plan.");
  assert.deepEqual(doc.properties, set.properties);

  const fields = payload(
    await client.callTool({ name: "list_fields", arguments: { workspaceId: ws.id } }),
  );
  assert.deepEqual(
    fields.map((f: any) => [f.key, f.kind, f.type, f.options ?? null]),
    [
      ["stage", "select", "Project", ["Idea", "Active", "Done"]],
      ["owners", "multi_select", "Project", ["Ann", "Bob"]],
      ["budget", "number", null, null],
    ],
  );
  assert.deepEqual(
    [stage.id, owners.id, budget.id].map((id) => fields.find((f: any) => f.id === id)?.key),
    ["stage", "owners", "budget"],
  );

  const unknown = await client.callTool({
    name: "set_properties",
    arguments: { id: created.id, set: { priority: "high" } },
  });
  assert.equal(
    errorText(unknown),
    'unknown field "priority". Fields this page can take: stage (select: Idea, Active, Done); ' +
      "owners (multi_select: Ann, Bob); budget (number). Only a workspace owner or admin can define new fields.",
  );
  assert.deepEqual(
    (await types.listFields(ws.id)).map((f) => f.key),
    ["stage", "owners", "budget"],
    "no field was created",
  );

  const untyped = payload(
    await client.callTool({
      name: "set_properties",
      arguments: { id: brief.id, set: { budget: 50 } },
    }),
  );
  assert.deepEqual(untyped.properties, { budget: 50 });
});

interface TypedPage {
  id: string;
  name?: string;
  title?: string;
  type: { id: string; name: string } | null;
  defaults?: Record<string, unknown>;
  properties?: Record<string, unknown>;
}

// Its own workspace: list_fields assertions elsewhere read the whole of u1's.
test("typed templates over MCP: list_templates shows type and defaults; create_from_template returns the committed values", async () => {
  const ws = await new WorkspaceService(db, SYSTEM).provisionForUser("u1", { name: "Series", slug: "u1-series" });
  const col = payload(
    await client.callTool({
      name: "create_collection",
      arguments: { workspaceId: ws.id, name: "Series", slug: "series" },
    }),
  );
  const sync = await services.types.createType(ws.id, "Sync");
  const define = (key: string, kind: "date" | "doc_list" | "select", options?: string[]) =>
    services.types.createField({ workspaceId: ws.id, typeId: sync.id, key, kind, options });
  const date = await define("date", "date");
  const attendees = await define("attendees", "doc_list");
  const status = await define("status", "select", ["Planned", "Done"]);
  const tpl = payload(
    await client.callTool({ name: "create_document", arguments: { collectionId: col.id, title: "Sync {{date}}" } }),
  );
  await services.templates.templatize(tpl.id, "Sync");
  await services.templates.setDefaultType(tpl.id, sync.id);
  await services.templates.setFieldDefault(tpl.id, date.id, { kind: "today" });
  await services.templates.setFieldDefault(tpl.id, attendees.id, { kind: "from_previous_sibling" });
  await services.templates.setFieldDefault(tpl.id, status.id, { kind: "value", value: "Planned" });

  const listed: TypedPage[] = payload(
    await client.callTool({ name: "list_templates", arguments: { workspaceId: ws.id } }),
  );
  const meeting = listed.find((t) => t.name === "Sync")!;
  assert.deepEqual([meeting.type, meeting.defaults], [
    { id: sync.id, name: "Sync" },
    { date: "today", attendees: "from_previous_sibling", status: { value: "Planned" } },
  ]);

  const create = async (args: Record<string, unknown>): Promise<TypedPage> =>
    payload(await client.callTool({ name: "create_from_template", arguments: { collectionId: col.id, ...args } }))
      .document;
  const ann = payload(
    await client.callTool({ name: "create_document", arguments: { collectionId: col.id, title: "Ann" } }),
  );
  const series = payload(
    await client.callTool({ name: "create_document", arguments: { collectionId: col.id, title: "Weekly sync" } }),
  );

  const first = await create({ templateId: meeting.id, parentId: series.id, variables: { date: "2026-03-02" } });
  assert.deepEqual(first.properties, { date: "2026-03-02", status: "Planned" });
  await client.callTool({ name: "set_properties", arguments: { id: first.id, set: { attendees: [ann.id] } } });

  const second = await create({ templateId: meeting.id, parentId: series.id, variables: { date: "2026-03-09" } });
  assert.deepEqual(second.type, { id: sync.id, name: "Sync" });
  assert.deepEqual(second.properties, {
    date: "2026-03-09",
    attendees: [{ id: ann.id, title: "Ann", url: `http://app.test/d/${ann.id}` }],
    status: "Planned",
  });
  assert.deepEqual(
    payload(await client.callTool({ name: "get_document", arguments: { id: second.id } })).properties,
    second.properties,
    "what create returns is what a read of the page returns",
  );

  const doc = new Y.Doc();
  Y.applyUpdate(doc, (await services.documents.get(second.id))!.ydocState!);
  const authors = getAuthors(doc);
  assert.deepEqual(
    [...new Set(propertyBlame(doc).map((b) => `${authors.get(b.clientId)?.userId} ai=${authors.get(b.clientId)?.ai}`))],
    ["u1 ai=true"],
    "the values are the creating agent's writing",
  );
});

test("open_tasks over MCP: by page, subtree and previous meeting, with the agent as author", async () => {
  const ws = await new WorkspaceService(db, SYSTEM).provisionForUser("u1", { name: "Tasks", slug: "u1-tasks" });
  const col = payload(
    await client.callTool({ name: "create_collection", arguments: { workspaceId: ws.id, name: "Tasks", slug: "tasks-p7" } }),
  );
  const standup = await services.types.createType(ws.id, "Standup");
  await services.types.createField({ workspaceId: ws.id, typeId: standup.id, key: "day", kind: "date" });
  const create = async (args: Record<string, unknown>) =>
    payload(await client.callTool({ name: "create_document", arguments: { collectionId: col.id, ...args } }));
  const series = await create({ title: "Standups", markdown: "- [ ] pick a room" });
  const monday = await create({
    title: "Monday",
    parentDocumentId: series.id,
    markdown: "- [ ] @alice fix the build\n- [x] ship it",
    type: "Standup",
    properties: { day: "2026-10-19" },
  });
  const tuesday = await create({
    title: "Tuesday",
    parentDocumentId: series.id,
    markdown: "- [ ] demo",
    type: "Standup",
    properties: { day: "2026-10-20" },
  });
  const open = async (args: Record<string, unknown>) =>
    payload(await client.callTool({ name: "open_tasks", arguments: args })).map(
      (t: { documentTitle: string; text: string; createdBy: string; ai: boolean; url: string }) => [
        t.documentTitle,
        t.text,
        t.createdBy,
        t.ai,
        t.url,
      ],
    );
  const fixTheBuild = ["Monday", "@alice fix the build", "u1", true, `http://app.test/d/${monday.id}`];

  assert.deepEqual(await open({ previousSiblingOf: tuesday.id }), [fixTheBuild]);
  assert.deepEqual(await open({ documentId: monday.id }), [fixTheBuild]);
  assert.deepEqual(
    (await open({ subtreeOf: series.id })).map((t: string[]) => t[1]).sort(),
    ["@alice fix the build", "demo", "pick a room"],
  );
  assert.equal(
    errorText(await client.callTool({ name: "open_tasks", arguments: { documentId: monday.id, subtreeOf: series.id } })),
    "give exactly one of documentId, subtreeOf or previousSiblingOf",
  );
  assert.equal(
    errorText(await client.callTool({ name: "open_tasks", arguments: { previousSiblingOf: randomUUID() } })),
    "document not found",
  );
});

test("list_backlinks over MCP: says whether the page links in its body or holds the target in a property", async () => {
  const ws = await new WorkspaceService(db, SYSTEM).provisionForUser("u1", { name: "People", slug: "u1-people" });
  const col = payload(
    await client.callTool({ name: "create_collection", arguments: { workspaceId: ws.id, name: "People", slug: "people-14" } }),
  );
  const meeting = await services.types.createType(ws.id, "Meeting");
  await services.types.createField({
    workspaceId: ws.id,
    typeId: meeting.id,
    key: "attendees",
    label: "Attendees",
    kind: "doc_list",
  });
  const create = async (args: Record<string, unknown>) =>
    payload(await client.callTool({ name: "create_document", arguments: { collectionId: col.id, ...args } }));
  const andrea = await create({ title: "Andrea" });
  const sync = await create({ title: "Sync", type: "Meeting", properties: { attendees: [andrea.id] } });
  const kickoff = await create({
    title: "Kickoff",
    markdown: `Ask [Andrea](/d/${andrea.id}).`,
    type: "Meeting",
    properties: { attendees: [andrea.id] },
  });
  const backlinks = payload(await client.callTool({ name: "list_backlinks", arguments: { id: andrea.id } }));
  const attendee = { kind: "property", field: "attendees", label: "Attendees" };
  assert.deepEqual(
    backlinks
      .map((b: { title: string; url: string; via: unknown[] }) => [b.title, b.url, b.via])
      .sort(([a]: string[], [b]: string[]) => a!.localeCompare(b!)),
    [
      ["Kickoff", `http://app.test/d/${kickoff.id}`, [{ kind: "body" }, attendee]],
      ["Sync", `http://app.test/d/${sync.id}`, [attendee]],
    ],
  );
});
