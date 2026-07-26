import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
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

/** How long a minted direct-upload token stays valid. */
export const IMAGE_UPLOAD_TTL_MS = 15 * 60 * 1000;

/** What a minted token authorises: one image into one workspace, with the alt
 * text fixed at mint time (see mintImageUploadToken for why it rides along). */
type UploadGrant = { userId: string; workspaceId: string; alt: string };

const sign = (secret: string, payload: string) =>
  createHmac("sha256", secret).update(payload).digest("base64url");

/** Alt text is interpolated into `![alt](url)`: brackets would break the
 * snippet and newlines would split it across markdown blocks. */
export function imageMarkdown(alt: string | undefined, url: string): string {
  const clean = (alt ?? "").replace(/[[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, 500);
  return `![${clean}](${url})`;
}

/**
 * Mint a bearer token for a direct image upload: HMAC-signed and stateless, so
 * it survives restarts and needs no table. Short-lived rather than single-use —
 * it only grants what the holder (an MCP agent acting as the user) could
 * already do, add an image to a workspace they belong to, so the TTL bounds it.
 *
 * The alt text is baked in rather than sent as a multipart field: fields that
 * follow the file part are only parsed if the parser happens to reach them
 * before the file stream drains, so a trailing `alt` is silently lost whenever
 * TCP splits the request at the wrong byte. A tool argument is also a far more
 * reliable channel for an agent than shell-quoting text into a curl line.
 */
export function mintImageUploadToken(
  secret: string,
  grant: { userId: string; workspaceId: string; alt?: string },
): { token: string; expiresAt: Date } {
  const expiresAt = new Date(Date.now() + IMAGE_UPLOAD_TTL_MS);
  const payload = Buffer.from(
    JSON.stringify({
      u: grant.userId,
      w: grant.workspaceId,
      a: grant.alt ?? "",
      exp: expiresAt.getTime(),
    }),
  ).toString("base64url");
  return { token: `${payload}.${sign(secret, payload)}`, expiresAt };
}

/** Validate a direct-upload token; null when forged, malformed, or expired. */
export function verifyImageUploadToken(secret: string, token: string): UploadGrant | null {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = Buffer.from(sign(secret, payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const { u, w, a, exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (typeof u !== "string" || typeof w !== "string" || typeof exp !== "number") return null;
    if (Date.now() > exp) return null;
    return { userId: u, workspaceId: w, alt: typeof a === "string" ? a : "" };
  } catch {
    return null;
  }
}

/** SVG is a script container, not a picture — served same-origin it could run
 * in the app's session. Raster formats only. */
export function isAllowedImageMime(mime: string): boolean {
  return mime.startsWith("image/") && mime !== "image/svg+xml";
}

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
export async function registerImageRoutes(
  app: FastifyInstance,
  db: Database,
  auth: Auth,
  /** Direct (tokened) uploads: HMAC secret + the same access gate as /mcp.
   * Passed in from http.ts — importing them here would be a module cycle. */
  direct?: { secret: string; mcpGate: (userId: string) => Promise<string | null> },
) {
  const dir = uploadsDir();
  await mkdir(dir, { recursive: true });

  const userId = async (req: FastifyRequest): Promise<string | null> => {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    return session?.user.id ?? null;
  };

  // Upload an image attached to a document's workspace. Rate-limited: uploads
  // write to disk, so cap the burst rate per client.
  app.post("/api/images", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req, reply) => {
    const uid = await userId(req);
    if (!uid) return reply.code(401).send({ error: "unauthorized" });

    const documentId = (req.query as { documentId?: string }).documentId;
    if (!documentId) return reply.code(400).send({ error: "documentId required" });

    const services = createServices(db, { kind: "user", userId: uid });
    const doc = await services.documents.getMeta(documentId);
    if (!doc) return reply.code(404).send({ error: "document not found" });

    const file = await req.file({ limits: { fileSize: MAX_BYTES } });
    if (!file) return reply.code(400).send({ error: "no file" });
    if (!isAllowedImageMime(file.mimetype)) {
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

  // Direct upload against a short-lived minted token (request_image_upload over
  // MCP) — agents push raw bytes here instead of inlining base64 in a tool
  // call. Same limits as the session route; the bearer token replaces the
  // cookie. It travels as a header, not a query param, so it stays out of
  // access logs and out of any transcript the agent's curl line lands in.
  if (direct) {
    app.post(
      "/api/images/upload",
      { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
      async (req, reply) => {
        const header = req.headers.authorization ?? "";
        const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
        const grant = token ? verifyImageUploadToken(direct.secret, token) : null;
        if (!grant) return reply.code(401).send({ error: "invalid or expired upload token" });
        // The account may have been banned/disabled since the mint.
        const denial = await direct.mcpGate(grant.userId);
        if (denial) return reply.code(403).send({ error: denial });

        // Membership can also have lapsed since the mint. RLS on the insert is
        // the real backstop, but checking here turns that into a clean 403
        // instead of a failed write after streaming up to 25MB to disk.
        const services = createServices(db, { kind: "user", userId: grant.userId });
        const mine = await services.workspaces.listMine();
        if (!mine.some((w) => w.id === grant.workspaceId)) {
          return reply.code(403).send({ error: "no longer a member of that workspace" });
        }

        const file = await req.file({ limits: { fileSize: MAX_BYTES } });
        if (!file) return reply.code(400).send({ error: "no file" });
        if (!isAllowedImageMime(file.mimetype)) {
          return reply.code(415).send({ error: "not a supported image type" });
        }

        const tmp = join(dir, `tmp-${randomUUID()}`);
        try {
          await pipeline(file.file, createWriteStream(tmp));
          if (file.file.truncated) {
            return reply.code(413).send({ error: "image exceeds 25MB" });
          }
          const { size } = await stat(tmp);
          const image = await services.images.create({
            workspaceId: grant.workspaceId,
            uploadedBy: grant.userId,
            mime: file.mimetype,
            size,
          });
          await rename(tmp, join(dir, image.id));
          void services.settings
            .recordAudit({
              workspaceId: grant.workspaceId,
              userId: grant.userId,
              ai: true,
              action: "upload_image",
              detail: `${file.mimetype}, ${size} bytes (direct upload)`,
            })
            .catch((err) => req.log.error({ err }, "audit write failed"));
          const url = `/api/images/${image.id}`;
          return reply.send({
            id: image.id,
            url,
            // Alt text comes from the token, so multipart part ordering can't
            // silently drop it.
            markdown: imageMarkdown(grant.alt, url),
            mime: file.mimetype,
            size,
          });
        } finally {
          // Gone after the rename; cleans up truncation/DB failures.
          await unlink(tmp).catch(() => {});
        }
      },
    );
  }

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
