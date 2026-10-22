import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import {
  createDatabase,
  documents,
  documents as documentsTable,
  documentTypes,
  documentSnapshots,
  migrateDatabase,
  runAsActor,
  SYSTEM,
  user as userTable,
  workspaceMembers,
  type Actor,
  type TypeField,
} from "@tandem/db";
import { eq, sql } from "drizzle-orm";
import { scanTaskItems } from "@tandem/editor";
import { InvalidInputError, NotFoundError } from "./errors.js";
import { CollectionService } from "./services/collections.js";
import { CommentService } from "./services/comments.js";
import { NotificationService } from "./services/notifications.js";
import { DocumentQueryService } from "./services/document-queries.js";
import { DocumentTreeService } from "./services/document-tree.js";
import { DocumentService, normalizeTags } from "./services/documents.js";
import { FavoriteService } from "./services/favorites.js";
import { GroupService } from "./services/groups.js";
import { SnapshotService } from "./services/snapshots.js";
import { expandVariables, TemplateService } from "./services/templates.js";
import { projectProperties, TypeService, type FieldDef } from "./services/types.js";
import { WorkspaceService } from "./services/workspaces.js";
import { normalizeMarkdown } from "./markdown.js";

const db = createDatabase("memory://");
const user = (userId: string): Actor => ({ kind: "user", userId });

before(async () => {
  await migrateDatabase(db);
  // Provision a workspace per user (what the signup hook does).
  await new WorkspaceService(db, SYSTEM).provisionForUser("u1", { name: "U1", slug: "u1" });
  await new WorkspaceService(db, SYSTEM).provisionForUser("u2", { name: "U2", slug: "u2" });
});

after(async () => {
  await db.$dispose();
});

