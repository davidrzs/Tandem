import { fromNodeHeaders } from "better-auth/node";
import type { Database } from "@tandem/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Auth } from "../auth.js";
import { createServices } from "../services.js";
import { buildExportZip } from "./export.js";
import { importZip, ImportError } from "./import.js";

const MAX_IMPORT_BYTES = 200 * 1024 * 1024;

/**
 * Markdown zip import/export. Both routes are session-gated and RLS-scoped:
 * a user exports only what they can read and imports into a workspace they
 * belong to. Content is attributed to the importing human (blame).
 */
export async function registerTransferRoutes(app: FastifyInstance, db: Database, auth: Auth) {
  const sessionOf = (req: FastifyRequest) =>
    auth.api.getSession({ headers: fromNodeHeaders(req.headers) });

  // Export a collection (?collection=) or a whole workspace (?workspace=).
  app.get("/api/export", async (req, reply) => {
    const session = await sessionOf(req);
    if (!session) return reply.code(401).send({ error: "unauthorized" });

    const q = req.query as { collection?: string; workspace?: string };
    if (!!q.collection === !!q.workspace) {
      return reply.code(400).send({ error: "pass exactly one of collection or workspace" });
    }

    const services = createServices(db, { kind: "user", userId: session.user.id }, {
      userId: session.user.id,
      name: session.user.name ?? "",
      ai: false,
    });

    let name = "workspace";
    if (q.collection) {
      const col = (await services.collections.list()).find((c) => c.id === q.collection);
      if (!col) return reply.code(404).send({ error: "collection not found" });
      name = col.name;
    } else {
      const ws = (await services.workspaces.listMine()).find((w) => w.id === q.workspace);
      if (!ws) return reply.code(404).send({ error: "workspace not found" });
      name = ws.name;
    }

    const result = await buildExportZip(
      services,
      { collectionId: q.collection, workspaceId: q.workspace },
      name,
    );
    if (result.buffer.length === 0) return reply.code(404).send({ error: "nothing to export" });

    const safe = name.replace(/[^\w.-]+/g, "_");
    reply.header("content-type", "application/zip");
    reply.header("content-disposition", `attachment; filename="${safe}-export.zip"`);
    return reply.send(Buffer.from(result.buffer));
  });

  // Import a markdown zip into ?workspace=.
  // Imports are heavy (whole-archive); keep them infrequent per client.
  app.post("/api/import", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    const session = await sessionOf(req);
    if (!session) return reply.code(401).send({ error: "unauthorized" });

    const workspaceId = (req.query as { workspace?: string }).workspace;
    if (!workspaceId) return reply.code(400).send({ error: "workspace required" });

    const services = createServices(db, { kind: "user", userId: session.user.id }, {
      userId: session.user.id,
      name: session.user.name ?? "",
      ai: false,
    });
    const member = (await services.workspaces.listMine()).some((w) => w.id === workspaceId);
    if (!member) return reply.code(403).send({ error: "not a member of that workspace" });

    const file = await req.file({ limits: { fileSize: MAX_IMPORT_BYTES } });
    if (!file) return reply.code(400).send({ error: "no file" });
    const buffer = await file.toBuffer();
    if (file.file.truncated) return reply.code(413).send({ error: "file too large" });

    try {
      const summary = await importZip(services, {
        workspaceId,
        uid: session.user.id,
        zipName: file.filename ?? "Imported",
        buffer,
      });
      return reply.send(summary);
    } catch (err) {
      if (err instanceof ImportError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });
}
