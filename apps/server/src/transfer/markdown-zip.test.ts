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
  startsWithFrontMatter,
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
  assert.equal(emitFrontMatter(["#x", "a: b"]), '---\ntags:\n  - "#x"\n  - "a: b"\n---\n\n');
  assert.deepEqual(parseFrontMatter(emitFrontMatter(["#x", "a: b"])).tags, ["#x", "a: b"]);
  assert.deepEqual(parseFrontMatter("---\ntags:\n  - x\n  - y\n---\n\nBody").tags, ["x", "y"]);
  assert.deepEqual(parseFrontMatter("---\ntags: [p, 'q r']\n---\nBody").tags, ["p", "q r"]);
  const none = parseFrontMatter("No front matter here");
  assert.deepEqual(none, { tags: [], dropped: [], body: "No front matter here", error: null });
  assert.equal(parseFrontMatter("---\ntags:\n  - x\n---\n\nHello").body, "Hello");
});

test("parseFrontMatter: block lists, quoted strings, nested maps report dropped keys", () => {
  assert.deepEqual(
    parseFrontMatter(
      '---\nstatus: draft\ntags:\n  - "q: r"\n  - plain\nreview:\n  owner: ana\n  due: 2026-01-02\n---\n\nBody',
    ),
    { tags: ["q: r", "plain"], dropped: ["status", "review"], body: "Body", error: null },
  );
  assert.deepEqual(parseFrontMatter("---\ntags: solo\n---\nBody"), {
    tags: ["solo"],
    dropped: [],
    body: "Body",
    error: null,
  });
  assert.deepEqual(parseFrontMatter("---\ntag: a, b\ntags: [b, 2024]\n---\nBody"), {
    tags: ["a", "b", "2024"],
    dropped: [],
    body: "Body",
    error: null,
  });
  assert.deepEqual(parseFrontMatter("---\ntags:\n  nested: map\n---\nBody"), {
    tags: [],
    dropped: ["tags"],
    body: "Body",
    error: null,
  });
});

test("parseFrontMatter: BOM and CRLF before the fence", () => {
  assert.deepEqual(parseFrontMatter("\uFEFF---\r\ntags:\r\n  - x\r\nstatus: done\r\n---\r\n\r\n# T\r\n"), {
    tags: ["x"],
    dropped: ["status"],
    body: "# T\r\n",
    error: null,
  });
});

test("parseFrontMatter: broken fences keep the original text", () => {
  const unclosed = "---\nstatus: draft\n\n# Title";
  assert.deepEqual(parseFrontMatter(unclosed), {
    tags: [],
    dropped: [],
    body: unclosed,
    error: "it has no closing ---",
  });
  const invalid = "---\nstatus: [draft\n---\nBody";
  assert.deepEqual(parseFrontMatter(invalid), {
    tags: [],
    dropped: [],
    body: invalid,
    error: "it isn't valid YAML",
  });
  const duplicate = "---\nstatus: a\nstatus: b\n---\nBody";
  assert.equal(parseFrontMatter(duplicate).error, "it isn't valid YAML");
});

test("parseFrontMatter: rules around plain markdown are not front matter", () => {
  for (const md of ["---\n\nText after a rule", "---\nJust a heading\n---\nBody", "---\n# H1\n---\nBody"]) {
    assert.deepEqual(parseFrontMatter(md), { tags: [], dropped: [], body: md, error: null });
  }
  assert.equal(startsWithFrontMatter("---\nstatus: draft\n---\nBody"), true);
  assert.equal(startsWithFrontMatter("Intro\n\n---\n\nAfter the rule"), false);
  assert.equal(startsWithFrontMatter("---\nJust a heading\n---\n"), false);
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