test("markdown round-trips through the document model", () => {
  const normalized = normalizeMarkdown("# Title\n\nSome **bold** and a list:\n\n* one\n* two");
  assert.match(normalized, /# Title/);
  assert.match(normalized, /\*\*bold\*\*/);
  assert.match(normalized, /\* one/);
});

test("workspace-scoped CRUD, tree, and search (user actor under RLS)", async () => {
  const collections = new CollectionService(db, user("u1"));
  const documents = new DocumentService(db, user("u1"));
  const documentTree = new DocumentTreeService(db, user("u1"));
  const documentQueries = new DocumentQueryService(db, user("u1"));

  const col = await collections.create({ name: "Handbook", slug: "handbook" });
  assert.ok(col.workspaceId, "collection got a workspace");

  const parent = await documents.create({
    collectionId: col.id,
    title: "Onboarding",
    markdown: "# Onboarding\n\nWelcome to the team.",
  });
  const child = await documents.create({
    collectionId: col.id,
    parentDocumentId: parent.id,
    title: "Laptop setup",
    markdown: "Install **pnpm** and clone the monorepo.",
  });
  assert.equal(parent.workspaceId, col.workspaceId, "doc inherits workspace");
  assert.equal(
    await documents.hasAnyInWorkspace(col.workspaceId),
    true,
    "first-run UI can detect an existing readable document cheaply",
  );
  assert.equal(
    await new DocumentService(db, user("u2")).hasAnyInWorkspace(col.workspaceId),
    false,
    "existence check remains RLS-scoped",
  );

  const tree = await documentTree.tree(col.id);
  assert.equal(tree[0]!.children[0]!.id, child.id);
  const shallowTree = await documentTree.tree(col.id, 1);
  assert.equal(shallowTree[0]!.id, parent.id);
  assert.deepEqual(shallowTree[0]!.children, [], "bounded tree reads omit deeper levels");

  const recent = await documentQueries.recent({ collectionId: col.id, limit: 2 });
  assert.deepEqual(new Set(recent.map((doc) => doc.id)), new Set([parent.id, child.id]));
  assert.equal(
    (await new DocumentQueryService(db, user("u2")).recent({ collectionId: col.id })).length,
    0,
    "recent documents remain RLS-scoped",
  );
  assert.equal(
    (await documentQueries.recent({
      collectionId: col.id,
      updatedAfter: new Date(Date.now() + 60_000),
    })).length,
    0,
  );

  const hits = await documentQueries.search("pnpm monorepo", { collectionId: col.id });
  assert.ok(hits.some((h) => h.id === child.id));

  // Prefix search: a partial word must match the TITLE too ("Onboard[ing]").
  const titleHits = await documentQueries.search("onboard");
  assert.ok(titleHits.some((h) => h.id === parent.id), "title prefix matches");
  assert.equal((await documentQueries.search("   ")).length, 0, "blank query is empty");

  // Bounded subtree navigation: one document's descendants, with the titles
  // leading to it so callers can print collection-relative paths.
  const grandchild = await documents.create({
    collectionId: col.id,
    parentDocumentId: child.id,
    title: "Dotfiles",
  });
  const sub = await documentTree.subtree(child.id, 1);
  assert.equal(sub.root.id, child.id);
  assert.deepEqual(sub.ancestry, ["Onboarding", "Laptop setup"]);
  assert.deepEqual(sub.nodes.map((n) => n.id), [grandchild.id]);
  assert.deepEqual(sub.nodes[0]!.children, [], "depth counts from the root");
  const deeper = await documentTree.subtree(parent.id, 2);
  assert.equal(deeper.nodes[0]!.children[0]!.id, grandchild.id);
  await assert.rejects(documentTree.subtree(randomUUID(), 1), NotFoundError);
  await assert.rejects(
    new DocumentTreeService(db, user("u2")).subtree(child.id, 1),
    NotFoundError,
    "subtree roots are RLS-scoped",
  );
});

test("search retrieves partial terms, ranks precise matches, and tolerates title typos", async () => {
  const collections = new CollectionService(db, user("u1"));
  const documents = new DocumentService(db, user("u1"));
  const documentQueries = new DocumentQueryService(db, user("u1"));
  const col = await collections.create({ name: "Search Quality", slug: "search-quality" });
  const parent = await documents.create({ collectionId: col.id, title: "Planning" });
  const partial = await documents.create({
    collectionId: col.id,
    parentDocumentId: parent.id,
    title: "Research Proposal",
    markdown: "A proposal describing the upcoming programme of work.",
  });
  const precise = await documents.create({
    collectionId: col.id,
    title: "Research Agenda",
    markdown: "The research agenda for the coming year.",
  });

  const broad = await documentQueries.search("research agenda", { collectionId: col.id });
  assert.equal(broad[0]!.id, precise.id, "title phrase outranks a partial-term result");
  const partialHit = broad.find((hit) => hit.id === partial.id);
  assert.ok(partialHit, "a one-of-two token match is still retrieved");
  assert.deepEqual(partialHit.matchedTerms, ["research"]);
  assert.deepEqual(partialHit.fuzzyTitleTerms, []);
  assert.equal(partialHit.totalTerms, 2);
  assert.equal(partialHit.matchKind, "partial_terms");
  assert.equal(partialHit.collectionName, "Search Quality");
  assert.equal(partialHit.path, "Search Quality / Planning / Research Proposal");

  const fuzzy = await documentQueries.search("reseach proposl", { collectionId: col.id });
  const fuzzyHit = fuzzy.find((hit) => hit.id === partial.id);
  assert.ok(fuzzyHit, "misspelled title terms are recovered through pg_trgm");
  assert.equal(fuzzyHit.matchKind, "fuzzy_title");
  assert.deepEqual(new Set(fuzzyHit.fuzzyTitleTerms), new Set(["reseach", "proposl"]));

  const deduped = await documentQueries.search("research research", { collectionId: col.id });
  assert.equal(deduped[0]!.totalTerms, 1, "repeated query terms count once");
});

test("normalizeTags trims, collapses, dedupes case-insensitively, and caps", () => {
  assert.deepEqual(normalizeTags(["  Alpha ", "alpha", "", "  ", "be   ta"]), ["Alpha", "be ta"]);
  assert.equal(normalizeTags(Array.from({ length: 30 }, (_v, i) => `t${i}`)).length, 20);
  assert.equal(normalizeTags(["x".repeat(80)])[0]!.length, 50);
});

test("tags: create/update, RLS-scoped listing, tag search and browse", async () => {
  const collections = new CollectionService(db, user("u1"));
  const documents = new DocumentService(db, user("u1"));
  const documentQueries = new DocumentQueryService(db, user("u1"));
  const col = await collections.create({ name: "Papers", slug: "papers" });

  const draft = await documents.create({
    collectionId: col.id,
    title: "Diffusion draft",
    markdown: "Notes on sampling.",
    tags: ["ml", "ML", " Draft "], // dedupe + trim happen in the service
  });
  assert.deepEqual(draft.tags, ["ml", "Draft"], "tags normalized on create");

  const meta = await documents.getMeta(draft.id);
  assert.deepEqual(meta!.tags, ["ml", "Draft"], "getMeta returns tags");

  // Update replaces the set.
  const other = await documents.create({ collectionId: col.id, title: "Transformer notes", tags: ["ml"] });
  await documents.update(draft.id, { tags: ["ml", "published"] });

  const tags = await documentQueries.listTags();
  assert.deepEqual(
    tags,
    [
      { tag: "ml", count: 2 },
      { tag: "published", count: 1 },
    ],
    "distinct, sorted, current tags with document counts",
  );

  // Tag filter + text.
  const mlHits = await documentQueries.search("", { tag: "ml" });
  assert.deepEqual(new Set(mlHits.map((h) => h.id)), new Set([draft.id, other.id]), "tag browse lists both");
  const combined = await documentQueries.search("transformer", { tag: "ml" });
  assert.deepEqual(combined.map((h) => h.id), [other.id], "text + tag narrows");
  assert.equal((await documentQueries.search("", { tag: "nope" })).length, 0, "unknown tag is empty");

  // Exclusions compose with the rest: by id and by tag, in browse and ranked search.
  const withoutDraft = await documentQueries.search("", { tag: "ml", excludeIds: [draft.id] });
  assert.deepEqual(withoutDraft.map((h) => h.id), [other.id], "excludeIds drops a browse hit");
  const unpublished = await documentQueries.search("notes", {
    collectionId: col.id,
    excludeTags: ["published"],
  });
  assert.deepEqual(unpublished.map((h) => h.id), [other.id], "excludeTags drops a ranked hit");

  // RLS: u2 sees none of u1's tags.
  const d2Queries = new DocumentQueryService(db, user("u2"));
  assert.equal((await d2Queries.listTags()).length, 0, "u2 cannot see u1's tags");
  assert.equal((await d2Queries.search("", { tag: "ml" })).length, 0, "u2 tag search is empty");
});

test("tenant isolation: a user cannot see or write another workspace's data", async () => {
  // u1 creates content.
  const c1 = new CollectionService(db, user("u1"));
  const d1 = new DocumentService(db, user("u1"));
  const col = await c1.create({ name: "Secret", slug: "secret" });
  const doc = await d1.create({ collectionId: col.id, title: "Private", markdown: "top secret" });

  // u2 sees none of it.
  const c2 = new CollectionService(db, user("u2"));
  const d2 = new DocumentService(db, user("u2"));
  const d2Queries = new DocumentQueryService(db, user("u2"));
  assert.ok(
    !(await c2.list()).some((c) => c.id === col.id),
    "u2 collection list excludes u1's collection",
  );
  assert.equal(await d2.get(doc.id), null, "u2 cannot fetch u1's document");
  assert.equal((await d2Queries.search("secret")).length, 0, "u2 search finds nothing of u1's");

  // u2 cannot create a document inside u1's collection (collection invisible).
  await assert.rejects(
    () => d2.create({ collectionId: col.id, title: "intrusion", markdown: "x" }),
    /collection not found/,
  );

  // u1 still sees their own.
  assert.ok((await c1.list()).some((c) => c.id === col.id));
  assert.ok(await d1.get(doc.id));
});

test("invite: a user who accepts an invite gains access to that workspace", async () => {
  const w1 = new WorkspaceService(db, user("u1"));
  const w2 = new WorkspaceService(db, user("u2"));
  const c1 = new CollectionService(db, user("u1"));

  const [ws] = await w1.listMine();
  const col = await c1.create({ name: "Shared", slug: "shared-team" });

  // Before accepting, u2 can't see it.
  assert.ok(!(await new CollectionService(db, user("u2")).list()).some((c) => c.id === col.id));

  // u1 (owner) invites; u2 accepts.
  const invite = await w1.createInvite({ workspaceId: ws!.id });
  await w2.acceptInvite(invite.token);

  // Now u2 is a member and sees the workspace's collection.
  assert.ok((await w2.listMine()).some((w) => w.id === ws!.id), "u2 joined the workspace");
  assert.ok(
    (await new CollectionService(db, user("u2")).list()).some((c) => c.id === col.id),
    "u2 now sees the shared collection",
  );

  // A non-owner cannot create invites.
  await assert.rejects(
    () => w2.createInvite({ workspaceId: ws!.id }),
    /owner or admin/,
  );
});

test("restore undoes exactly one archive; separately archived children stay archived", async () => {
  const c1 = new CollectionService(db, user("u1"));
  const d1 = new DocumentService(db, user("u1"));
  const d1Tree = new DocumentTreeService(db, user("u1"));
  const col = await c1.create({ name: "Arc", slug: "archive-undo" });
  const root = await d1.create({ collectionId: col.id, title: "root" });
  const kept = await d1.create({ collectionId: col.id, parentDocumentId: root.id, title: "kept" });
  const earlier = await d1.create({ collectionId: col.id, parentDocumentId: root.id, title: "old" });

  await d1Tree.archive(earlier.id);
  await d1Tree.archive(root.id);
  await d1Tree.restore(root.id);

  const state = async (id: string) =>
    (await db.select({ a: documents.archivedAt }).from(documents).where(eq(documents.id, id)))[0]!.a;
  assert.equal(await state(root.id), null);
  assert.equal(await state(kept.id), null);
  assert.ok(await state(earlier.id), "child archived on its own stays archived");
});

test("trash: delete is exactly undoable and restore never hides under a dead parent", async () => {
  const c1 = new CollectionService(db, user("u1"));
  const t1 = new DocumentTreeService(db, user("u1"));
  const d1 = new DocumentService(db, user("u1"));
  const col = await c1.create({ name: "Trash", slug: "trash-restore" });
  const root = await d1.create({ collectionId: col.id, title: "root" });
  const kept = await d1.create({ collectionId: col.id, parentDocumentId: root.id, title: "kept" });
  const earlier = await d1.create({ collectionId: col.id, parentDocumentId: root.id, title: "old" });
  const deletedAt = async (id: string) =>
    (await db.select({ d: documents.deletedAt }).from(documents).where(eq(documents.id, id)))[0]!.d;

  await t1.softDelete(earlier.id);
  await t1.softDelete(root.id);
  assert.deepEqual(
    (await t1.listTrash(col.id)).map((d) => d.title).sort(),
    ["old", "root"],
    "both batches are trash roots; the child deleted with root is not",
  );

  await t1.restoreFromTrash(root.id);
  assert.equal(await deletedAt(root.id), null);
  assert.equal(await deletedAt(kept.id), null);
  assert.ok(await deletedAt(earlier.id), "separately trashed child stays in the trash");

  // Its parent went to the trash on its own: restoring the child lands at root.
  await t1.softDelete(root.id);
  await t1.restoreFromTrash(earlier.id);
  const [row] = await db.select().from(documents).where(eq(documents.id, earlier.id));
  assert.equal(row!.deletedAt, null);
  assert.equal(row!.parentDocumentId, null, "reattached to the collection root");
});

test("trash: purge removes only its batch, and readers can't purge or restore", async () => {
  const c1 = new CollectionService(db, user("u1"));
  const t1 = new DocumentTreeService(db, user("u1"));
  const d1 = new DocumentService(db, user("u1"));
  const col = await c1.create({ name: "Purge", slug: "trash-purge" });
  const parent = await d1.create({ collectionId: col.id, title: "parent" });
  const child = await d1.create({ collectionId: col.id, parentDocumentId: parent.id, title: "c" });
  const survivor = await d1.create({ collectionId: col.id, parentDocumentId: parent.id, title: "s" });
  await t1.softDelete(parent.id);
  // The survivor is restored on its own; its row still points at the parent.
  await db.update(documents).set({ deletedAt: null }).where(eq(documents.id, survivor.id));

  const reader = new DocumentTreeService(db, user("u2"));
  await c1.setDefaultRole(col.id, "read");
  await db
    .insert(workspaceMembers)
    .values({ workspaceId: col.workspaceId, userId: "u2", role: "member" })
    .onConflictDoNothing();
  assert.equal((await reader.listTrash(col.id)).length, 1, "reader sees the trash");
  assert.equal(await reader.purge(parent.id), false, "reader cannot purge");
  assert.equal(await reader.restoreFromTrash(parent.id), null, "reader cannot restore");

  assert.equal(await t1.purge(parent.id), true);
  const ids = (await db.select({ id: documents.id }).from(documents)).map((r) => r.id);
  assert.ok(!ids.includes(parent.id) && !ids.includes(child.id), "batch gone");
  const [kept] = await db.select().from(documents).where(eq(documents.id, survivor.id));
  assert.ok(kept, "a child outside the batch survives the cascade");
  assert.equal(kept!.parentDocumentId, null);
  assert.equal(await t1.purge(survivor.id), false, "only trash roots can be purged");
});

test("trash: purgeExpired removes batches past retention only", async () => {
  const c1 = new CollectionService(db, user("u1"));
  const t1 = new DocumentTreeService(db, user("u1"));
  const d1 = new DocumentService(db, user("u1"));
  const col = await c1.create({ name: "Expire", slug: "trash-expire" });
  const old = await d1.create({ collectionId: col.id, title: "old" });
  const fresh = await d1.create({ collectionId: col.id, title: "fresh" });
  await t1.softDelete(old.id);
  await t1.softDelete(fresh.id);
  await db
    .update(documents)
    .set({ deletedAt: new Date(Date.now() - 40 * 86_400_000) })
    .where(eq(documents.id, old.id));

  assert.equal(await new DocumentTreeService(db, SYSTEM).purgeExpired(30), 1);
  const ids = (await db.select({ id: documents.id }).from(documents)).map((r) => r.id);
  assert.ok(!ids.includes(old.id));
  assert.ok(ids.includes(fresh.id));
});

test("accepting an invalid invite is an input error, not a crash", async () => {
  const ws = new WorkspaceService(db, user("u2"));
  await assert.rejects(() => ws.acceptInvite("no-such-token"), InvalidInputError);
});

test("getMetaMany returns only live documents the actor can read", async () => {
  const c1 = new CollectionService(db, user("u1"));
  const d1 = new DocumentService(db, user("u1"));
  const t1 = new DocumentTreeService(db, user("u1"));
  const col = await c1.create({ name: "Recents", slug: "meta-many" });
  const live = await d1.create({ collectionId: col.id, title: "live" });
  const archived = await d1.create({ collectionId: col.id, title: "archived" });
  const trashed = await d1.create({ collectionId: col.id, title: "trashed" });
  await t1.archive(archived.id);
  await t1.softDelete(trashed.id);
  const ids = [live.id, archived.id, trashed.id, randomUUID()];

  assert.deepEqual((await d1.getMetaMany(ids)).map((d) => d.title), ["live"]);
  assert.deepEqual(await d1.getMetaMany([]), []);
  // Someone outside the workspace sees none of them (u2 joins u1's workspace
  // in the trash tests, so use a user with no memberships at all).
  assert.deepEqual(await new DocumentService(db, user("outsider")).getMetaMany(ids), []);
});

test("tree queries terminate even if a parent cycle exists", { timeout: 10_000 }, async () => {
  // move() serializes per collection so this can't be produced through the
  // API; the CTEs must still not hang if it ever exists in the data.
  const c1 = new CollectionService(db, user("u1"));
  const d1 = new DocumentService(db, user("u1"));
  const d1Tree = new DocumentTreeService(db, user("u1"));
  const col = await c1.create({ name: "Cyc", slug: "cycle" });
  const a = await d1.create({ collectionId: col.id, title: "a" });
  const b = await d1.create({ collectionId: col.id, parentDocumentId: a.id, title: "b" });
  const c = await d1.create({ collectionId: col.id, title: "c" });
  await db.update(documents).set({ parentDocumentId: b.id }).where(eq(documents.id, a.id));

  await assert.rejects(() => d1Tree.move(c.id, { parentDocumentId: b.id }).then(() =>
    d1Tree.move(a.id, { parentDocumentId: c.id }),
  ), /own descendant/);
  await d1Tree.subtree(c.id, 3);
  assert.ok(await d1Tree.archive(a.id));
});

test("move rejects a cross-collection or self parent", async () => {
  const c1 = new CollectionService(db, user("u1"));
  const d1 = new DocumentService(db, user("u1"));
  const d1Tree = new DocumentTreeService(db, user("u1"));
  const colA = await c1.create({ name: "A", slug: "move-a" });
  const colB = await c1.create({ name: "B", slug: "move-b" });
  const a1 = await d1.create({ collectionId: colA.id, title: "a1" });
  const a2 = await d1.create({ collectionId: colA.id, title: "a2" });
  const b1 = await d1.create({ collectionId: colB.id, title: "b1" });

  await assert.rejects(
    () => d1Tree.move(a1.id, { parentDocumentId: b1.id }),
    /same collection/,
    "cross-collection parent rejected",
  );
  await assert.rejects(
    () => d1Tree.move(a1.id, { parentDocumentId: a1.id }),
    /own parent/,
    "self-parent rejected",
  );
  // Same-collection move is allowed.
  const moved = await d1Tree.move(a1.id, { parentDocumentId: a2.id });
  assert.equal(moved!.parentDocumentId, a2.id);

  // Moving a document into its own descendant would create a cycle.
  const a3 = await d1.create({ collectionId: colA.id, parentDocumentId: a1.id, title: "a3" });
  await assert.rejects(
    () => d1Tree.move(a1.id, { parentDocumentId: a3.id }),
    /own descendant/,
    "indirect cycle rejected",
  );
});

test("invite role can't exceed the inviter's: an admin cannot grant owner", async () => {
  const w1 = new WorkspaceService(db, user("u1")); // u1 is owner of its workspace
  const [ws] = await w1.listMine();

  // u1 (owner) invites u3 as admin; u3 accepts.
  const adminInvite = await w1.createInvite({ workspaceId: ws!.id, role: "admin" });
  await new WorkspaceService(db, user("u3")).acceptInvite(adminInvite.token);
  const w3 = new WorkspaceService(db, user("u3"));

  // The admin can invite members/admins...
  assert.ok(await w3.createInvite({ workspaceId: ws!.id, role: "member" }));
  // ...but not owners.
  await assert.rejects(
    () => w3.createInvite({ workspaceId: ws!.id, role: "owner" }),
    /only an owner can grant the owner role/,
  );
});

test("per-collection ACLs: default none, explicit read, read_write, and groups", async () => {
  // u2 is a regular member of u1's workspace (joined via the invite test above).
  const c1 = new CollectionService(db, user("u1"));
  const c2 = new CollectionService(db, user("u2"));
  const d2 = new DocumentService(db, user("u2"));

  const col = await c1.create({ name: "Restricted", slug: "restricted" });
  await c1.setDefaultRole(col.id, "none");

  // No access: u2 (member, not owner/admin) can't see a default-none collection.
  assert.ok(!(await c2.list()).some((c) => c.id === col.id), "hidden at default none");
  await assert.rejects(() => d2.create({ collectionId: col.id, title: "x" }), /not found/);

  // Explicit read: visible but not writable.
  await c1.grant(col.id, "user", "u2", "read");
  const seen = (await c2.list()).find((c) => c.id === col.id);
  assert.ok(seen, "u2 can see it with read grant");
  assert.equal(seen!.writable, false, "read grant is not writable");
  await assert.rejects(() => d2.create({ collectionId: col.id, title: "x" }), "read-only blocks create");

  // Upgrade to read_write: now writable.
  await c1.grant(col.id, "user", "u2", "read_write");
  assert.equal((await c2.list()).find((c) => c.id === col.id)!.writable, true);
  assert.ok(await d2.create({ collectionId: col.id, title: "ok" }), "read_write allows create");

  // Group grant: a separate collection shared with a group u2 belongs to.
  const [ws] = await new WorkspaceService(db, user("u1")).listMine();
  const grouped = await c1.create({ name: "Grouped", slug: "grouped" });
  await c1.setDefaultRole(grouped.id, "none");
  const groups = new GroupService(db, user("u1"));
  const g = await groups.create(ws!.id, "Editors");
  await groups.addMember(g.id, "u2");
  await c1.grant(grouped.id, "group", g.id, "read_write");
  assert.equal((await c2.list()).find((c) => c.id === grouped.id)?.writable, true, "group grant propagates");
});

test("archive and restore apply to the whole subtree; archived docs leave tree and search", async () => {
  const c1 = new CollectionService(db, user("u1"));
  const d1 = new DocumentService(db, user("u1"));
  const d1Tree = new DocumentTreeService(db, user("u1"));
  const d1Queries = new DocumentQueryService(db, user("u1"));
  const col = await c1.create({ name: "Lifecycle", slug: "lifecycle" });
  const parent = await d1.create({ collectionId: col.id, title: "P", markdown: "parent zebra" });
  const child = await d1.create({
    collectionId: col.id,
    parentDocumentId: parent.id,
    title: "C",
    markdown: "child zebra",
  });

  const archived = await d1Tree.archive(parent.id);
  assert.ok(archived?.archivedAt, "parent archived");
  assert.equal((await d1Tree.tree(col.id)).length, 0, "subtree gone from tree");
  assert.equal((await d1Queries.search("zebra")).length, 0, "archived docs not searchable");
  await assert.rejects(d1Tree.subtree(parent.id, 1), NotFoundError, "archived roots have no subtree");
  // An archived document takes no new children: they would drop out of the
  // tree (orphans are not promoted) while staying active and searchable.
  await assert.rejects(
    d1.create({ collectionId: col.id, parentDocumentId: parent.id, title: "Late child" }),
    InvalidInputError,
    "cannot create under an archived parent",
  );
  const loose = await d1.create({ collectionId: col.id, title: "Loose" });
  await assert.rejects(
    d1Tree.move(loose.id, { parentDocumentId: parent.id }),
    InvalidInputError,
    "cannot move under an archived parent",
  );
  const archivedList = await d1Tree.listArchived(col.id);
  assert.deepEqual(archivedList.map((d) => d.id), [parent.id], "only the subtree root is listed");

  const restored = await d1Tree.restore(parent.id);
  assert.equal(restored!.archivedAt, null);
  const tree = await d1Tree.tree(col.id);
  assert.deepEqual(new Set(tree.map((d) => d.id)), new Set([parent.id, loose.id]));
  const restoredParent = tree.find((d) => d.id === parent.id)!;
  assert.equal(restoredParent.children[0]!.id, child.id, "child restored with parent");
});

test("recent keyset cursor does not skip documents sharing one timestamp", async () => {
  const collections = new CollectionService(db, user("u1"));
  const documents = new DocumentService(db, user("u1"));
  const documentQueries = new DocumentQueryService(db, user("u1"));
  const col = await collections.create({ name: "Bulk import", slug: "bulk-import" });
  const a = await documents.create({ collectionId: col.id, title: "Imported A" });
  const b = await documents.create({ collectionId: col.id, title: "Imported B" });
  // One transaction's now() stamps a whole import with the same instant — at
  // microsecond precision, which a JS Date cursor could never reproduce.
  await db.execute(
    sql`UPDATE documents SET updated_at = '2026-01-01T00:00:00.123456Z' WHERE id IN (${a.id}, ${b.id})`,
  );

  const first = await documentQueries.recent({ collectionId: col.id, limit: 1 });
  assert.equal(first.length, 1);
  const second = await documentQueries.recent({
    collectionId: col.id,
    limit: 1,
    before: { updatedAt: first[0]!.updatedAt, id: first[0]!.id },
  });
  assert.equal(second.length, 1, "the row sharing the cursor's timestamp is on the next page");
  assert.notEqual(second[0]!.id, first[0]!.id);
  assert.equal(second[0]!.updatedAt.getTime(), first[0]!.updatedAt.getTime());
});

test("softDelete removes the whole subtree", async () => {
  const c1 = new CollectionService(db, user("u1"));
  const d1 = new DocumentService(db, user("u1"));
  const d1Tree = new DocumentTreeService(db, user("u1"));
  const col = await c1.create({ name: "Del", slug: "del" });
  const parent = await d1.create({ collectionId: col.id, title: "P" });
  const child = await d1.create({ collectionId: col.id, parentDocumentId: parent.id, title: "C" });

  assert.equal(await d1Tree.softDelete(parent.id), true);
  assert.equal(await d1.get(parent.id), null);
  assert.equal(await d1.get(child.id), null, "child deleted with parent");
  assert.equal((await d1Tree.tree(col.id)).length, 0);
});

test("a read-only member cannot archive or delete", async () => {
  const c1 = new CollectionService(db, user("u1"));
  const d1 = new DocumentService(db, user("u1"));
  const d2 = new DocumentService(db, user("u2")); // u2 is a plain member (joined earlier)
  const d2Tree = new DocumentTreeService(db, user("u2"));
  const col = await c1.create({ name: "RO", slug: "ro" });
  await c1.setDefaultRole(col.id, "read");
  const doc = await d1.create({ collectionId: col.id, title: "Guarded" });

  assert.ok(await d2.get(doc.id), "u2 can read it");
  assert.equal(await d2Tree.archive(doc.id), null, "archive denied");
  assert.equal(await d2Tree.softDelete(doc.id), false, "delete denied");
  assert.ok(await d1.get(doc.id), "doc still there");
});

test("listMyTodos: assigned tasks across visible docs, tenant-scoped", async () => {
  const { user: authUser } = await import("@tandem/db");
  await db
    .insert(authUser)
    .values([
      { id: "u1", name: "Alice", email: "alice@example.com", updatedAt: new Date() },
      { id: "u2", name: "Bob", email: "bob@other.org", updatedAt: new Date() },
    ])
    .onConflictDoNothing();

  const c1 = new CollectionService(db, user("u1"));
  const d1 = new DocumentService(db, user("u1"));
  const d1Tree = new DocumentTreeService(db, user("u1"));
  const col = await c1.create({ name: "Tasks", slug: "tasks" });
  await c1.setDefaultRole(col.id, "none"); // u1-only

  const doc = await d1.create({
    collectionId: col.id,
    title: "Sprint",
    markdown: [
      "# Sprint",
      "",
      "- [ ] @alice write the intro",
      "- [x] @alice@example.com file the report",
      "- [ ] @bob not alice's task",
      "- [ ] unassigned chore",
    ].join("\n"),
  });

  const todos = await new DocumentQueryService(db, user("u1")).listMyTodos();
  const mine = todos.filter((t) => t.documentId === doc.id);
  assert.equal(mine.length, 2, "local-part and full-email mentions match");
  assert.deepEqual(
    mine.map((t) => t.done).sort(),
    [false, true],
  );
  assert.equal(mine[0]!.documentTitle, "Sprint");

  // u2 can't see u1's private collection, so no leakage through todos.
  const bobTodos = await new DocumentQueryService(db, user("u2")).listMyTodos();
  assert.ok(!bobTodos.some((t) => t.documentId === doc.id), "RLS scopes the todo scan");

  // Archived docs drop out of the todo list.
  await d1Tree.archive(doc.id);
  const after = await new DocumentQueryService(db, user("u1")).listMyTodos();
  assert.ok(!after.some((t) => t.documentId === doc.id));
});

test("listMyTodos reads assignees extracted at save time; pre-migration rows still scan", async () => {
  const c1 = new CollectionService(db, user("u1"));
  const d1 = new DocumentService(db, user("u1"));
  const d1Queries = new DocumentQueryService(db, user("u1"));
  const col = await c1.create({ name: "Todo index", slug: "todo-index" });
  const md = "- [ ] @alice indexed task\n- [ ] @Bob@Other.org other";
  const indexed = await d1.create({ collectionId: col.id, title: "Indexed", markdown: md });
  assert.deepEqual(indexed.taskAssignees?.sort(), ["alice", "bob@other.org"]);

  const legacy = await d1.create({ collectionId: col.id, title: "Legacy", markdown: md });
  // Written before task_assignees existed, and one whose index says "nobody".
  const stale = await d1.create({ collectionId: col.id, title: "Stale", markdown: md });
  await runAsActor(db, SYSTEM, async (d) => {
    await d.update(documents).set({ taskAssignees: null }).where(eq(documents.id, legacy.id));
    await d.update(documents).set({ taskAssignees: [] }).where(eq(documents.id, stale.id));
  });

  const ids = new Set((await d1Queries.listMyTodos()).map((t) => t.documentId));
  assert.ok(ids.has(indexed.id), "found via the stored assignees");
  assert.ok(ids.has(legacy.id), "NULL rows fall back to scanning");
  assert.ok(!ids.has(stale.id), "stored assignees are authoritative (no body scan)");
});

test("concurrent fallback body edits don't drop each other", async () => {
  const c1 = new CollectionService(db, user("u1"));
  const col = await c1.create({ name: "Edit race", slug: "edit-race" });
  const d1 = new DocumentService(db, user("u1"));
  const doc = await d1.create({ collectionId: col.id, title: "Race", markdown: "Start." });
  await Promise.all([
    d1.editBody(doc.id, (md) => `${md}\n\nFrom A.`),
    d1.editBody(doc.id, (md) => `${md}\n\nFrom B.`),
  ]);
  const after = (await d1.get(doc.id))!.contentMd;
  assert.match(after, /From A\./);
  assert.match(after, /From B\./);
});

test("workspace members lists identities; non-members are rejected", async () => {
  const w1 = new WorkspaceService(db, user("u1"));
  const [ws] = await w1.listMine();
  const members = await w1.members(ws!.id);
  assert.ok(members.some((m) => m.userId === "u1" && m.role === "owner" && m.name === "Alice"));
  assert.ok(members.some((m) => m.userId === "u2"), "u2 joined via invite earlier");

  await assert.rejects(
    () => new WorkspaceService(db, user("outsider")).members(ws!.id),
    /not a member/,
  );
});

test("create rejects a parent outside the collection (incl. cross-tenant uuids)", async () => {
  const c1 = new CollectionService(db, user("u1"));
  const d1 = new DocumentService(db, user("u1"));
  const d2 = new DocumentService(db, user("u2"));
  const colA = await c1.create({ name: "PA", slug: "parent-a" });
  const colB = await c1.create({ name: "PB", slug: "parent-b" });
  const inA = await d1.create({ collectionId: colA.id, title: "in A" });

  await assert.rejects(
    () => d1.create({ collectionId: colB.id, title: "x", parentDocumentId: inA.id }),
    /same collection/,
    "cross-collection parent rejected",
  );
  // u2 (own workspace) cannot attach a child to u1's document.
  const [wsB] = await new WorkspaceService(db, user("u2")).listMine();
  const colU2 = await new CollectionService(db, user("u2")).create({
    name: "U2C",
    slug: "u2-parent",
    workspaceId: wsB!.id,
  });
  await assert.rejects(
    () => d2.create({ collectionId: colU2.id, title: "x", parentDocumentId: inA.id }),
    /same collection/,
    "cross-tenant parent rejected",
  );
});

test("grants and group membership only accept principals of the workspace", async () => {
  const c1 = new CollectionService(db, user("u1"));
  const col = await c1.create({ name: "GVal", slug: "grant-val" });

  await assert.rejects(
    () => c1.grant(col.id, "user", "stranger", "read"),
    /not a member/,
  );
  await assert.rejects(
    () => c1.grant(col.id, "group", "00000000-0000-0000-0000-000000000000", "read"),
    /does not belong/,
  );

  const [ws] = await new WorkspaceService(db, user("u1")).listMine();
  const g = await new GroupService(db, user("u1")).create(ws!.id, "Validated");
  await assert.rejects(
    () => new GroupService(db, user("u1")).addMember(g.id, "stranger"),
    /not a member/,
  );
});

test("comments: readers can discuss, resolve rides on write access, delete is the author's", async () => {
  const { CommentService } = await import("./services/comments.js");
  const c1 = new CollectionService(db, user("u1"));
  const d1 = new DocumentService(db, user("u1"));
  const col = await c1.create({ name: "Discuss", slug: "discuss" });
  await c1.setDefaultRole(col.id, "read"); // members read-only
  const doc = await d1.create({ collectionId: col.id, title: "Paper", markdown: "Draft text." });

  const alice = new CommentService(db, user("u1")); // owner (writable)
  const bob = new CommentService(db, user("u2")); // member (read-only)

  // A read-only member can open a thread and the author can reply.
  const thread = await bob.create({
    documentId: doc.id,
    body: "Is this claim sourced?",
    anchor: "QQ==",
    head: "Qg==",
  });
  const reply = await alice.create({
    documentId: doc.id,
    body: "Adding a citation.",
    parentId: thread.id,
  });
  await assert.rejects(
    () => bob.create({ documentId: doc.id, body: "nested", parentId: reply.id }),
    /replies cannot be nested/,
  );

  const listed = await bob.list(doc.id);
  assert.equal(listed.length, 2);
  assert.equal(listed[0]!.authorName, "Bob", "author names resolved");
  assert.equal(listed[0]!.anchor, "QQ==");
  assert.equal(listed[1]!.parentId, thread.id);
  assert.equal(listed[1]!.anchor, null, "replies carry no anchor");

  // Resolving: the doc-writable owner may; reopening works the same way.
  const resolved = await alice.setResolved(thread.id, true);
  assert.ok(resolved.resolvedAt);
  await bob.setResolved(thread.id, false); // author of the thread may too

  // An outsider sees nothing and cannot comment.
  const outsider = new CommentService(db, user("outsider"));
  assert.equal((await outsider.list(doc.id)).length, 0);
  await assert.rejects(
    () => outsider.create({ documentId: doc.id, body: "hi" }),
    /document not found/,
  );

  // Only the author deletes; a thread takes its replies with it.
  assert.equal(await alice.remove(thread.id), null, "not alice's thread");
  assert.ok(await bob.remove(thread.id));
  assert.equal((await alice.list(doc.id)).length, 0, "replies cascaded");
});

test("backlinks: pages referencing a doc, RLS-scoped, archived sources excluded", async () => {
  const c1 = new CollectionService(db, user("u1"));
  const d1 = new DocumentService(db, user("u1"));
  const d1Tree = new DocumentTreeService(db, user("u1"));
  const d1Queries = new DocumentQueryService(db, user("u1"));
  const col = await c1.create({ name: "Refs", slug: "refs" });
  await c1.setDefaultRole(col.id, "none"); // u1-only

  const target = await d1.create({ collectionId: col.id, title: "Target" });
  const source = await d1.create({
    collectionId: col.id,
    title: "Source",
    markdown: `See [Target](/d/${target.id}) for details.`,
  });
  await d1.create({ collectionId: col.id, title: "Unrelated", markdown: "No links here." });

  const links = await d1Queries.backlinks(target.id);
  assert.deepEqual(links.map((l) => l.id), [source.id]);

  // Another workspace's user sees no backlinks (can't read the sources).
  assert.equal((await new DocumentQueryService(db, user("u2")).backlinks(target.id)).length, 0);

  // Archiving the source drops it from the list.
  await d1Tree.archive(source.id);
  assert.equal((await d1Queries.backlinks(target.id)).length, 0);
});

test("settings: MCP kill switch and workspace audit trail", async () => {
  const { SettingsService } = await import("./services/settings.js");
  const s1 = new SettingsService(db, user("u1"));
  assert.equal(await s1.mcpEnabled(), true, "enabled by default");
  await s1.setMcpEnabled(false);
  assert.equal(await s1.mcpEnabled(), false);
  await s1.setMcpEnabled(true);

  const [ws] = await new WorkspaceService(db, user("u1")).listMine();
  const auditCollection = await new CollectionService(db, user("u1")).create({
    workspaceId: ws!.id,
    name: "Audit",
    slug: "audit-review-target",
  });
  const auditDoc = await new DocumentService(db, user("u1")).create({
    collectionId: auditCollection.id,
    title: "Paper",
  });
  await s1.recordAudit({
    workspaceId: ws!.id,
    userId: "u1",
    ai: true,
    action: "edit_document",
    detail: '"Paper"',
    documentId: auditDoc.id,
    sessionId: "1234",
  });
  const trail = await s1.auditTrail(ws!.id);
  assert.ok(
    trail.some(
      (e) =>
        e.action === "edit_document" &&
        e.userName === "Alice" &&
        e.ai &&
        e.documentId === auditDoc.id &&
        e.documentTitle === "Paper" &&
        e.sessionId === "1234",
    ),
    "entry visible with the human's name and exact review target",
  );

  // Fellow members see the trail; outsiders are rejected.
  assert.ok((await new SettingsService(db, user("u2")).auditTrail(ws!.id)).length >= 1);
  await assert.rejects(
    () => new SettingsService(db, user("outsider")).auditTrail(ws!.id),
    /not a member/,
  );
});

test("settings: sidebar fold state (per-id merge, inverted doc semantics)", async () => {
  const { SettingsService } = await import("./services/settings.js");
  const s1 = new SettingsService(db, user("u1"));
  const colId = "11111111-1111-4111-8111-111111111111";
  const docId = "22222222-2222-4222-8222-222222222222";

  assert.deepEqual(
    await s1.sidebarState(),
    { expandedCollections: [], collapsedDocs: [] },
    "empty by default",
  );

  // Collections store the expanded set; repeat adds don't duplicate.
  await s1.setSidebarNode("collection", colId, true);
  await s1.setSidebarNode("collection", colId, true);
  assert.deepEqual((await s1.sidebarState()).expandedCollections, [colId]);
  await s1.setSidebarNode("collection", colId, false);
  assert.deepEqual((await s1.sidebarState()).expandedCollections, []);

  // Documents store the collapsed set (they default expanded).
  await s1.setSidebarNode("doc", docId, false);
  assert.deepEqual((await s1.sidebarState()).collapsedDocs, [docId]);
  await s1.setSidebarNode("doc", docId, true);
  assert.deepEqual((await s1.sidebarState()).collapsedDocs, []);

  // The upsert touches only its own column: fold writes keep mcpEnabled,
  // and an mcpEnabled write keeps the fold sets.
  await s1.setMcpEnabled(false);
  await s1.setSidebarNode("collection", colId, true);
  assert.equal(await s1.mcpEnabled(), false);
  await s1.setMcpEnabled(true);
  assert.deepEqual((await s1.sidebarState()).expandedCollections, [colId]);

  // Per-user isolation and the user-actor requirement.
  assert.deepEqual((await new SettingsService(db, user("u2")).sidebarState()).expandedCollections, []);
  await assert.rejects(() => new SettingsService(db).sidebarState(), /requires a user actor/);
  await assert.rejects(
    () => new SettingsService(db).setSidebarNode("doc", docId, false),
    /requires a user actor/,
  );
});

test("snapshots: byte-dedupe, interval gating, RLS reads, and no client writes", async () => {
  const collections = new CollectionService(db, user("u1"));
  const documents = new DocumentService(db, user("u1"));
  const snapshots = new SnapshotService(db, user("u1"));
  const col = await collections.create({ name: "Versioned", slug: "versioned" });
  const doc = await documents.create({ collectionId: col.id, title: "V" });

  const cap = (bytes: number[]) =>
    snapshots.captureBoundary({
      documentId: doc.id,
      workspaceId: doc.workspaceId,
      ydocState: new Uint8Array(bytes),
      sessions: [{ userId: "u1", name: "User One", ai: false, at: Date.now() }],
    });

  await cap([1, 2, 3]);
  await cap([1, 2, 3]); // identical bytes → deduped
  assert.equal((await snapshots.list(doc.id)).length, 1, "identical state is not re-snapshotted");
  await cap([4, 5, 6]); // changed bytes → new version
  assert.equal((await snapshots.list(doc.id)).length, 2);

  // Interval gating: a fresh interval capture is skipped until old enough.
  await snapshots.captureInterval(
    { documentId: doc.id, workspaceId: doc.workspaceId, ydocState: new Uint8Array([7, 8, 9]), sessions: [] },
  );
  assert.equal((await snapshots.list(doc.id)).length, 2, "interval capture rate-limited");
  // Backdate the latest snapshot, then an interval capture goes through.
  await runAsActor(db, SYSTEM, (tx) =>
    tx.update(documentSnapshots).set({ createdAt: sql`now() - interval '20 minutes'` }).where(eq(documentSnapshots.documentId, doc.id)),
  );
  await snapshots.captureInterval(
    { documentId: doc.id, workspaceId: doc.workspaceId, ydocState: new Uint8Array([7, 8, 9]), sessions: [] },
  );
  assert.equal((await snapshots.list(doc.id)).length, 3, "interval capture proceeds once old enough");

  // Author labels are recorded for the list.
  const list = await snapshots.list(doc.id);
  assert.ok(list.some((s) => s.authors.some((a) => a.userId === "u1")), "sessions labelled");

  // RLS: a non-member sees none of it (u2 joined u1's workspace earlier).
  assert.equal((await new SnapshotService(db, user("outsider")).list(doc.id)).length, 0);
  // No client INSERT grant — a user-role write is refused outright.
  await assert.rejects(
    () =>
      runAsActor(db, user("u1"), (tx) =>
        tx.insert(documentSnapshots).values({
          workspaceId: doc.workspaceId,
          documentId: doc.id,
          ydocState: new Uint8Array([0]),
        }),
      ),
    /permission denied/i,
  );
});

test("favorites: star, list (RLS-filtered), unstar; foreign docs are invisible", async () => {
  const collections = new CollectionService(db, user("u1"));
  const documents = new DocumentService(db, user("u1"));
  const favorites = new FavoriteService(db, user("u1"));

  const col = await collections.create({ name: "Starred", slug: "starred" });
  const doc = await documents.create({ collectionId: col.id, title: "Keep handy" });

  await favorites.add(doc.id);
  await favorites.add(doc.id); // idempotent
  let list = await favorites.list();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.id, doc.id);
  assert.equal(list[0]!.title, "Keep handy");

  // An outsider can't star what they can't read — and their list stays empty.
  // (u2 and u3 both join u1's workspace in earlier tests; use a fresh user.)
  await new WorkspaceService(db, SYSTEM).provisionForUser("u-fav-outsider", {
    name: "Outsider",
    slug: "fav-outsider",
  });
  const other = new FavoriteService(db, user("u-fav-outsider"));
  await assert.rejects(() => other.add(doc.id), /not found/);
  assert.deepEqual(await other.list(), []);

  await favorites.remove(doc.id);
  list = await favorites.list();
  assert.equal(list.length, 0);
});

