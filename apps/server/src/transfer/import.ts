import { randomUUID } from "node:crypto";
import path from "node:path";
import { strFromU8, unzipSync } from "fflate";
import type { Document } from "@tandem/db";
import type { CollabWriter } from "../collab-writer.js";
import type { Services } from "../services.js";
import { saveImageBytes } from "../images.js";
import {
  classifyImportEntries,
  parseFrontMatter,
  resolveZipPath,
  rewriteImportLinks,
  sanitizeFilename,
  splitLeadingH1,
  type FrontMatter,
  type ImportDoc,
} from "./markdown-zip.js";
import { ImportFields, parseSidecar, SIDECAR_PATH } from "./properties-yaml.js";

const MAX_ENTRIES = 5000;
const MAX_UNCOMPRESSED = 500 * 1024 * 1024;
// Per-attachment cap, matching the interactive image upload route.
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
};

export class ImportError extends Error {}

export interface ImportSummary {
  collections: number;
  documents: number;
  images: number;
  warnings: string[];
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${base || "imported"}-${randomUUID().slice(0, 8)}`;
}

function collectImageRefs(md: string): string[] {
  const urls: string[] = [];
  for (const m of md.matchAll(/!\[[^\]]*\]\(((?:[^()]|\([^()]*\))*)\)/g)) {
    urls.push(m[1]!.split(/\s+/)[0]!);
  }
  for (const m of md.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/gi)) urls.push(m[1]!);
  return urls;
}

/** Writes a property patch through the live doc, so a re-import merges with
 * whoever has the page open instead of racing their editor. */
export type PropertyWriter = Pick<CollabWriter, "setProperties">;

/**
 * Import a markdown zip (a nested wiki export or Obsidian-style vault) into a
 * workspace. Every note is read first, so property kinds are inferred across
 * the whole vault. Then two passes so links resolve and blame stays clean:
 * create every document title-only, then write each page's properties as a
 * per-field patch and its body as a single attributed edit by the importer,
 * rewriting relative links/images to Tandem's in-app forms. A note whose
 * `tandem-id` is already a page in this workspace (a re-imported export)
 * updates that page's properties instead of creating a copy. Not atomic — a
 * per-item failure is recorded and skipped, and what succeeded stays.
 */
export async function importZip(
  services: Services,
  input: { workspaceId: string; uid: string; zipName: string; buffer: Buffer; writer?: PropertyWriter },
): Promise<ImportSummary> {
  let count = 0;
  let total = 0;
  let raw: Record<string, Uint8Array>;
  try {
    raw = unzipSync(new Uint8Array(input.buffer), {
      filter: (file) => {
        if (++count > MAX_ENTRIES) throw new ImportError("The archive has too many files.");
        total += file.originalSize;
        if (total > MAX_UNCOMPRESSED) throw new ImportError("The archive is too large.");
        return true;
      },
    });
  } catch (err) {
    if (err instanceof ImportError) throw err;
    throw new ImportError("That file isn't a valid zip archive.");
  }

  // Normalize every path once so lookups match regardless of `./` noise.
  const entries = new Map<string, Uint8Array>();
  for (const [k, v] of Object.entries(raw)) entries.set(path.posix.normalize(k), v);

  const rootName = sanitizeFilename(input.zipName.replace(/\.zip$/i, "")) || "Imported";
  const { collections, attachments } = classifyImportEntries([...entries.keys()], rootName);

  const warnings: string[] = [];
  const warn = (message: string) => warnings.push(message);
  const summary: ImportSummary = { collections: 0, documents: 0, images: 0, warnings };

  const docIdByPath = new Map<string, string>(); // normalized md path -> doc id
  const docIdByTitle = new Map<string, string | null>(); // lower title -> id (null = ambiguous)
  const imageUrlByPath = new Map<string, string | null>(); // attachment path -> /api/images url
  const tasks: Array<{
    docId: string;
    mdPath: string;
    docDir: string;
    /** Null for a page that was already here: its body is left as it is. */
    body: string | null;
    typeId: string | null;
    /** The existing page's properties, which the note's are diffed against. */
    current: Record<string, unknown> | null;
    properties: Record<string, unknown>;
  }> = [];

  const readMd = (mdPath: string) => {
    const bytes = entries.get(path.posix.normalize(mdPath));
    return bytes ? strFromU8(bytes) : "";
  };
  const register = (mdPath: string, docId: string, title: string) => {
    docIdByPath.set(path.posix.normalize(mdPath), docId);
    const key = title.toLowerCase();
    docIdByTitle.set(key, docIdByTitle.has(key) ? null : docId);
  };

  const notes = new Map<string, FrontMatter>();
  const walk = (docs: ImportDoc[]): ImportDoc[] => docs.flatMap((d) => [d, ...walk(d.children)]);
  for (const d of collections.flatMap((c) => walk(c.docs))) {
    if (!d.mdPath) continue;
    const fm = parseFrontMatter(readMd(d.mdPath));
    if (fm.error) warn(`Kept the front matter of ${d.mdPath} as text: ${fm.error}`);
    notes.set(d.mdPath, fm);
  }

  const existing = new Map<string, Document>(); // md path -> the page it already is
  for (const [mdPath, fm] of notes) {
    if (!fm.tandemId || !UUID.test(fm.tandemId)) continue;
    if ([...existing.values()].some((doc) => doc.id === fm.tandemId)) continue;
    const doc = await services.documents.get(fm.tandemId);
    if (doc?.workspaceId === input.workspaceId) existing.set(mdPath, doc);
  }

  const sidecarBytes = entries.get(SIDECAR_PATH);
  const sidecar = sidecarBytes ? parseSidecar(strFromU8(sidecarBytes)) : null;
  if (sidecarBytes && !sidecar) warn(`Ignored ${SIDECAR_PATH}: it isn't a field list this version can read.`);
  const fields = await ImportFields.load(
    services.types,
    input.workspaceId,
    sidecar,
    [...notes.values()].map((fm) => fm.properties),
    warn,
  );

