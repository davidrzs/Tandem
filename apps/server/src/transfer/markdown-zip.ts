import path from "node:path";
import { isNode, isPair, isScalar, parseDocument, stringify, visit } from "yaml";

/**
 * Pure helpers for markdown-zip import/export (no I/O), so the tree layout,
 * front matter, and link rewriting are unit-testable on their own. The zip
 * shape mirrors Outline's export (collection folders, child docs nested in a
 * same-named folder, attachments beside the doc under `uploads/<id>/`), which
 * also happens to be what Obsidian-style vaults look like.
 */

const IMAGE_URL = /^\/api\/images\/([0-9a-f-]{36})$/i;
const DOC_URL = /^\/d\/([0-9a-f-]{36})$/i;
// Markdown link/image with a one-level balanced-paren destination, so Outline's
// `](Title%20(1).md)` doesn't truncate at the inner ')'.
const MD_LINK = /(!?)\[([^\]]*)\]\(((?:[^()]|\([^()]*\))*)\)/g;
const IMG_TAG = /<img\b[^>]*>/gi;
const WIKILINK = /\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g;

// ---------------------------------------------------------------------------
// filenames
// ---------------------------------------------------------------------------

/** Strip path-unsafe and control characters; never returns an empty name. */
export function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/[/\\:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/\.+$/, "")
    .trim();
  return cleaned || "Untitled";
}

/** Return `base`, or `base (n)` if already taken; records the choice. */
export function uniqueName(used: Set<string>, base: string): string {
  let name = base;
  let i = 0;
  while (used.has(name.toLowerCase())) name = `${base} (${++i})`;
  used.add(name.toLowerCase());
  return name;
}

/** URL-encode a relative zip path for a markdown link (parens included, so it
 * survives our own re-import and Outline's). */
export function encodeZipPath(p: string): string {
  return encodeURI(p).replace(/\(/g, "%28").replace(/\)/g, "%29");
}

// ---------------------------------------------------------------------------
// front matter + title
// ---------------------------------------------------------------------------

/** Keys a Tandem export writes for itself: they never name a field. */
export const TANDEM_ID_KEY = "tandem-id";
export const TANDEM_TYPE_KEY = "tandem-type";
const TAG_KEYS = ["tags", "tag"];

export const isReservedKey = (key: string) =>
  [...TAG_KEYS, TANDEM_ID_KEY, TANDEM_TYPE_KEY].includes(key.trim().toLowerCase());

/** YAML front matter in key order (lists in Obsidian dash-list form); empty
 * when there is nothing to write. */
export function emitFrontMatter(data: Record<string, unknown>): string {
  if (Object.keys(data).length === 0) return "";
  return `---\n${stringify(data, { lineWidth: 0 })}---\n\n`;
}

const FRONT_MATTER = /^\uFEFF?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)??---[ \t]*(?:\r?\n|$)(?:\r?\n)*/;
// An opening fence followed by content but never closed; a lone leading `---`
// followed by a blank line is just a horizontal rule.
const UNCLOSED_FENCE = /^\uFEFF?---[ \t]*\r?\n[ \t]*\S/;
const FRONT_MATTER_MAX_BYTES = 64 * 1024;
// Keys that reach an object's prototype or shadow its methods when assigned
// by name (`__proto__` replaces the prototype outright).
const PROTOTYPE_KEYS = new Set([...Object.getOwnPropertyNames(Object.prototype), "prototype"]);

type FrontMatterBlock =
  | { kind: "none" }
  | { kind: "broken"; reason: string }
  | { kind: "map"; data: Record<string, unknown>; hasComments: boolean; skipped: string[]; body: string };

/** A leading `---` block counts as front matter only when it is a YAML map (or
 * empty); other content between two rules is ordinary markdown. */
