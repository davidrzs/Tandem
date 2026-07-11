import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { createDatabase, migrateDatabase, SYSTEM } from "@tandem/db";
import { WorkspaceService } from "@tandem/core";
import { getAuthors } from "@tandem/editor";
import * as Y from "yjs";
import { createServices } from "../services.js";
import { buildExportZip } from "./export.js";
import { importZip, ImportError } from "./import.js";

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

/** An Outline-shaped zip: a collection, a tagged doc that links a child + an
 * image, the child doc, and the referenced attachment. */
function outlineZip(): Buffer {
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

test("import: Outline zip → tree, tags, rewritten links, uploaded image, importer blame", async () => {
  const summary = await importZip(services, {
    workspaceId,
    uid: "u1",
    zipName: "backup.zip",
    buffer: outlineZip(),
  });
  assert.equal(summary.collections, 1);
  assert.equal(summary.documents, 2);
  assert.equal(summary.images, 1);

  const col = (await services.collections.list()).find((c) => c.name === "Handbook")!;
  assert.ok(col, "collection created from the top folder");
  const tree = await services.documents.tree(col.id);
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

test("export: Outline layout, front matter only when tagged, round-trips", async () => {
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
