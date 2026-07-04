import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { fromNodeHeaders } from "better-auth/node";
import type { Database } from "@tandem/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Auth } from "./auth.js";
import { createServices } from "./services.js";

const MAX_BYTES = 25 * 1024 * 1024;
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Local disk dir for image bytes (UPLOADS_DIR; a mounted volume in prod). */
function uploadsDir(): string {
  const dir = process.env.UPLOADS_DIR ?? ".uploads";
  return isAbsolute(dir) ? dir : resolve(REPO_ROOT, dir);
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
    if (!file.mimetype.startsWith("image/")) {
      return reply.code(415).send({ error: "not an image" });
    }

    // Stream to a temp file, then commit under the DB-assigned id.
    const tmp = join(dir, `tmp-${randomUUID()}`);
    await pipeline(file.file, createWriteStream(tmp));
    if (file.file.truncated) {
      await unlink(tmp).catch(() => {});
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
  });

  // Serve bytes only to members of the image's workspace.
  app.get("/api/images/:id", async (req, reply) => {
    const uid = await userId(req);
    if (!uid) return reply.code(401).send({ error: "unauthorized" });

    const services = createServices(db, { kind: "user", userId: uid });
    const image = await services.images.get((req.params as { id: string }).id);
    if (!image) return reply.code(404).send({ error: "not found" });

    reply.header("content-type", image.mime);
    reply.header("cache-control", "private, max-age=86400");
    return reply.send(createReadStream(join(dir, image.id)));
  });
}