function readFrontMatter(md: string): FrontMatterBlock {
  const m = FRONT_MATTER.exec(md);
  if (!m) {
    return UNCLOSED_FENCE.test(md) ? { kind: "broken", reason: "it has no closing ---" } : { kind: "none" };
  }
  const block = m[1] ?? "";
  const body = md.slice(m[0].length);
  if (!block.trim()) return { kind: "map", data: {}, hasComments: false, skipped: [], body };
  if (Buffer.byteLength(block) > FRONT_MATTER_MAX_BYTES) return { kind: "broken", reason: "it is larger than 64 KiB" };
  const doc = parseDocument(block);
  if (doc.errors.length > 0) return { kind: "broken", reason: "it isn't valid YAML" };
  const skipped: string[] = [];
  visit(doc, {
    Pair(_key, pair, path) {
      const key = isScalar(pair.key) ? String(pair.key.value).trim() : null;
      if (key === null || !PROTOTYPE_KEYS.has(key)) return;
      const at = [...path.filter(isPair).map((p) => String(isScalar(p.key) ? p.key.value : p.key)), key];
      skipped.push(`${at.join(".")}: a key named "${key}" can't be imported`);
      return visit.REMOVE;
    },
  });
  let data: unknown;
  try {
    data = doc.toJS();
  } catch {
    return { kind: "broken", reason: "it isn't valid YAML" };
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) return { kind: "none" };
  let hasComments = !!(doc.commentBefore || doc.comment);
  visit(doc, (_key, node) => {
    if (isNode(node) && (node.comment || node.commentBefore)) hasComments = true;
  });
  return { kind: "map", data: data as Record<string, unknown>, hasComments, skipped, body };
}

/** True when markdown opens with a YAML front matter block. */
export function startsWithFrontMatter(md: string): boolean {
  return readFrontMatter(md).kind === "map";
}

export interface FrontMatter {
  tags: string[];
  /** Every other top-level key, with the value YAML gave it. */
  properties: Record<string, unknown>;
  /** What a Tandem export wrote for itself: the page's id and type name. */
  tandemId: string | null;
  typeName: string | null;
  /** The block had YAML comments, which properties can't keep. */
  hasComments: boolean;
  /** What the block held that isn't imported, and why. */
  skipped: string[];
  body: string;
  /** Why a leading `---` block couldn't be read; `body` is then the input as is. */
  error: string | null;
}

/** Split YAML front matter off a note: its tags (`tags:` or `tag:` in any
 * case, as a list, a comma-separated string or a number), the Tandem keys,
 * and every other key as a property. A reserved key never becomes a
 * property. MUST run before the body is parsed: unstripped front matter
 * parses as a rule and a heading. */
export function parseFrontMatter(md: string): FrontMatter {
  const block = readFrontMatter(md);
  const fm: FrontMatter = {
    tags: [],
    properties: {},
    tandemId: null,
    typeName: null,
    hasComments: false,
    skipped: [],
    body: md,
    error: block.kind === "broken" ? block.reason : null,
  };
  if (block.kind !== "map") return fm;
  const tags: string[] = [];
  fm.skipped.push(...block.skipped);
  for (const [key, value] of Object.entries(block.data)) {
    const k = key.trim().toLowerCase();
    if (TAG_KEYS.includes(k)) {
      const list = tagList(value);
      if (list) tags.push(...list);
      else fm.skipped.push(`${key}: ${JSON.stringify(value)} isn't a list of tags`);
    } else if (k === TANDEM_ID_KEY) fm.tandemId = typeof value === "string" ? value.trim() : null;
    else if (k === TANDEM_TYPE_KEY) fm.typeName = typeof value === "string" ? value.trim() || null : null;
    else fm.properties[key] = value;
  }
  return { ...fm, tags: [...new Set(tags)], hasComments: block.hasComments, body: block.body };
}

function tagList(value: unknown): string[] | null {
  if (value === null) return [];
  if (typeof value === "number") return [String(value)];
  const items = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : null;
  if (!items) return null;
  return items
    .filter((item) => typeof item === "string" || typeof item === "number")
    .map((item) => String(item).trim())
    .filter(Boolean);
}

/** Pull a leading `# Title` line off the body (Outline/Obsidian convention). */
export function splitLeadingH1(md: string): { title: string | null; body: string } {
  const m = /^\uFEFF?\s*# (.+?)\r?\n(?:\r?\n)?/.exec(md);
  if (!m) return { title: null, body: md };
  return { title: m[1]!.trim(), body: md.slice(m[0].length) };
}

/** Full export markdown for one document: front matter, H1 title, then body. */
export function composeExportDoc(input: {
  title: string;
  frontMatter: Record<string, unknown>;
  body: string;
}): string {
  const title = input.title.trim() || "Untitled";
  const body = input.body.replace(/^\n+/, "");
  return `${emitFrontMatter(input.frontMatter)}# ${title}\n\n${body}`.replace(/\s+$/, "") + "\n";
}

