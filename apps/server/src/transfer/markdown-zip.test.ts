import assert from "node:assert/strict";
import { test } from "node:test";
import type { FieldKind } from "@tandem/db";
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
import { exportFrontMatter } from "./properties-yaml.js";

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

const plain = { properties: {}, tandemId: null, typeName: null, hasComments: false, skipped: [] };

test("front matter emits a dash-list and parses both forms", () => {
  assert.equal(emitFrontMatter({}), "");
  assert.equal(emitFrontMatter({ tags: ["a", "b"] }), "---\ntags:\n  - a\n  - b\n---\n\n");
  assert.equal(emitFrontMatter({ tags: ["#x", "a: b"] }), '---\ntags:\n  - "#x"\n  - "a: b"\n---\n\n');
  assert.deepEqual(parseFrontMatter(emitFrontMatter({ tags: ["#x", "a: b"] })).tags, ["#x", "a: b"]);
  assert.deepEqual(parseFrontMatter("---\ntags:\n  - x\n  - y\n---\n\nBody").tags, ["x", "y"]);
  assert.deepEqual(parseFrontMatter("---\ntags: [p, 'q r']\n---\nBody").tags, ["p", "q r"]);
  const none = parseFrontMatter("No front matter here");
  assert.deepEqual(none, { ...plain, tags: [], body: "No front matter here", error: null });
  assert.equal(parseFrontMatter("---\ntags:\n  - x\n---\n\nHello").body, "Hello");
});

test("parseFrontMatter keeps every other key as a property, as YAML typed it", () => {
  assert.deepEqual(
    parseFrontMatter(
      '---\nstatus: draft\ntags:\n  - "q: r"\n  - plain\nreview:\n  owner: ana\n  due: 2026-01-02\nversion: "1.10"\nrelease: 1.10\nshipped: no\n---\n\nBody',
    ),
    {
      ...plain,
      tags: ["q: r", "plain"],
      properties: {
        status: "draft",
        review: { owner: "ana", due: "2026-01-02" },
        version: "1.10",
        release: 1.1,
        shipped: "no",
      },
      body: "Body",
      error: null,
    },
  );
  assert.deepEqual(parseFrontMatter("---\ntags: solo\n---\nBody"), {
    ...plain,
    tags: ["solo"],
    body: "Body",
    error: null,
  });
  assert.deepEqual(parseFrontMatter("---\ntag: a, b\ntags: [b, 2024]\n---\nBody"), {
    ...plain,
    tags: ["a", "b", "2024"],
    body: "Body",
    error: null,
  });
  assert.deepEqual(parseFrontMatter("---\ntags:\n  nested: map\n---\nBody"), {
    ...plain,
    tags: [],
    skipped: ['tags: {"nested":"map"} isn\'t a list of tags'],
    body: "Body",
    error: null,
  });
});

test("parseFrontMatter reads reserved keys in any case", () => {
  assert.deepEqual(
    parseFrontMatter(
      "---\nTags: [capital-tag]\ntags: 5\nTAG: loud\nTandem-Id: 0b6c3f9e-1d2a-4c5b-8e7f-9a0b1c2d3e4f\nTANDEM-TYPE: Ghost\nstatus: ok\n---\nBody",
    ),
    {
      ...plain,
      tags: ["capital-tag", "5", "loud"],
      properties: { status: "ok" },
      tandemId: "0b6c3f9e-1d2a-4c5b-8e7f-9a0b1c2d3e4f",
      typeName: "Ghost",
      body: "Body",
      error: null,
    },
  );
});

test("parseFrontMatter reads a Tandem export's own keys and notices comments", () => {
  assert.deepEqual(
    parseFrontMatter(
      "---\n# agenda first\ntandem-id: 0b6c3f9e-1d2a-4c5b-8e7f-9a0b1c2d3e4f\ntandem-type: Meeting\nstatus: Done # was Todo\n---\nBody",
    ),
    {
      tags: [],
      properties: { status: "Done" },
      tandemId: "0b6c3f9e-1d2a-4c5b-8e7f-9a0b1c2d3e4f",
      typeName: "Meeting",
      hasComments: true,
      skipped: [],
      body: "Body",
      error: null,
    },
  );
  assert.equal(parseFrontMatter('---\nstatus: "#1 # not a comment"\n---\nBody').hasComments, false);
});

test("parseFrontMatter: BOM and CRLF before the fence", () => {
  assert.deepEqual(parseFrontMatter("\uFEFF---\r\ntags:\r\n  - x\r\nstatus: done\r\n---\r\n\r\n# T\r\n"), {
    ...plain,
    tags: ["x"],
    properties: { status: "done" },
    body: "# T\r\n",
    error: null,
  });
});

test("parseFrontMatter: broken fences keep the original text", () => {
  const unclosed = "---\nstatus: draft\n\n# Title";
  assert.deepEqual(parseFrontMatter(unclosed), {
    ...plain,
    tags: [],
    body: unclosed,
    error: "it has no closing ---",
  });
  const invalid = "---\nstatus: [draft\n---\nBody";
  assert.deepEqual(parseFrontMatter(invalid), {
    ...plain,
    tags: [],
    body: invalid,
    error: "it isn't valid YAML",
  });
  const duplicate = "---\nstatus: a\nstatus: b\n---\nBody";
  assert.equal(parseFrontMatter(duplicate).error, "it isn't valid YAML");
});