  // A collection is created with its first new page, so a re-imported export
  // whose pages are all here already adds no empty collection.
  const lazyCollection = (name: string) => {
    let id: Promise<string | null> | undefined;
    return () =>
      (id ??= services.collections
        .create({ workspaceId: input.workspaceId, name, slug: slugify(name) })
        .then(
          (created) => {
            summary.collections++;
            return created.id;
          },
          (err) => {
            warn(`Couldn't create collection "${name}": ${err instanceof Error ? err.message : "error"}`);
            return null;
          },
        ));
  };

  // Phase 1: create every new document (title, tags, type), parents before children.
  const createTree = async (
    docs: ImportDoc[],
    collectionId: () => Promise<string | null>,
    parentId: string | null,
  ) => {
    for (const d of docs) {
      const note = d.mdPath ? notes.get(d.mdPath) : undefined;
      const page = d.mdPath ? existing.get(d.mdPath) : undefined;
      if (d.mdPath && note && page) {
        register(d.mdPath, page.id, page.title);
        tasks.push({
          docId: page.id,
          mdPath: d.mdPath,
          docDir: d.dir,
          body: null,
          typeId: page.typeId,
          current: page.properties,
          properties: note.properties,
        });
        await createTree(d.children, async () => page.collectionId, page.id);
        continue;
      }
      const h1 = splitLeadingH1(note?.body ?? "");
      const title = h1.title ?? d.title;
      const col = await collectionId();
      if (!col) continue;
      const typeId = note?.typeName ? await fields.typeId(note.typeName) : null;
      let docId: string;
      try {
        const created = await services.documents.create({
          collectionId: col,
          parentDocumentId: parentId ?? undefined,
          title,
          tags: note?.tags ?? [],
          typeId,
        });
        docId = created.id;
      } catch (err) {
        warn(`Couldn't create "${title}": ${err instanceof Error ? err.message : "error"}`);
        continue;
      }
      summary.documents++;
      if (d.mdPath && note) {
        register(d.mdPath, docId, title);
        tasks.push({
          docId,
          mdPath: d.mdPath,
          docDir: d.dir,
          body: h1.body,
          typeId,
          current: null,
          properties: note.properties,
        });
      }
      await createTree(d.children, collectionId, docId);
    }
  };

  for (const col of collections) await createTree(col.docs, lazyCollection(col.name), null);

  const uploadAttachment = async (zipPath: string): Promise<string | null> => {
    const bytes = entries.get(zipPath);
    if (!bytes) return null;
    const ext = zipPath.split(".").pop()?.toLowerCase() ?? "";
    const mime = MIME_BY_EXT[ext];
    if (!mime) {
      warnings.push(`Skipped unsupported attachment ${path.posix.basename(zipPath)}`);
      return null;
    }
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      warnings.push(`Skipped ${path.posix.basename(zipPath)} — larger than 25MB`);
      return null;
    }
    const id = await saveImageBytes(services, {
      workspaceId: input.workspaceId,
      uploadedBy: input.uid,
      mime,
      bytes: Buffer.from(bytes),
    });
    summary.images++;
    return `/api/images/${id}`;
  };

  const resolveWiki = (title: string) => docIdByTitle.get(title.toLowerCase()) ?? null;

  // Phase 2: properties, then bodies. Pre-upload each doc's images (rewrite
  // callbacks are sync), then rewrite links and write the body as one
  // attributed edit.
  for (const task of tasks) {
    const ops =
      task.current || Object.keys(task.properties).length > 0
        ? await fields.patch({ typeId: task.typeId, current: task.current }, task.properties, resolveWiki, task.mdPath)
        : [];
    if (ops.length > 0) {
      try {
        if (task.current && input.writer) await input.writer.setProperties(task.docId, ops);
        else await services.documents.editProperties(task.docId, ops);
      } catch (err) {
        warn(`Couldn't write the properties of ${task.mdPath}: ${err instanceof Error ? err.message : "error"}`);
      }
    }
    if (task.body === null) continue;
    for (const rawUrl of collectImageRefs(task.body)) {
      const zip = resolveZipPath(task.docDir, rawUrl);
      if (!zip || imageUrlByPath.has(zip)) continue;
      imageUrlByPath.set(zip, attachments.has(zip) ? await uploadAttachment(zip) : null);
    }
    const body = rewriteImportLinks(task.body, {
      docDir: task.docDir,
      resolveDoc: (zip) => docIdByPath.get(path.posix.normalize(zip)) ?? null,
      resolveImage: (zip) => imageUrlByPath.get(zip) ?? null,
      resolveWiki,
      warn,
    });
    if (body.trim()) {
      try {
        await services.documents.editBody(task.docId, () => body);
      } catch (err) {
        warn(`Couldn't write body: ${err instanceof Error ? err.message : "error"}`);
      }
    }
  }

  const commented = [...notes].filter(([, fm]) => fm.hasComments).map(([mdPath]) => mdPath);
  if (commented.length > 0) {
    warn(`Front matter became properties, so YAML comments and formatting weren't kept in ${commented.join(", ")}`);
  }
  if (existing.size > 0) {
    warn(
      `${existing.size === 1 ? "1 page was" : `${existing.size} pages were`} already in this workspace ` +
        "(matched by tandem-id): updated their properties and left their titles, tags and bodies as they are.",
    );
  }

  return summary;
}
