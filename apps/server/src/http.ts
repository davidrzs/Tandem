import cors from "@fastify/cors";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import Fastify from "fastify";
import { appRouter } from "./trpc.js";
import { servicesFromEnv } from "./services.js";

/**
 * The single Node runtime. Today it hosts the tRPC API; Phase 3 mounts
 * Hocuspocus (/collab) and the MCP HTTP transport (/mcp) on the same server.
 */
export async function buildHttpServer() {
  const services = servicesFromEnv();
  const app = Fastify({ logger: true });

  await app.register(cors, {
    origin: process.env.WEB_ORIGIN ?? "http://localhost:5173",
  });

  await app.register(fastifyTRPCPlugin, {
    prefix: "/trpc",
    trpcOptions: { router: appRouter, createContext: () => ({ services }) },
  });

  app.get("/health", () => ({ ok: true }));

  return app;
}
