import { randomUUID } from "node:crypto";
import path from "node:path";
import { strFromU8, unzipSync } from "fflate";
import type { Services } from "../services.js";
import { saveImageBytes } from "../images.js";
import {
  classifyImportEntries,
  parseFrontMatter,
  resolveZipPath,
  rewriteImportLinks,
  sanitizeFilename,
  splitLeadingH1,
  type ImportDoc,
} from "./markdown-zip.js";

const MAX_ENTRIES = 5000;
const MAX_UNCOMPRESSED = 500 * 1024 * 1024;

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

/**
 * Import a markdown zip (Outline export or Obsidian-style vault) into a
 * workspace. Two passes so links resolve and blame stays clean: create every
 * document title-only, then write each body as a single attributed edit by the
 * importer, rewriting relative links/images to Tandem's in-app forms. Not
 * atomic — a per-item failure is recorded and skipped, and what succeeded
 * stays.
 */
export async function importZip(
  services: Services,
  input: { workspaceId: string; uid: string; zipName: string; buffer: Buffer },
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
  const summary: ImportSummary = { collections: 0, documents: 0, images: 0, warnings };

  const docIdByPath = new Map<string, string>(); // normalized md path -> doc id
  const docIdByTitle = new Map<string, string | null>(); // lower title -> id (null = ambiguous)
  const imageUrlByPath = new Map<string, string | null>(); // attachment path -> /api/images url
  const bodyTasks: Array<{ docId: string; docDir: string; body: string }> = [];

  const readMd = (mdPath: string) => {
    const bytes = entries.get(path.posix.normalize(mdPath));
    return bytes ? strFromU8(bytes) : "";
  };

  // Phase 1: create every document (title + tags only), parents before children.
  const createTree = async (docs: ImportDoc[], collectionId: string, parentId: string | null) => {
    for (const d of docs) {
      let title = d.title;
      let tags: string[] = [];
      let body = "";
      if (d.mdPath) {
        const fm = parseFrontMatter(readMd(d.mdPath));
        tags = fm.tags;
        const h1 = splitLeadingH1(fm.body);
        title = h1.title ?? d.title;
        body = h1.body;
      }
      let docId: string;
      try {
        const created = await services.documents.create({
          collectionId,
          parentDocumentId: parentId ?? undefined,
          title,
          tags,
        });
        docId = created.id;
      } catch (err) {
        warnings.push(`Couldn't create "${title}": ${err instanceof Error ? err.message : "error"}`);
        continue;
      }
      summary.documents++;
      if (d.mdPath) {
        docIdByPath.set(path.posix.normalize(d.mdPath), docId);
        const key = title.toLowerCase();
        docIdByTitle.set(key, docIdByTitle.has(key) ? null : docId);
        bodyTasks.push({ docId, docDir: d.dir, body });
      }
      await createTree(d.children, collectionId, docId);
    }
  };

  for (const col of collections) {
    let collectionId: string;
    try {
      const created = await services.collections.create({
        workspaceId: input.workspaceId,
        name: col.name,
        slug: slugify(col.name),
      });
      collectionId = created.id;
    } catch (err) {
      warnings.push(`Couldn't create collection "${col.name}": ${err instanceof Error ? err.message : "error"}`);
      continue;
    }
    summary.collections++;
    await createTree(col.docs, collectionId, null);
  }

  const uploadAttachment = async (zipPath: string): Promise<string | null> => {
    const bytes = entries.get(zipPath);
    if (!bytes) return null;
    const ext = zipPath.split(".").pop()?.toLowerCase() ?? "";
    const mime = MIME_BY_EXT[ext];
    if (!mime) {
      warnings.push(`Skipped unsupported attachment ${path.posix.basename(zipPath)}`);
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

  // Phase 2: bodies. Pre-upload each doc's images (rewrite callbacks are sync),
  // then rewrite links and write the body as one attributed edit.
  for (const task of bodyTasks) {
    for (const rawUrl of collectImageRefs(task.body)) {
      const zip = resolveZipPath(task.docDir, rawUrl);
      if (!zip || imageUrlByPath.has(zip)) continue;
      imageUrlByPath.set(zip, attachments.has(zip) ? await uploadAttachment(zip) : null);
    }
    const body = rewriteImportLinks(task.body, {
      docDir: task.docDir,
      resolveDoc: (zip) => docIdByPath.get(path.posix.normalize(zip)) ?? null,
      resolveImage: (zip) => imageUrlByPath.get(zip) ?? null,
      resolveWiki: (title) => docIdByTitle.get(title.toLowerCase()) ?? null,
      warn: (m) => warnings.push(m),
    });
    if (body.trim()) {
      try {
        await services.documents.editBody(task.docId, () => body);
      } catch (err) {
        warnings.push(`Couldn't write body: ${err instanceof Error ? err.message : "error"}`);
      }
    }
  }

  return summary;
}
