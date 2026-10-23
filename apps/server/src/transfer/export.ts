import path from "node:path";
import { strToU8, zipSync } from "fflate";
import type { DocumentNode } from "@tandem/core";
import type { Services } from "../services.js";
import { readImageBytes } from "../images.js";
import {
  composeExportDoc,
  isReservedKey,
  planExportLayout,
  rewriteExportLinks,
  type ExportCollection,
  type ExportDoc,
} from "./markdown-zip.js";
import { buildSidecar, exportFrontMatter, SIDECAR_PATH } from "./properties-yaml.js";

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

function toExportDocs(nodes: DocumentNode[], titles: Map<string, string>): ExportDoc[] {
  return nodes.map((n) => {
    titles.set(n.id, n.title);
    return { id: n.id, title: n.title, children: toExportDocs(n.children, titles) };
  });
}

export interface ExportResult {
  filename: string;
  buffer: Uint8Array;
  warnings: string[];
}

/**
 * Build a markdown zip for one collection or a whole workspace, in a conventional
 * nested-wiki layout — folders of markdown (so it re-imports into Tandem and
 * similar tools). Properties are front matter, and `_tandem/fields.json`
 * describes the types and fields so a re-import keeps their kinds and
 * options. RLS-scoped: the caller can
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
  const titles = new Map<string, string>();
  for (const col of chosen) {
    const tree = await services.documentTree.tree(col.id);
    collections.push({ name: col.name, docs: toExportDocs(tree, titles) });
  }
  const pathByDocId = planExportLayout(collections);

  const files: Record<string, Uint8Array> = {};
  const warnings: string[] = [];

  const workspaceId = chosen[0]!.workspaceId;
  const [types, fields] = await Promise.all([
    services.types.listTypes(workspaceId),
    services.types.listFields(workspaceId),
  ]);
  const typeNames = new Map(types.map((t) => [t.id, t.name]));
  if (fields.length > 0 || types.length > 0) {
    files[SIDECAR_PATH] = strToU8(`${JSON.stringify(buildSidecar(types, fields), null, 2)}\n`);
  }
  for (const f of fields.filter((f) => isReservedKey(f.key))) {
    warnings.push(`Values of the field "${f.key}" aren't in the export: front matter uses that key for itself.`);
  }
  const refKinds = new Set(fields.filter((f) => f.kind === "doc" || f.kind === "doc_list").map((f) => f.id));

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
    // Pages outside the export still export as [[Title]].
    const unknownRefs = Object.entries(doc.properties)
      .filter(([fieldId]) => refKinds.has(fieldId))
      .flatMap(([, v]) => [v].flat())
      .filter((id): id is string => typeof id === "string" && !titles.has(id));
    for (const meta of await services.documents.getMetaMany([...new Set(unknownRefs)])) {
      titles.set(meta.id, meta.title);
    }
    const frontMatter = exportFrontMatter(
      { ...doc, typeName: doc.typeId ? (typeNames.get(doc.typeId) ?? null) : null },
      fields,
      (id) => titles.get(id) ?? null,
    );
    files[zipPath] = strToU8(composeExportDoc({ title: doc.title, frontMatter, body }));
  }

  return {
    filename: `${name}-export.zip`,
    buffer: zipSync(files, { level: 6 }),
    warnings,
  };
}