// ---------------------------------------------------------------------------
// export layout
// ---------------------------------------------------------------------------

export interface ExportDoc {
  id: string;
  title: string;
  children: ExportDoc[];
}
export interface ExportCollection {
  name: string;
  docs: ExportDoc[];
}

/** Assign every document an Outline-style path in the zip. Children live in a
 * folder named after their parent doc. Returns `docId -> "<Col>/<Title>.md"`. */
export function planExportLayout(collections: ExportCollection[]): Map<string, string> {
  const pathByDocId = new Map<string, string>();
  const usedRoots = new Set<string>();
  for (const col of collections) {
    const root = uniqueName(usedRoots, sanitizeFilename(col.name));
    placeDocs(col.docs, root, pathByDocId);
  }
  return pathByDocId;
}

function placeDocs(docs: ExportDoc[], dir: string, out: Map<string, string>) {
  const used = new Set<string>();
  for (const doc of docs) {
    const base = uniqueName(used, sanitizeFilename(doc.title || "Untitled"));
    out.set(doc.id, `${dir}/${base}.md`);
    if (doc.children.length) placeDocs(doc.children, `${dir}/${base}`, out);
  }
}

export interface ExportLinkOpts {
  docDir: string;
  /** Absolute zip path of a linked document, if it's inside this export. */
  resolveDocPath: (docId: string) => string | null;
  /** Doc-dir-relative path of an image already added to the zip, else null. */
  resolveImage: (imageId: string) => string | null;
}

/** Rewrite in-app links (`/d/<id>`, `/api/images/<id>`) to relative zip paths. */
export function rewriteExportLinks(md: string, opts: ExportLinkOpts): string {
  const relDoc = (target: string) => {
    const rel = path.posix.relative(opts.docDir, target);
    return encodeZipPath(rel.startsWith(".") ? rel : `./${rel}`);
  };

  let out = md.replace(IMG_TAG, (tag) => {
    const m = /src="\/api\/images\/([0-9a-f-]{36})"/i.exec(tag);
    const rel = m && opts.resolveImage(m[1]!);
    return rel ? tag.replace(m![0], `src="${encodeZipPath(rel)}"`) : tag;
  });

  out = out.replace(MD_LINK, (whole, bang, text, dest) => {
    const [url, ...tail] = String(dest).split(/\s+/);
    const suffix = tail.length ? ` ${tail.join(" ")}` : "";
    if (bang) {
      const im = IMAGE_URL.exec(url!);
      const rel = im && opts.resolveImage(im[1]!);
      return rel ? `![${text}](${encodeZipPath(rel)}${suffix})` : whole;
    }
    const dm = DOC_URL.exec(url!);
    const target = dm && opts.resolveDocPath(dm[1]!);
    return target ? `[${text}](${relDoc(target)}${suffix})` : whole;
  });
  return out;
}

// ---------------------------------------------------------------------------
// import classification
// ---------------------------------------------------------------------------

export interface ImportDoc {
  /** The `.md` entry path, or null for a folder that has no matching file. */
  mdPath: string | null;
  /** Filename-derived title (a leading H1 in the file overrides it later). */
  title: string;
  /** This doc's directory in the zip (where its relative links resolve from). */
  dir: string;
  children: ImportDoc[];
}
export interface ImportCollection {
  name: string;
  docs: ImportDoc[];
}

const JUNK = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$)/i;

/** Group zip entries into collections and a document tree. A folder with a
 * sibling `<name>.md` holds that doc's children; a folder without one becomes a
 * placeholder doc (Obsidian). Loose root `.md` files imply a single vault-style
 * collection; otherwise each top-level folder is its own collection. */
export function classifyImportEntries(
  paths: string[],
  rootCollectionName: string,
): { collections: ImportCollection[]; attachments: Set<string> } {
  const mdPaths: string[] = [];
  const attachments = new Set<string>();
  for (const p of paths) {
    if (JUNK.test(p) || p.endsWith("/")) continue;
    if (/\.md$/i.test(p)) mdPaths.push(p);
    else attachments.add(p);
  }

  const hasRootFile = mdPaths.some((p) => !p.includes("/"));
  const collections: ImportCollection[] = [];
  if (hasRootFile) {
    collections.push({ name: rootCollectionName, docs: buildDocTree(mdPaths, "") });
  } else {
    const byTop = new Map<string, string[]>();
    for (const p of mdPaths) {
      const top = p.slice(0, p.indexOf("/"));
      (byTop.get(top) ?? byTop.set(top, []).get(top)!).push(p);
    }
    for (const [name, ps] of [...byTop].sort((a, b) => a[0].localeCompare(b[0]))) {
      collections.push({ name, docs: buildDocTree(ps, name) });
    }
  }
  return { collections, attachments };
}

