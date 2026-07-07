import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import formbody from "@fastify/formbody";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import {
  type CreateFastifyContextOptions,
  fastifyTRPCPlugin,
} from "@trpc/server/adapters/fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createDatabase, user as userTable, type Actor } from "@tandem/db";
import { eq } from "drizzle-orm";
import { fromNodeHeaders } from "better-auth/node";
import {
  oAuthDiscoveryMetadata,
  oAuthProtectedResourceMetadata,
} from "better-auth/plugins";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { createAuth } from "./auth.js";
import { createCollabWriter } from "./collab-writer.js";
import { createHocuspocus } from "./collab.js";
import { registerImageRoutes } from "./images.js";
import { registerSetupRoutes } from "./setup-routes.js";
import { registerTransferRoutes } from "./transfer/routes.js";
import { createMcpServer } from "./mcp.js";
import { createServices } from "./services.js";
import { appRouter } from "./trpc.js";

/**
 * Whether this user may act through MCP right now: the account must exist,
 * not be banned (ban must sever agent access even for already-issued OAuth
 * tokens), and not have the per-user kill switch off. Returns the refusal
 * message, or null when access is allowed.
 */
export async function mcpAccessError(
  db: ReturnType<typeof createDatabase>,
  userId: string,
): Promise<string | null> {
  const [u] = await db
    .select({ banned: userTable.banned })
    .from(userTable)
    .where(eq(userTable.id, userId));
  if (!u) return "MCP access denied: this account no longer exists";
  if (u.banned) return "MCP access denied: this account is banned";
  const services = createServices(db, { kind: "user", userId });
  if (!(await services.settings.mcpEnabled(userId))) {
    return "MCP access is turned off for this account (Settings > AI access)";
  }
  return null;
}

/**
 * The single Node runtime. Hosts the tRPC API + Better Auth today; Phase 3
 * mounts Hocuspocus (/collab) and the MCP HTTP transport (/mcp) here too.
 * One db instance is shared by services and auth (PGlite = one connection).
 */