test("parseFrontMatter: an alias bomb or an oversized block is broken, not a crash", () => {
  const levels = ["a: &a [x, x, x, x, x, x, x, x, x]"];
  for (let i = 1; i < 10; i++) {
    const prev = String.fromCharCode(96 + i);
    const next = String.fromCharCode(97 + i);
    levels.push(`${next}: &${next} [*${prev}, *${prev}, *${prev}, *${prev}, *${prev}, *${prev}, *${prev}, *${prev}, *${prev}]`);
  }
  const bomb = `---\n${levels.join("\n")}\n---\nBody`;
  assert.deepEqual(parseFrontMatter(bomb), { ...plain, tags: [], body: bomb, error: "it isn't valid YAML" });
  assert.equal(startsWithFrontMatter(bomb), false);
  const huge = `---\nnote: ${"x".repeat(64 * 1024)}\n---\nBody`;
  assert.equal(parseFrontMatter(huge).error, "it is larger than 64 KiB");
  assert.equal(parseFrontMatter(`---\nnote: ${"x".repeat(60 * 1024)}\n---\nBody`).error, null);
});

test("parseFrontMatter: rules around plain markdown are not front matter", () => {
  for (const md of ["---\n\nText after a rule", "---\nJust a heading\n---\nBody", "---\n# H1\n---\nBody"]) {
    assert.deepEqual(parseFrontMatter(md), { ...plain, tags: [], body: md, error: null });
  }
  assert.equal(startsWithFrontMatter("---\nstatus: draft\n---\nBody"), true);
  assert.equal(startsWithFrontMatter("Intro\n\n---\n\nAfter the rule"), false);
  assert.equal(startsWithFrontMatter("---\nJust a heading\n---\n"), false);
});

test("splitLeadingH1 pulls the title; composeExportDoc reassembles", () => {
  assert.deepEqual(splitLeadingH1("# Title\n\nBody here"), { title: "Title", body: "Body here" });
  assert.deepEqual(splitLeadingH1("No heading"), { title: null, body: "No heading" });
  assert.equal(
    composeExportDoc({ title: "My Doc", frontMatter: { tags: ["t"] }, body: "Content." }),
    "---\ntags:\n  - t\n---\n\n# My Doc\n\nContent.\n",
  );
});

test("a Meeting page exports its values as front matter in type field order", () => {
  const field = (id: string, key: string, kind: FieldKind, typeName: string | null, options: string[] = []) => ({
    id,
    workspaceId: "w",
    typeId: typeName ? "t-meeting" : null,
    typeName,
    key,
    label: key,
    kind,
    position: 0,
    options: options.map((label, i) => ({ id: `${id}-o${i}`, label })),
    retired: false,
    aliases: [],
  });
  const fields = [
    field("f-date", "date", "date", "Meeting"),
    field("f-status", "status", "select", "Meeting", ["Todo", "Done"]),
    field("f-attendees", "attendees", "doc_list", "Meeting"),
    field("f-room", "room", "text", "Meeting"),
    field("f-version", "version", "text", null),
    field("f-budget", "budget", "number", null),
    field("f-areas", "areas", "multi_select", null, ["Ops", "Sales"]),
  ];
  const titles: Record<string, string> = { "d-ana": "Ana", "d-bo": "Bo: notes" };
  const frontMatter = exportFrontMatter(
    {
      id: "d-standup",
      typeId: "t-meeting",
      typeName: "Meeting",
      tags: ["daily"],
      properties: {
        "f-version": "1.10",
        "f-status": "f-status-o1",
        "f-areas": ["f-areas-o1", "f-areas-o0"],
        "f-date": "2026-10-22",
        "f-attendees": ["d-ana", "d-bo", "d-gone"],
        "f-budget": 1200,
      },
    },
    fields,
    (id) => titles[id] ?? null,
  );
  assert.equal(
    composeExportDoc({ title: "Standup", frontMatter, body: "Notes." }),
    [
      "---",
      "tandem-id: d-standup",
      "tandem-type: Meeting",
      "date: 2026-10-22",
      "status: Done",
      "attendees:",
      '  - "[[Ana]]"',
      '  - "[[Bo: notes]]"',
      "areas:",
      "  - Sales",
      "  - Ops",
      "budget: 1200",
      'version: "1.10"',
      "tags:",
      "  - daily",
      "---",
      "",
      "# Standup",
      "",
      "Notes.",
      "",
    ].join("\n"),
  );
  const untyped = { id: "d-plain", typeId: null, typeName: null, tags: ["x"], properties: {} };
  assert.deepEqual(exportFrontMatter(untyped, fields, () => null), { "tandem-id": "d-plain", tags: ["x"] });
  assert.deepEqual(exportFrontMatter(untyped, [], () => null), { tags: ["x"] });
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
