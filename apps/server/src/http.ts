import cors from "@fastify/cors";
import formbody from "@fastify/formbody";
import websocket from "@fastify/websocket";
import {
  type CreateFastifyContextOptions,
  fastifyTRPCPlugin,
} from "@trpc/server/adapters/fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createDatabase } from "@realtime/db";
import { fromNodeHeaders } from "better-auth/node";
import {
  oAuthDiscoveryMetadata,
  oAuthProtectedResourceMetadata,
} from "better-auth/plugins";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
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
  // OAuth token requests are form-encoded; parse them so /api/auth/* accepts them.
  await app.register(formbody);
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

  // Bridge a Fastify request/reply to the WHATWG Request/Response that Better
  // Auth's handlers speak. Re-encode the parsed body to match its content-type
  // (OAuth token requests are form-encoded; everything else is JSON).
  const toWebRequest = (request: FastifyRequest): Request => {
    const headers = fromNodeHeaders(request.headers);
    let body: string | undefined;
    if (request.body) {
      const isForm = (headers.get("content-type") ?? "").includes(
        "application/x-www-form-urlencoded",
      );
      body = isForm
        ? new URLSearchParams(request.body as Record<string, string>).toString()
        : JSON.stringify(request.body);
    }
    return new Request(new URL(request.url, `http://${request.headers.host}`), {
      method: request.method,
      headers,
      ...(body !== undefined ? { body } : {}),
    });
  };
  const sendWebResponse = async (reply: FastifyReply, response: Response) => {
    reply.status(response.status);
    response.headers.forEach((value, key) => reply.header(key, value));
    return reply.send(response.body ? await response.text() : null);
  };

  // Better Auth handles all /api/auth/* routes (sign-up, sign-in, session, and
  // the MCP OAuth endpoints: /mcp/authorize, /mcp/token, /mcp/register, …).
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    handler: async (request, reply) =>
      sendWebResponse(reply, await auth.handler(toWebRequest(request))),
  });

  // OAuth discovery — MUST be at the domain root for MCP clients to find it.
  const discovery = oAuthDiscoveryMetadata(auth);
  const protectedResource = oAuthProtectedResourceMetadata(auth);
  app.get("/.well-known/oauth-authorization-server", async (req, reply) =>
    sendWebResponse(reply, await discovery(toWebRequest(req))),
  );
  app.get("/.well-known/oauth-protected-resource", async (req, reply) =>
    sendWebResponse(reply, await protectedResource(toWebRequest(req))),
  );

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
  // write path. Gated by Better Auth's MCP OAuth (bearer access token); the
  // 401 carries the resource-metadata challenge MCP clients follow.
  app.post("/mcp", async (req, reply) => {
    const token = await auth.api.getMcpSession({
      headers: fromNodeHeaders(req.headers),
    });
    if (!token) {
      const challenge = `Bearer resource_metadata="http://${req.headers.host}/.well-known/oauth-protected-resource"`;
      return reply
        .code(401)
        .header("WWW-Authenticate", challenge)
        .header("Access-Control-Expose-Headers", "WWW-Authenticate")
        .send({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Unauthorized: authentication required" },
          id: null,
        });
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