function buildDocTree(mdPaths: string[], dir: string): ImportDoc[] {
  const prefix = dir ? `${dir}/` : "";
  const files = new Map<string, string>(); // base name -> md path (direct file)
  const subdirs = new Map<string, string[]>(); // subdir name -> md paths under it
  for (const p of mdPaths) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) files.set(rest.replace(/\.md$/i, ""), p);
    else {
      const sub = rest.slice(0, slash);
      (subdirs.get(sub) ?? subdirs.set(sub, []).get(sub)!).push(p);
    }
  }

  const docs: ImportDoc[] = [];
  const consumed = new Set<string>();
  for (const [base, mdPath] of [...files].sort((a, b) => a[0].localeCompare(b[0]))) {
    const childDir = `${prefix}${base}`;
    const kids = subdirs.get(base);
    if (kids) consumed.add(base);
    docs.push({ mdPath, title: base, dir, children: kids ? buildDocTree(kids, childDir) : [] });
  }
  for (const [sub, ps] of [...subdirs].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (consumed.has(sub)) continue;
    docs.push({ mdPath: null, title: sub, dir, children: buildDocTree(ps, `${prefix}${sub}`) });
  }
  return docs;
}

// ---------------------------------------------------------------------------
// import link rewriting
// ---------------------------------------------------------------------------

/** Resolve a relative link/attachment against the doc's dir; null if absolute,
 * a protocol/anchor, or it escapes the zip root. */
export function resolveZipPath(docDir: string, rawUrl: string): string | null {
  let s = rawUrl.split("#")[0]!.trim();
  if (!s) return null;
  try {
    s = decodeURIComponent(s);
  } catch {
    /* keep raw on malformed escapes */
  }
  if (/^[a-z]+:/i.test(s) || s.startsWith("/")) return null;
  const joined = path.posix.normalize(path.posix.join(docDir, s));
  return joined.startsWith("..") ? null : joined;
}

export interface ImportLinkOpts {
  docDir: string;
  resolveDoc: (zipPath: string) => string | null; // -> document id
  resolveImage: (zipPath: string) => string | null; // -> /api/images/<id> url
  resolveWiki: (title: string) => string | null; // -> document id
  warn: (message: string) => void;
}

/** Rewrite relative markdown/wiki links to Tandem's in-app forms
 * (`[t](/d/<id>)`, `![a](/api/images/<id>)`). Unresolved targets are left
 * as-is with a warning. */
export function rewriteImportLinks(md: string, opts: ImportLinkOpts): string {
  let out = md.replace(WIKILINK, (whole, title, alias) => {
    const id = opts.resolveWiki(String(title).trim());
    if (!id) {
      opts.warn(`unresolved wikilink [[${title}]]`);
      return whole;
    }
    return `[${(alias ?? title).trim()}](/d/${id})`;
  });

  out = out.replace(IMG_TAG, (tag) => {
    const m = /src="([^"]+)"/i.exec(tag);
    if (!m) return tag;
    const zip = resolveZipPath(opts.docDir, m[1]!);
    const url = zip && opts.resolveImage(zip);
    return url ? tag.replace(m[0], `src="${url}"`) : tag;
  });

  out = out.replace(MD_LINK, (whole, bang, text, dest) => {
    const [rawUrl, ...tail] = String(dest).split(/\s+/);
    const suffix = tail.length ? ` ${tail.join(" ")}` : "";
    const zip = resolveZipPath(opts.docDir, rawUrl!);
    if (!zip) return whole; // absolute/external link — leave alone
    if (bang) {
      const url = opts.resolveImage(zip);
      if (url) return `![${text}](${url}${suffix})`;
      opts.warn(`missing image ${rawUrl}`);
      return whole;
    }
    if (!/\.md$/i.test(zip)) return whole;
    const id = opts.resolveDoc(zip);
    if (id) return `[${text}](/d/${id})`;
    opts.warn(`unresolved link ${rawUrl}`);
    return whole;
  });
  return out;
}