test("notifications: replies, mentions, resolves, new-task assignment, inbox", async () => {
  // Self-contained pair of users sharing one workspace.
  await runAsActor(db, SYSTEM, async (d) => {
    await d
      .insert(userTable)
      .values([
        { id: "na", name: "Nia", email: "nia@acme.com" },
        { id: "nb", name: "Ben", email: "ben@acme.com" },
      ]);
  });
  const ws = await new WorkspaceService(db, SYSTEM).provisionForUser("na", {
    name: "Notify",
    slug: "notify",
  });
  await runAsActor(db, SYSTEM, async (d) => {
    await d
      .insert(workspaceMembers)
      .values({ workspaceId: ws.id, userId: "nb", role: "member" });
  });

  const docs = new DocumentService(db, user("na"));
  const col = await new CollectionService(db, user("na")).create({
    name: "Notify",
    slug: "notify-col",
    workspaceId: ws.id,
  });
  const doc = await docs.create({ collectionId: col.id, title: "Plans" });

  const commentsNa = new CommentService(db, user("na"));
  const commentsNb = new CommentService(db, user("nb"));
  const notify = new NotificationService(db, SYSTEM);

  // Reply: Ben replies to Nia's thread -> Nia hears about it.
  const top = await commentsNa.create({ documentId: doc.id, body: "Thoughts?" });
  const reply = await commentsNb.create({
    documentId: doc.id,
    body: "**Looks** good, see `x`\nand more",
    parentId: top.id,
  });
  await notify.onCommentCreated({
    comment: reply,
    workspaceId: ws.id,
    documentTitle: "Plans",
    actor: { userId: "nb", name: "Ben", ai: false },
  });

  // Mention: Nia mentions @ben in a top-level comment -> Ben hears about it.
  const mention = await commentsNa.create({ documentId: doc.id, body: "cc @ben" });
  await notify.onCommentCreated({
    comment: mention,
    workspaceId: ws.id,
    documentTitle: "Plans",
    actor: { userId: "na", name: "Nia", ai: false },
  });

  // Resolve: Ben resolves Nia's thread -> Nia hears about it.
  await notify.onCommentResolved({
    comment: { id: top.id, documentId: doc.id, authorId: "na", body: top.body },
    workspaceId: ws.id,
    documentTitle: "Plans",
    actor: { userId: "nb", name: "Ben", ai: true },
  });

  // Task assignment: a NEW `- [ ] @ben` task notifies Ben; a re-store of the
  // same markdown does not re-notify; self-assignment never notifies.
  const md = "# Plans\n\n- [ ] @ben draft the intro\n- [ ] @nia self task";
  await notify.onDocumentStored({
    documentId: doc.id,
    workspaceId: ws.id,
    documentTitle: "Plans",
    oldMarkdown: null,
    newMarkdown: md,
    actor: { userId: "na", name: "Nia", ai: false },
    scan: scanTaskItems,
  });
  await notify.onDocumentStored({
    documentId: doc.id,
    workspaceId: ws.id,
    documentTitle: "Plans",
    oldMarkdown: md,
    newMarkdown: md + "\n\nmore prose",
    actor: { userId: "na", name: "Nia", ai: false },
    scan: scanTaskItems,
  });

  const inboxNa = new NotificationService(db, user("na"));
  const inboxNb = new NotificationService(db, user("nb"));

  const naList = await inboxNa.listMine();
  assert.deepEqual(
    naList.map((n) => n.kind).sort(),
    ["comment_reply", "comment_resolved"],
    "Nia: reply + resolve (never her own actions)",
  );
  assert.ok(naList.every((n) => n.documentTitle === "Plans"));
  assert.ok(naList.every((n) => n.workspaceId === ws.id));
  assert.deepEqual(
    (await inboxNa.listMine(ws.id)).map((n) => n.id).sort(),
    naList.map((n) => n.id).sort(),
    "a workspace-scoped inbox keeps that workspace's rows",
  );
  assert.deepEqual(
    await inboxNa.listMine(crypto.randomUUID()),
    [],
    "and filters server-side, so a busy workspace can't crowd rows out",
  );
  assert.ok(
    naList.some(
      (n) =>
        n.kind === "comment_reply" &&
        n.targetType === "comment" &&
        n.targetId === top.id,
    ),
    "reply notification deep-links to its root thread",
  );
  assert.equal(
    naList.find((n) => n.kind === "comment_reply")!.snippet,
    "Looks good, see x and more",
    "comment snippets are the markdown body as one line of plain text",
  );
  assert.ok(
    naList.some(
      (n) =>
        n.kind === "comment_resolved" &&
        n.ai &&
        n.targetType === "comment" &&
        n.targetId === top.id,
    ),
    "AI actor flagged",
  );

  const nbList = await inboxNb.listMine();
  assert.deepEqual(
    nbList.map((n) => n.kind).sort(),
    ["comment_mention", "task_assigned"],
    "Ben: mention + one task assignment (no duplicate on re-store)",
  );
  assert.ok(
    nbList.some(
      (n) =>
        n.kind === "comment_mention" &&
        n.targetType === "comment" &&
        n.targetId === mention.id,
    ),
    "mention notification deep-links to the mentioned thread",
  );
  const assigned = nbList.find((n) => n.kind === "task_assigned")!;
  assert.match(assigned.snippet, /draft the intro/);
  assert.equal(assigned.targetType, "task", "task assignment deep-links to its line");
  assert.match(assigned.targetId!, /draft the intro/);

  assert.equal(await inboxNb.unreadCount(), 2);
  await inboxNb.markRead(nbList[0]!.id);
  assert.equal(await inboxNb.unreadCount(), 1, "one action-center item can be cleared");
  await inboxNb.markAllRead();
  assert.equal(await inboxNb.unreadCount(), 0);
  assert.equal(await inboxNa.unreadCount(), 2, "Nia's inbox untouched");
});

