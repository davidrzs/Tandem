import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import {
  type CreateFastifyContextOptions,
  fastifyTRPCPlugin,
} from "@trpc/server/adapters/fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createDatabase } from "@realtime/db";
import { fromNodeHeaders } from "better-auth/node";
import Fastify from "fastify";
import { createAuth } from "./auth.js";
import { createCollabWriter } from "./collab-writer.js";
import { createHocuspocus } from "./collab.js";
import { createMcpServer } from "./mcp.js";
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
  const hocuspocus = createHocuspocus(services, auth);
  const collabWriter = createCollabWriter(hocuspocus);
  const app = Fastify({ logger: true });

  await app.register(cors, {
    origin: process.env.WEB_ORIGIN ?? "http://localhost:5173",
    credentials: true,
  });
  await app.register(websocket);

  // Realtime collaboration. Hocuspocus v4 returns a ClientConnection we pump
  // ourselves (it dropped the `ws` library for crossws).
  app.get("/collab", { websocket: true }, (socket, req) => {
    const request = new Request(`http://localhost${req.url}`, {
      headers: req.headers as Record<string, string>,
    });
    const connection = hocuspocus.handleConnection(socket as never, request);
    socket.on("message", (data: Buffer) =>
      connection.handleMessage(new Uint8Array(data)),
    );
    socket.on("close", (code: number, reason: Buffer) =>
      connection.handleClose({ code, reason: reason.toString() } as never),
    );
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

  // MCP over HTTP, in-process with Hocuspocus so agent writes use the live
  // write path. Stateless JSON responses; OAuth is the production gate (todo),
  // an optional MCP_TOKEN bearer guards it meanwhile.
  const mcpToken = process.env.MCP_TOKEN;
  app.post("/mcp", async (req, reply) => {
    if (mcpToken && req.headers.authorization !== `Bearer ${mcpToken}`) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    reply.hijack();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = createMcpServer(services, collabWriter);
    reply.raw.on("close", () => {
      transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  app.get("/health", () => ({ ok: true }));

  return app;
}
