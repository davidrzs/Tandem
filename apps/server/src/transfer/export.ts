import path from "node:path";
import { strToU8, zipSync } from "fflate";
import type { DocumentNode } from "@tandem/core";
import type { Services } from "../services.js";
import { readImageBytes } from "../images.js";
import {
  composeExportDoc,
  planExportLayout,
  rewriteExportLinks,
  type ExportCollection,
  type ExportDoc,
} from "./markdown-zip.js";

// Raster only — SVG is never stored (rejected on upload, skipped on import),
// so it must never end up in an export either.
const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
};

const IMAGE_ID = /\/api\/images\/([0-9a-f-]{36})/gi;

function toExportDocs(nodes: DocumentNode[]): ExportDoc[] {
  return nodes.map((n) => ({ id: n.id, title: n.title, children: toExportDocs(n.children) }));
}

export interface ExportResult {
  filename: string;
  buffer: Uint8Array;
  warnings: string[];
}

/**
 * Build a markdown zip for one collection or a whole workspace, in Outline's
 * layout (so it re-imports into Outline or Tandem). RLS-scoped: the caller can
 * only export what they can read. Missing/foreign images are skipped with a
 * warning rather than failing the export.
 */
export async function buildExportZip(
  services: Services,
  target: { collectionId?: string; workspaceId?: string },
  name: string,
): Promise<ExportResult> {
  const all = await services.collections.list();
  const chosen = target.collectionId
    ? all.filter((c) => c.id === target.collectionId)
    : all.filter((c) => c.workspaceId === target.workspaceId);
  if (chosen.length === 0) return { filename: "", buffer: new Uint8Array(), warnings: [] };

  // Plan the whole layout first so cross-document links resolve to real paths.
  const collections: ExportCollection[] = [];
  for (const col of chosen) {
    const tree = await services.documents.tree(col.id);
    collections.push({ name: col.name, docs: toExportDocs(tree) });
  }
  const pathByDocId = planExportLayout(collections);

  const files: Record<string, Uint8Array> = {};
  const warnings: string[] = [];

  for (const [docId, zipPath] of pathByDocId) {
    const doc = await services.documents.get(docId);
    if (!doc) continue;
    const docDir = path.posix.dirname(zipPath);

    // Pre-fetch every referenced image (the rewriter's callbacks are sync).
    const imageRel = new Map<string, string | null>();
    for (const m of doc.contentMd.matchAll(IMAGE_ID)) {
      const id = m[1]!;
      if (imageRel.has(id)) continue;
      const row = await services.images.get(id);
      const bytes = row && (await readImageBytes(id));
      if (!row || !bytes) {
        imageRel.set(id, null);
        warnings.push(`image ${id} in "${doc.title || "Untitled"}" is unavailable — link left as-is`);
        continue;
      }
      const rel = `uploads/${id}/image.${EXT[row.mime] ?? "bin"}`;
      files[path.posix.join(docDir, rel)] = new Uint8Array(bytes);
      imageRel.set(id, rel);
    }

    const body = rewriteExportLinks(doc.contentMd, {
      docDir,
      resolveDocPath: (id) => pathByDocId.get(id) ?? null,
      resolveImage: (id) => imageRel.get(id) ?? null,
    });
    files[zipPath] = strToU8(composeExportDoc({ title: doc.title, tags: doc.tags, body }));
  }

  return {
    filename: `${name}-export.zip`,
    buffer: zipSync(files, { level: 6 }),
    warnings,
  };
}