/** A fresh workspace owned by `userId` (named `name`), with one collection. */
async function templateWorkspace(userId: string, name: string) {
  await runAsActor(db, SYSTEM, (d) =>
    d.insert(userTable).values({ id: userId, name, email: `${userId}@tpl.test` }),
  );
  const ws = await new WorkspaceService(db, SYSTEM).provisionForUser(userId, {
    name,
    slug: `ws-${userId}`,
  });
  const col = await new CollectionService(db, user(userId)).create({
    name: "Team",
    slug: `team-${userId}`,
    workspaceId: ws.id,
  });
  return {
    col,
    docs: new DocumentService(db, user(userId)),
    tree: new DocumentTreeService(db, user(userId)),
    queries: new DocumentQueryService(db, user(userId)),
    templates: new TemplateService(db, user(userId)),
  };
}

test("expandVariables fills known names and blanks unknown ones", () => {
  assert.equal(
    expandVariables("{{ date }} by {{me}}: {{client name}} / {{nope}} / {{constructor}} / {{1x}}", {
      date: "2026-01-02",
      me: "Tara",
      "client name": "Acme",
    }),
    "2026-01-02 by Tara: Acme /  /  / {{1x}}",
  );
});

test("templates: instantiate expands variables, copies 3 levels, records origin", async () => {
  const { col, docs, tree, templates } = await templateWorkspace("ta", "Tara");
  const tpl = await docs.create({
    collectionId: col.id,
    title: "Meeting {{date}}",
    markdown: "# {{title}}\n\nBy {{me}} in {{parent}}\n\nClient: {{client}}",
  });
  const l1 = await docs.create({ collectionId: col.id, parentDocumentId: tpl.id, title: "Notes", markdown: "Under {{parent}}" });
  const l2 = await docs.create({ collectionId: col.id, parentDocumentId: l1.id, title: "Level 2" });
  const l3 = await docs.create({ collectionId: col.id, parentDocumentId: l2.id, title: "Level 3" });
  await docs.create({ collectionId: col.id, parentDocumentId: l3.id, title: "Level 4" });
  const summary = await templates.templatize(tpl.id, "Meeting notes");
  assert.equal(summary.name, "Meeting notes");

  const dry = await templates.instantiate({
    templateId: tpl.id,
    collectionId: col.id,
    variables: { date: "2026-01-02" },
    dryRun: true,
  });
  assert.equal(dry.document, null);
  assert.deepEqual(dry.prompts, ["client"]);
  assert.deepEqual(dry.missing, ["client"]);
  assert.deepEqual(dry.page, {
    title: "Meeting 2026-01-02",
    markdown: "# Meeting 2026-01-02\n\nBy Tara in Team\n\nClient: ",
    children: [
      {
        title: "Notes",
        markdown: "Under Meeting 2026-01-02",
        children: [{ title: "Level 2", markdown: "", children: [{ title: "Level 3", markdown: "", children: [] }] }],
      },
    ],
  });
  assert.equal((await tree.tree(col.id)).length, 1, "a dry run creates nothing");

  const created = await templates.instantiate({
    templateId: tpl.id,
    collectionId: col.id,
    variables: { date: "2026-01-02", client: "Acme" },
  });
  const page = created.document!;
  assert.equal(page.title, "Meeting 2026-01-02");
  assert.equal(page.contentMd, "# Meeting 2026-01-02\n\nBy Tara in Team\n\nClient: Acme");
  assert.deepEqual(page.origin, { templateId: tpl.id, version: summary.version });
  const copied = await tree.subtree(page.id, 10);
  const titles = (nodes: typeof copied.nodes): unknown[] =>
    nodes.map((n) => [n.title, titles(n.children)]);
  assert.deepEqual(titles(copied.nodes), [["Notes", [["Level 2", [["Level 3", []]]]]]]);

  const today = new Date();
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const dated = await templates.instantiate({ templateId: tpl.id, collectionId: col.id, dryRun: true });
  assert.equal(dated.page.title, `Meeting ${iso}`, "{{date}} defaults to today");

  await docs.editBody(tpl.id, () => "Rewritten template");
  assert.equal(
    (await docs.get(page.id))!.contentMd,
    "# Meeting 2026-01-02\n\nBy Tara in Team\n\nClient: Acme",
    "template edits never reach existing pages",
  );
});

