import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { fromNodeHeaders } from "better-auth/node";
import type { Database } from "@tandem/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Auth } from "./auth.js";
import { createServices, type Services } from "./services.js";

const MAX_BYTES = 25 * 1024 * 1024;
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Local disk dir for image bytes (UPLOADS_DIR; a mounted volume in prod). */
export function uploadsDir(): string {
  const dir = process.env.UPLOADS_DIR ?? ".uploads";
  return isAbsolute(dir) ? dir : resolve(REPO_ROOT, dir);
}

/** Persist raw image bytes as a new workspace-scoped image, returning its id.
 * Shared by the upload route and the zip importer. Caller vets the mime. */
export async function saveImageBytes(
  services: Services,
  input: { workspaceId: string; uploadedBy: string; mime: string; bytes: Buffer },
): Promise<string> {
  const dir = uploadsDir();
  await mkdir(dir, { recursive: true });
  const image = await services.images.create({
    workspaceId: input.workspaceId,
    uploadedBy: input.uploadedBy,
    mime: input.mime,
    size: input.bytes.length,
  });
  await writeFile(join(dir, image.id), input.bytes);
  return image.id;
}

/** Read an image's bytes off disk (null if missing) — for export. Access is
 * gated by the caller having already resolved the row under RLS. */
export async function readImageBytes(id: string): Promise<Buffer | null> {
  try {
    return await readFile(join(uploadsDir(), id));
  } catch {
    return null;
  }
}

/**
 * Image upload + private serving. Bytes live on local disk; both routes require
 * a session and are workspace-scoped (RLS), so images are never public.
 */
export async function registerImageRoutes(app: FastifyInstance, db: Database, auth: Auth) {
  const dir = uploadsDir();
  await mkdir(dir, { recursive: true });

  const userId = async (req: FastifyRequest): Promise<string | null> => {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    return session?.user.id ?? null;
  };

  // Upload an image attached to a document's workspace.
  app.post("/api/images", async (req, reply) => {
    const uid = await userId(req);
    if (!uid) return reply.code(401).send({ error: "unauthorized" });

    const documentId = (req.query as { documentId?: string }).documentId;
    if (!documentId) return reply.code(400).send({ error: "documentId required" });

    const services = createServices(db, { kind: "user", userId: uid });
    const doc = await services.documents.getMeta(documentId);
    if (!doc) return reply.code(404).send({ error: "document not found" });

    const file = await req.file({ limits: { fileSize: MAX_BYTES } });
    if (!file) return reply.code(400).send({ error: "no file" });
    // SVG is a script container, not a picture — served same-origin it could
    // run in the app's session. Raster formats only.
    if (!file.mimetype.startsWith("image/") || file.mimetype === "image/svg+xml") {
      return reply.code(415).send({ error: "not a supported image type" });
    }

    // Stream to a temp file, then commit under the DB-assigned id.
    const tmp = join(dir, `tmp-${randomUUID()}`);
    try {
      await pipeline(file.file, createWriteStream(tmp));
      if (file.file.truncated) {
        return reply.code(413).send({ error: "image exceeds 25MB" });
      }
      const { size } = await stat(tmp);
      const image = await services.images.create({
        workspaceId: doc.workspaceId,
        uploadedBy: uid,
        mime: file.mimetype,
        size,
      });
      await rename(tmp, join(dir, image.id));
      return reply.send({ url: `/api/images/${image.id}` });
    } finally {
      // Gone after the rename; cleans up truncation/DB failures.
      await unlink(tmp).catch(() => {});
    }
  });

  // Serve bytes only to members of the image's workspace.
  app.get("/api/images/:id", async (req, reply) => {
    const uid = await userId(req);
    if (!uid) return reply.code(401).send({ error: "unauthorized" });

    const { id } = req.params as { id: string };
    if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.code(404).send({ error: "not found" });

    const services = createServices(db, { kind: "user", userId: uid });
    const image = await services.images.get(id);
    if (!image) return reply.code(404).send({ error: "not found" });

    reply.header("content-type", image.mime);
    reply.header("cache-control", "private, max-age=86400");
    // Embedded <img> rendering is unaffected by these; they only stop the
    // bytes from ever executing as a same-origin top-level document.
    reply.header("x-content-type-options", "nosniff");
    reply.header("content-disposition", "attachment");
    reply.header("content-security-policy", "default-src 'none'; sandbox");
    return reply.send(createReadStream(join(dir, image.id)));
  });
}
