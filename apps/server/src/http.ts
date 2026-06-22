import cors from "@fastify/cors";
import {
  type CreateFastifyContextOptions,
  fastifyTRPCPlugin,
} from "@trpc/server/adapters/fastify";
import { createDatabase } from "@realtime/db";
import { fromNodeHeaders } from "better-auth/node";
import Fastify from "fastify";
import { createAuth } from "./auth.js";
import { createServices } from "./services.js";
import { appRouter } from "./trpc.js";

/**
 * The single Node runtime. Hosts the tRPC API + Better Auth today; Phase 3
 * mounts Hocuspocus (/collab) and the MCP HTTP transport (/mcp) here too.
 * One db instance is shared by services and auth (PGlite = one connection).
 */
export async function buildHttpServer() {
  const db = createDatabase(process.env.DATABASE_URL);
  const services = createServices(db);
  const auth = createAuth(db);
  const app = Fastify({ logger: true });

  await app.register(cors, {
    origin: process.env.WEB_ORIGIN ?? "http://localhost:5173",
    credentials: true,
  });

  // Better Auth handles all /api/auth/* routes (sign-up, sign-in, session…).
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    async handler(request, reply) {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const req = new Request(url, {
        method: request.method,
        headers: fromNodeHeaders(request.headers),
        ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      });
      const response = await auth.handler(req);
      reply.status(response.status);
      response.headers.forEach((value, key) => reply.header(key, value));
      return reply.send(response.body ? await response.text() : null);
    },
  });

  await app.register(fastifyTRPCPlugin, {
    prefix: "/trpc",
    trpcOptions: {
      router: appRouter,
      createContext: async ({ req }: CreateFastifyContextOptions) => {
        const session = await auth.api.getSession({
          headers: fromNodeHeaders(req.headers),
        });
        return { services, user: session?.user ?? null };
      },
    },
  });

  app.get("/health", () => ({ ok: true }));

  return app;
}