test("templates: the deepest default wins, then the collection's, else blank", async () => {
  const { col, docs, templates } = await templateWorkspace("tc", "Cai");
  const colTpl = await docs.create({ collectionId: col.id, title: "Collection default", markdown: "From collection" });
  const folderTpl = await docs.create({ collectionId: col.id, title: "Folder default", markdown: "From folder" });
  await templates.templatize(colTpl.id, "Collection default");
  await templates.templatize(folderTpl.id, "Folder default");
  const folder = await docs.create({ collectionId: col.id, title: "Folder" });
  const sub = await docs.create({ collectionId: col.id, parentDocumentId: folder.id, title: "Sub" });
  const other = await docs.create({ collectionId: col.id, title: "Other" });

  assert.equal(await templates.defaultFor(col.id, sub.id), null);
  assert.equal(await templates.setDefault({ collectionId: col.id }, colTpl.id), true);
  assert.equal(await templates.setDefault({ documentId: folder.id }, folderTpl.id), true);
  assert.equal(await templates.defaultFor(col.id, sub.id), folderTpl.id);
  assert.equal(await templates.defaultFor(col.id, folder.id), folderTpl.id);
  assert.equal(await templates.defaultFor(col.id, other.id), colTpl.id);
  assert.equal(await templates.defaultFor(col.id, null), colTpl.id);

  const fromDefault = await templates.instantiate({ collectionId: col.id, parentDocumentId: sub.id });
  assert.equal(fromDefault.template?.id, folderTpl.id);
  assert.equal(fromDefault.document!.title, "Folder default");
  assert.equal(fromDefault.document!.contentMd, "From folder");

  const blank = await templates.instantiate({ templateId: null, collectionId: col.id, parentDocumentId: sub.id });
  assert.equal(blank.template, null);
  assert.equal(blank.document!.title, "");
  assert.equal(blank.document!.contentMd, "");
  assert.equal(blank.document!.origin, null);

  assert.equal(await templates.untemplatize(folderTpl.id), true);
  assert.equal(await templates.defaultFor(col.id, sub.id), colTpl.id, "an unmarked template stops being a default");

  const outsider = await templateWorkspace("td", "Dee");
  await assert.rejects(
    outsider.templates.setDefault({ collectionId: outsider.col.id }, colTpl.id),
    NotFoundError,
    "another workspace's template is invisible",
  );
  assert.deepEqual(await outsider.templates.list(), []);
});