export async function buildHttpServer(injectedDb?: ReturnType<typeof createDatabase>) {
  const isProd = process.env.NODE_ENV === "production";
  // Fail fast in production rather than fall back to a forgeable default secret.
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 16 || secret.startsWith("replace")) {
    throw new Error(
      "BETTER_AUTH_SECRET must be set to a strong value (openssl rand -base64 32)",
    );
  }
  // A prod instance that silently falls back to localhost URLs breaks cookies,
  // CORS, and OAuth discovery in confusing ways — refuse to boot instead.
  if (isProd) {
    for (const key of ["BETTER_AUTH_URL", "WEB_ORIGIN", "DATABASE_URL"] as const) {
      if (!process.env[key]) throw new Error(`${key} must be set in production`);
    }
  }
  const db = injectedDb ?? createDatabase(process.env.DATABASE_URL);
  const auth = createAuth(db);
  // Hocuspocus builds actor-scoped services per connection from the db.
  const hocuspocus = createHocuspocus(db, auth);
  const app = Fastify({ logger: true });

  await app.register(cors, {
    origin: process.env.WEB_ORIGIN ?? "http://localhost:5173",
    credentials: true,
  });

  // Security headers on every response except the image route, which sets its
  // own stricter sandbox CSP. Everything the app loads is same-origin (bundled
  // assets, fonts, KaTeX), so a tight policy holds; inline styles (author tints,
  // presence dots) need 'unsafe-inline' for style-src, and the collab WebSocket
  // needs its ws(s) origin in connect-src. With BETTER_AUTH_URL set (enforced
  // in prod) that's pinned to our own host; dev falls back to any ws host
  // (Vite serves the page, so this CSP mostly doesn't apply there anyway).
  const publicUrl = process.env.BETTER_AUTH_URL;
  const wsOrigin = publicUrl
    ? `${new URL(publicUrl).protocol === "https:" ? "wss" : "ws"}://${new URL(publicUrl).host}`
    : "ws: wss:";
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self' ${wsOrigin}`,
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
  app.addHook("onRequest", async (req, reply) => {
    // Skip the image route (own CSP) and the WebSocket upgrade (/collab).
    if (req.url.startsWith("/api/images") || req.url.startsWith("/collab")) return;
    reply.header("content-security-policy", csp);
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "strict-origin-when-cross-origin");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
    if (isProd) reply.header("strict-transport-security", "max-age=15552000; includeSubDomains");
  });

  // Rate limiting (in-memory). Not global — the high-frequency tRPC/collab
  // traffic is left alone; only the abusable/expensive endpoints opt in below
  // (MCP, image upload, zip import) via each route's `config.rateLimit`.
  await app.register(rateLimit, { global: false });

  // OAuth token requests are form-encoded; parse them so /api/auth/* accepts them.
  await app.register(formbody);
  await app.register(multipart);
  await app.register(websocket);
  await registerImageRoutes(app, db, auth);
  await registerTransferRoutes(app, db, auth);
  await registerSetupRoutes(app, db, auth);

  // Realtime collaboration. Hocuspocus v4 returns a ClientConnection we pump
  // ourselves (it dropped the `ws` library for crossws).
  app.get("/collab", { websocket: true }, (socket, req) => {
    const request = new Request(`http://localhost${req.url}`, {
      headers: fromNodeHeaders(req.headers),
    });
    const connection = hocuspocus.handleConnection(socket as never, request);
    socket.on("message", (data: Buffer) =>
      connection.handleMessage(new Uint8Array(data)),
    );
    socket.on("close", (code: number, reason: Buffer) =>
      connection.handleClose({ code, reason: reason.toString() } as never),
    );
    // Without this, an 'error' event on the raw ws socket is unhandled and
    // throws, taking down the process.
    socket.on("error", (err: Error) => {
      app.log.error({ err }, "collab socket error");
      connection.handleClose({ code: 1011, reason: "error" } as never);
    });
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
  // The credential endpoints get tight per-IP limits (brute-force protection);
  // the rest share a generous cap. Static routes win over the wildcard, so the
  // tight routes shadow the catch-all for their paths only.
  const authHandler = async (request: FastifyRequest, reply: FastifyReply) =>
    sendWebResponse(reply, await auth.handler(toWebRequest(request)));
  app.post(
    "/api/auth/sign-in/email",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    authHandler,
  );
  app.post(
    "/api/auth/sign-up/email",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    authHandler,
  );
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    config: { rateLimit: { max: 300, timeWindow: "1 minute" } },
    handler: authHandler,
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
        // Unauthenticated -> a no-privilege user actor (RLS sees nothing), never
        // SYSTEM, so a future non-protected procedure can't run as superuser.
        const actor: Actor = { kind: "user", userId: session?.user.id ?? "" };
        const author = session
          ? { userId: session.user.id, name: session.user.name, ai: false }
          : undefined;
        const services = createServices(db, actor, author);
        // A restore writes through the live doc as the human — build the writer
        // here where Hocuspocus is in scope, wired to snapshots for pre-restore.
        const collabWriter =
          session && author
            ? createCollabWriter(hocuspocus, services.documents, author, services.snapshots)
            : undefined;
        return {
          services,
          collabWriter,
          user: session?.user ?? null,
          // Data-free ping over the doc's live channel; only connections that
          // already passed onAuthenticate for this doc receive it, and they
          // refetch through their own RLS-scoped queries.
          notifyDocument: (documentId: string, topic: "comments" | "snapshots") => {
            hocuspocus.documents
              .get(documentId)
              ?.broadcastStateless(JSON.stringify({ topic }));
          },
        };
      },
    },
  });

  // MCP over HTTP, in-process with Hocuspocus so agent writes use the live
  // write path. Gated by Better Auth's MCP OAuth (bearer access token); the
  // 401 carries the resource-metadata challenge MCP clients follow.
  // A well-behaved agent makes well under this; higher is a runaway loop.
  app.post("/mcp", { config: { rateLimit: { max: 240, timeWindow: "1 minute" } } }, async (req, reply) => {
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
    // A valid OAuth token is not enough: the account must still exist, not be
    // banned, and not have agents turned off. (Bans don't revoke already-issued
    // MCP access tokens, so this check is what actually severs agent access.)
    const denial = await mcpAccessError(db, token.userId);
    if (denial) {
      return reply.code(403).send({
        jsonrpc: "2.0",
        error: { code: -32000, message: denial },
        id: null,
      });
    }
    reply.hijack();
    // The agent acts as the token's user: services + collab writes are scoped
    // to that user's workspaces (RLS + the live Y.Doc write path), and every
    // span it writes is attributed to that user's AI in the blame layer.
    const actor: Actor = { kind: "user", userId: token.userId };
    const [tokenUser] = await db
      .select({ name: userTable.name })
      .from(userTable)
      .where(eq(userTable.id, token.userId));
    const author = {
      userId: token.userId,
      name: tokenUser?.name ?? "",
      ai: true,
    };
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const services = createServices(db, actor, author);
    const server = createMcpServer(
      services,
      createCollabWriter(hocuspocus, services.documents, author),
      // Audit trail: every successful agent write, attributed to the human
      // whose token acted. Fire-and-forget; an audit hiccup must not fail
      // the tool call.
      (action, detail, workspaceId) => {
        void services.settings
          .recordAudit({ workspaceId, userId: token.userId, action, detail })
          .catch((err) => app.log.error({ err }, "audit write failed"));
      },
    );
    reply.raw.on("close", () => {
      transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  app.get("/health", () => ({ ok: true }));

  // Single-deployable: serve the built web SPA when present (production). In
  // dev the dist doesn't exist and Vite serves the app instead.
  const webDist = fileURLToPath(new URL("../../web/dist", import.meta.url));
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    const apiPrefixes = ["/trpc", "/api", "/mcp", "/collab", "/.well-known", "/health"];
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !apiPrefixes.some((p) => req.url.startsWith(p))) {
        return reply.sendFile("index.html"); // SPA fallback for client routes
      }
      return reply.code(404).send({ error: "not found" });
    });
  }

  return app;
}
