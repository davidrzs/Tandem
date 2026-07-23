import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyImportEntries,
  composeExportDoc,
  emitFrontMatter,
  parseFrontMatter,
  planExportLayout,
  resolveZipPath,
  rewriteExportLinks,
  rewriteImportLinks,
  sanitizeFilename,
  splitLeadingH1,
  uniqueName,
} from "./markdown-zip.js";

test("sanitizeFilename strips path/control chars and never empties", () => {
  assert.equal(sanitizeFilename('a/b:c*?"<>|d'), "abcd");
  assert.equal(sanitizeFilename("  ...trim... "), "trim");
  assert.equal(sanitizeFilename("///"), "Untitled");
});

test("uniqueName dedupes case-insensitively with a suffix", () => {
  const used = new Set<string>();
  assert.equal(uniqueName(used, "Notes"), "Notes");
  assert.equal(uniqueName(used, "notes"), "notes (1)");
  assert.equal(uniqueName(used, "Notes"), "Notes (2)");
});

test("front matter emits a dash-list and parses both forms", () => {
  assert.equal(emitFrontMatter([]), "");
  assert.equal(emitFrontMatter(["a", "b"]), "---\ntags:\n  - a\n  - b\n---\n\n");
  assert.deepEqual(parseFrontMatter("---\ntags:\n  - x\n  - y\n---\n\nBody").tags, ["x", "y"]);
  assert.deepEqual(parseFrontMatter("---\ntags: [p, 'q r']\n---\nBody").tags, ["p", "q r"]);
  const none = parseFrontMatter("No front matter here");
  assert.deepEqual(none.tags, []);
  assert.equal(none.body, "No front matter here");
  // The body after the block is intact.
  assert.equal(parseFrontMatter("---\ntags:\n  - x\n---\n\nHello").body, "Hello");
});

test("splitLeadingH1 pulls the title; composeExportDoc reassembles", () => {
  assert.deepEqual(splitLeadingH1("# Title\n\nBody here"), { title: "Title", body: "Body here" });
  assert.deepEqual(splitLeadingH1("No heading"), { title: null, body: "No heading" });
  assert.equal(
    composeExportDoc({ title: "My Doc", tags: ["t"], body: "Content." }),
    "---\ntags:\n  - t\n---\n\n# My Doc\n\nContent.\n",
  );
});

test("planExportLayout nests children in a same-named folder and dedupes", () => {
  const layout = planExportLayout([
    {
      name: "Handbook",
      docs: [
        { id: "d1", title: "Onboarding", children: [{ id: "d2", title: "Laptop", children: [] }] },
        { id: "d3", title: "Onboarding", children: [] },
      ],
    },
  ]);
  assert.equal(layout.get("d1"), "Handbook/Onboarding.md");
  assert.equal(layout.get("d2"), "Handbook/Onboarding/Laptop.md");
  assert.equal(layout.get("d3"), "Handbook/Onboarding (1).md");
});

test("rewriteExportLinks makes doc + image links relative (balanced parens)", () => {
  const out = rewriteExportLinks("See [Other](/d/11111111-1111-1111-1111-111111111111) and ![x](/api/images/22222222-2222-2222-2222-222222222222).", {
    docDir: "Team",
    resolveDocPath: (id) => (id === "11111111-1111-1111-1111-111111111111" ? "Team/Other (1).md" : null),
    resolveImage: (id) => (id === "22222222-2222-2222-2222-222222222222" ? "uploads/img/image.png" : null),
  });
  assert.match(out, /\[Other\]\(\.\/Other%20%281%29\.md\)/);
  assert.match(out, /!\[x\]\(uploads\/img\/image\.png\)/);
});

test("classifyImportEntries handles nested-wiki, Obsidian, and loose shapes", () => {
  // Nested wiki: top folders are collections; a doc's children sit in its folder.
  const wiki = classifyImportEntries(
    ["Handbook/Onboarding.md", "Handbook/Onboarding/Laptop.md", "__MACOSX/x", ".DS_Store"],
    "Imported",
  );
  assert.equal(wiki.collections.length, 1);
  assert.equal(wiki.collections[0]!.name, "Handbook");
  assert.equal(wiki.collections[0]!.docs[0]!.title, "Onboarding");
  assert.equal(wiki.collections[0]!.docs[0]!.children[0]!.title, "Laptop");

  // Obsidian: a folder without a sibling .md becomes a placeholder doc.
  const vault = classifyImportEntries(["Vault/note.md", "Vault/sub/child.md"], "Imported");
  const sub = vault.collections[0]!.docs.find((d) => d.title === "sub")!;
  assert.equal(sub.mdPath, null, "placeholder has no file");
  assert.equal(sub.children[0]!.title, "child");

  // Loose root files → one vault-style collection named after the zip.
  const loose = classifyImportEntries(["a.md", "b.md", "pics/x.png"], "MyZip");
  assert.equal(loose.collections[0]!.name, "MyZip");
  assert.equal(loose.collections[0]!.docs.length, 2);
  assert.ok(loose.attachments.has("pics/x.png"));
});

test("resolveZipPath resolves relatives and rejects escapes/absolutes", () => {
  assert.equal(resolveZipPath("Col/Doc", "../Team/Notes.md"), "Col/Team/Notes.md");
  assert.equal(resolveZipPath("Col", "./sub/img.png"), "Col/sub/img.png");
  assert.equal(resolveZipPath("Col", "../../etc/passwd"), null);
  assert.equal(resolveZipPath("Col", "https://x.com/y"), null);
  assert.equal(resolveZipPath("Col", "/absolute"), null);
  assert.equal(resolveZipPath("Col", "Other%20Doc.md"), "Col/Other Doc.md");
});

test("rewriteImportLinks maps relative + wiki links to in-app forms", () => {
  const warnings: string[] = [];
  const out = rewriteImportLinks(
    "[Other](Other.md) ![](img.png) [[Wiki]] [[Wiki|see this]] [Gone](missing.md)",
    {
      docDir: "Col",
      resolveDoc: (zip) => (zip === "Col/Other.md" ? "DID" : null),
      resolveImage: (zip) => (zip === "Col/img.png" ? "/api/images/IID" : null),
      resolveWiki: (t) => (t === "Wiki" ? "WID" : null),
      warn: (m) => warnings.push(m),
    },
  );
  assert.match(out, /\[Other\]\(\/d\/DID\)/);
  assert.match(out, /!\[\]\(\/api\/images\/IID\)/);
  assert.match(out, /\[Wiki\]\(\/d\/WID\)/);
  assert.match(out, /\[see this\]\(\/d\/WID\)/);
  assert.match(out, /\[Gone\]\(missing\.md\)/, "unresolved link left as-is");
  assert.ok(warnings.some((w) => w.includes("missing.md")));
});