test("templates: templates and their subtrees stay out of search, backlinks, recents, tasks and tags", async () => {
  const { col, docs, queries, templates } = await templateWorkspace("te", "Eve");
  const target = await docs.create({ collectionId: col.id, title: "Target" });
  const link = `[Target](/d/${target.id})`;
  const tpl = await docs.create({
    collectionId: col.id,
    title: "Zyxquux template",
    markdown: `Zyxquux ${link}\n\n- [ ] @te prepare the zyxquux`,
    tags: ["tpl-only"],
  });
  const tplChild = await docs.create({
    collectionId: col.id,
    parentDocumentId: tpl.id,
    title: "Zyxquux child",
    markdown: `- [ ] @te child zyxquux ${link}`,
  });
  const page = await docs.create({
    collectionId: col.id,
    title: "Real page",
    markdown: `Zyxquux ${link}\n\n- [ ] @te real zyxquux`,
  });
  await templates.templatize(tpl.id, "");

  assert.deepEqual((await queries.search("zyxquux")).map((h) => h.id), [page.id]);
  assert.deepEqual((await queries.backlinks(target.id)).map((d) => d.id), [page.id]);
  assert.deepEqual(
    (await queries.recent({ collectionId: col.id })).map((d) => d.id).sort(),
    [target.id, page.id].sort(),
  );
  assert.deepEqual((await queries.listMyTodos()).map((t) => t.text), ["@te real zyxquux"]);
  assert.ok(!(await queries.listTags()).some((t) => t.tag === "tpl-only"));
  assert.deepEqual((await docs.getMetaMany([tpl.id, tplChild.id, page.id])).map((d) => d.id), [page.id]);
  assert.deepEqual((await templates.list()).map((t) => t.name), ["Zyxquux template"]);

  assert.equal(await templates.untemplatize(tpl.id), true);
  assert.deepEqual(
    (await queries.search("zyxquux")).map((h) => h.id).sort(),
    [tpl.id, tplChild.id, page.id].sort(),
    "an ordinary page again",
  );
});

test("templates: new tasks in a template notify nobody", async () => {
  const { col, docs, templates } = await templateWorkspace("tf", "Fay");
  const tpl = await docs.create({ collectionId: col.id, title: "Checklist" });
  const page = await docs.create({ collectionId: col.id, title: "Page" });
  await templates.templatize(tpl.id, "Checklist");
  const notify = new NotificationService(db, SYSTEM);
  for (const doc of [tpl, page]) {
    await notify.onDocumentStored({
      documentId: doc.id,
      workspaceId: col.workspaceId,
      documentTitle: doc.title,
      oldMarkdown: "",
      newMarkdown: "- [ ] @tf review",
      actor: { userId: "someone", name: "Someone", ai: false },
      scan: scanTaskItems,
    });
  }
  assert.deepEqual(
    (await new NotificationService(db, user("tf")).listMine()).map((n) => n.documentTitle),
    ["Page"],
  );
});

async function typedWorkspace(owner: string, member: string) {
  const ws = await new WorkspaceService(db, SYSTEM).provisionForUser(owner, {
    name: owner,
    slug: owner,
  });
  await db.insert(workspaceMembers).values({ workspaceId: ws.id, userId: member, role: "member" });
  const col = await new CollectionService(db, user(owner)).create({ name: "Notes", slug: `${owner}-notes` });
  const types = new TypeService(db, user(owner));
  const meeting = await types.createType(ws.id, "Meeting");
  const status = await types.createField({
    workspaceId: ws.id,
    typeId: meeting.id,
    key: "status",
    kind: "select",
    options: ["Open", "Done"],
  });
  const attendees = await types.createField({
    workspaceId: ws.id,
    typeId: meeting.id,
    key: "attendees",
    kind: "multi_select",
    options: ["Ann", "Bob", "Cy"],
  });
  const due = await types.createField({ workspaceId: ws.id, typeId: meeting.id, key: "due", kind: "date" });
  const opt = (field: typeof status, label: string) => field.options.find((o) => o.label === label)!.id;
  return { ws, col, types, meeting, status, attendees, due, opt };
}

test("types: owners and admins define types and fields, members only read them", async () => {
  const { ws, meeting, status } = await typedWorkspace("ty-owner", "ty-member");
  const asMember = new TypeService(db, user("ty-member"));
  await assert.rejects(() => asMember.createType(ws.id, "Project"), /owner or admin/);
  await assert.rejects(
    () => asMember.createField({ workspaceId: ws.id, typeId: null, key: "x", kind: "text" }),
    /owner or admin/,
  );
  await assert.rejects(
    () =>
      runAsActor(db, user("ty-member"), (tx) =>
        tx.insert(documentTypes).values({ workspaceId: ws.id, name: "Sneaky", createdBy: "ty-member" }),
      ),
    /row-level security/,
  );
  assert.deepEqual(
    (await asMember.listTypes(ws.id)).map((t) => [t.name, t.fields.map((f) => [f.key, f.kind])]),
    [["Meeting", [["status", "select"], ["attendees", "multi_select"], ["due", "date"]]]],
  );
  assert.deepEqual(
    status.options.map((o) => o.label),
    ["Open", "Done"],
  );
  assert.equal(
    (await new TypeService(db, user("u1")).listTypes(ws.id)).length,
    0,
    "outsiders see no types",
  );
  await assert.rejects(
    () => new TypeService(db, user("ty-owner")).createType(ws.id, "meeting"),
    /already exists/,
  );
  assert.equal(meeting.workspaceId, ws.id);
});

test("properties: the projection validates every kind and reports what fails", () => {
  const field = (id: string, kind: TypeField["kind"], extra: Partial<FieldDef> = {}): [string, FieldDef] => [
    id,
    { id, key: id, kind, options: [], retiredAt: null, ...extra },
  ];
  const fields = new Map<string, FieldDef>([
    field("t", "text"),
    field("n", "number"),
    field("c", "checkbox"),
    field("d", "date"),
    field("dt", "datetime"),
    field("s", "select", {
      options: [
        { id: "o1", label: "Open" },
        { id: "o2", label: "Old", retired: true },
      ],
    }),
    field("m", "multi_select", { options: [{ id: "o1", label: "Ann" }] }),
    field("u", "url"),
    field("r", "doc"),
    field("rl", "doc_list"),
    field("j", "json"),
    field("gone", "text", { retiredAt: new Date(0) }),
  ]);
  const ref = "6f1c1c7e-2a7e-4c55-9d0a-0123456789ab";
  assert.deepEqual(
    projectProperties(
      {
        t: "Weekly sync",
        n: 3.5,
        c: false,
        d: "2026-11-07",
        dt: "2026-11-07T10:00:00.000Z",
        s: "o2",
        m: ["o1", "o1", "o9"],
        u: "https://example.com/a",
        r: ref,
        rl: [ref],
        j: { nested: [1, 2] },
        gone: "kept",
        empty: "",
        cleared: null,
        stray: 1,
      },
      fields,
    ),
    {
      properties: {
        t: "Weekly sync",
        n: 3.5,
        c: false,
        d: "2026-11-07",
        dt: "2026-11-07T10:00:00.000Z",
        s: "o2",
        m: ["o1"],
        u: "https://example.com/a",
        r: ref,
        rl: [ref],
        j: { nested: [1, 2] },
        gone: "kept",
      },
      propertyIssues: [
        { fieldId: "s", code: "retired_option", message: "holds a retired option", value: "o2" },
        { fieldId: "m", code: "invalid_value", message: '"o9" is not an option', value: ["o9"] },
        { fieldId: "gone", code: "retired_field", message: "gone is retired", value: "kept" },
        { fieldId: "stray", code: "unknown_field", message: "no field has this id", value: 1 },
      ],
      propertiesText: "Weekly sync\n3.5\n2026-11-07\n2026-11-07T10:00:00.000Z\nOld\nAnn\nhttps://example.com/a\nkept",
    },
  );
  assert.deepEqual(
    projectProperties(
      {
        t: 5,
        n: "5",
        c: "yes",
        d: "2026-02-30",
        dt: "2026-11-07 10:00",
        s: ["o1"],
        m: "o1",
        u: "javascript:alert(1)",
        r: "not-a-uuid",
      },
      fields,
    ).propertyIssues.map((i) => [i.fieldId, i.message]),
    [
      ["t", "expected text"],
      ["n", "expected a number"],
      ["c", "expected true or false"],
      ["d", "expected a date (YYYY-MM-DD)"],
      ["dt", "expected a date and time (ISO 8601)"],
      ["s", "expected one value"],
      ["m", "expected a list"],
      ["u", "expected an http(s) URL"],
      ["r", "expected a document id"],
    ],
  );
  assert.deepEqual(
    projectProperties({ d: "2026-13-45" }, fields).propertyIssues.map((i) => [i.fieldId, i.message]),
    [["d", "expected a date (YYYY-MM-DD)"]],
    "a month that doesn't exist is an issue, not a thrown RangeError",
  );
});

test("properties: patches by key and label land as ids, and the projection feeds search", async () => {
  const { ws, col, types, meeting, status, attendees, due, opt } = await typedWorkspace("ty2-owner", "ty2-member");
  const documents = new DocumentService(db, user("ty2-owner"));
  const planned = await types.planCreate(col.id, {
    type: "meeting",
    properties: { Status: "done", attendees: ["ann", "Bob"], due: "2026-11-07" },
  });
  assert.equal(planned.typeId, meeting.id);
  const doc = await documents.create({
    collectionId: col.id,
    title: "Retro",
    markdown: "Notes.",
    typeId: planned.typeId,
    properties: planned.ops,
  });
  assert.deepEqual(doc.properties, {
    [status.id]: opt(status, "Done"),
    [attendees.id]: [opt(attendees, "Ann"), opt(attendees, "Bob")],
    [due.id]: "2026-11-07",
  });
  assert.equal(doc.propertiesText, "Done\nAnn\nBob\n2026-11-07");
  assert.equal(doc.contentMd, "Notes.");
  const hits = await new DocumentQueryService(db, user("ty2-owner")).search("done");
  assert.deepEqual(
    hits.map((h) => h.title),
    ["Retro"],
  );

  await assert.rejects(
    () => types.planPatch(doc.id, { set: { links: "x" } }),
    /^InvalidInputError: unknown field "links"\. Fields this page can take: status \(select: Open, Done\); attendees \(multi_select: Ann, Bob, Cy\); due \(date\)\. Only a workspace owner or admin can define new fields\.$/,
  );

  const fixed = await types.planPatch(doc.id, { add: { attendees: "cy" }, unset: ["due"] });
  const edited = await documents.editProperties(doc.id, fixed);
  assert.deepEqual(edited.properties, {
    [status.id]: opt(status, "Done"),
    [attendees.id]: [opt(attendees, "Ann"), opt(attendees, "Bob"), opt(attendees, "Cy")],
  });

  const view = await types.view(doc.id);
  assert.deepEqual(view.type, { id: meeting.id, name: "Meeting" });
  assert.deepEqual(view.values, { [status.id]: "Done", [attendees.id]: ["Ann", "Bob", "Cy"] });
  assert.deepEqual(
    view.fields.map((f) => f.key),
    ["status", "attendees", "due"],
  );

  await assert.rejects(() => types.planPatch(doc.id, { set: { status: "Maybe" } }), /status: "Maybe" is not an option\. Options: Open, Done/);
  await assert.rejects(() => types.planPatch(doc.id, { add: { status: "Open" } }), /status holds one value: use set, not add/);
  await assert.rejects(() => types.planPatch(doc.id, { set: { due: "next week" } }), /due: expected a date/);
  await assert.rejects(() => types.planPatch(doc.id, { set: { status: "Open" }, unset: ["status"] }), /changed twice/);
  assert.equal(doc.workspaceId, ws.id);
});

test("properties: a renamed key keeps working as an alias; detaching keeps values; duplicate copies both", async () => {
  const { col, types, status, opt } = await typedWorkspace("ty3-owner", "ty3-member");
  const documents = new DocumentService(db, user("ty3-owner"));
  const planned = await types.planCreate(col.id, { type: "Meeting", properties: { status: "Open" } });
  const doc = await documents.create({ collectionId: col.id, title: "Sync", typeId: planned.typeId, properties: planned.ops });

  const renamed = await types.updateField(status.id, { key: "state" });
  assert.deepEqual([renamed.key, renamed.aliases], ["state", ["status"]]);
  assert.deepEqual(await types.planPatch(doc.id, { set: { STATUS: "done" } }), [
    { op: "set", field: status.id, value: opt(status, "Done") },
  ]);

  assert.equal(await types.setDocumentType(doc.id, null), true);
  const detached = await types.view(doc.id);
  assert.equal(detached.type, null);
  assert.deepEqual(detached.values, { [status.id]: "Open" });
  assert.deepEqual(await types.planPatch(doc.id, { set: { state: "done" } }), [
    { op: "set", field: status.id, value: opt(status, "Done") },
  ]);

  await types.setDocumentType(doc.id, planned.typeId);
  const copy = await documents.duplicate(doc.id);
  assert.equal(copy.title, "Sync (copy)");
  assert.equal(copy.typeId, planned.typeId);
  assert.deepEqual(copy.properties, { [status.id]: opt(status, "Open") });

  const bodyEdited = await documents.editBody(doc.id, (md) => `${md}Body.`);
  assert.equal(bodyEdited.contentMd, "Body.");
  assert.deepEqual(bodyEdited.properties, { [status.id]: opt(status, "Open") });

  assert.equal(await new TypeService(db, user("ty3-member")).setDocumentType(copy.id, null), true);
  await assert.rejects(() => new TypeService(db, user("u1")).setDocumentType(doc.id, null), /document not found/);
});

test("properties: a stored map is projected on save, trusting nothing in it", async () => {
  const { col, status, opt } = await typedWorkspace("ty4-owner", "ty4-member");
  const documents = new DocumentService(db, user("ty4-owner"));
  const doc = await documents.create({ collectionId: col.id, title: "Raw" });
  await documents.saveCollabSnapshot(doc.id, {
    ydocState: new Uint8Array([0, 0]),
    contentMd: "",
    contentJson: null,
    properties: { [status.id]: opt(status, "Open"), f_ghost: "boo", [`${status.id}x`]: null },
  });
  const [row] = await db
    .select({ properties: documentsTable.properties, issues: documentsTable.propertyIssues })
    .from(documentsTable)
    .where(eq(documentsTable.id, doc.id));
  assert.deepEqual(row, {
    properties: { [status.id]: opt(status, "Open") },
    issues: [{ fieldId: "f_ghost", code: "unknown_field", message: "no field has this id", value: "boo" }],
  });
});
