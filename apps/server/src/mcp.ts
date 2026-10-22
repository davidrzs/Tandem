import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createToolContext, type McpServerOptions } from "./mcp/shared.js";
import { registerCollectionTools } from "./mcp/tools/collections.js";
import { registerCommentTools } from "./mcp/tools/comments.js";
import { registerEditTools } from "./mcp/tools/edits.js";
import { registerImageTools } from "./mcp/tools/images.js";
import { registerDiscoveryTools, registerReadTools } from "./mcp/tools/read.js";
import { registerTemplateTools } from "./mcp/tools/templates.js";
import { registerVersionTools } from "./mcp/tools/versions.js";
import { registerCreateTools, registerLifecycleTools } from "./mcp/tools/write.js";
import type { Services } from "./services.js";

export { type AuditHook, MCP_IMAGE_MAX_BYTES, type McpServerOptions } from "./mcp/shared.js";

/** JSON-RPC body ceiling for POST /mcp. The largest legitimate payloads are a
 * base64 image at the cap (~4MB) and a markdown body at INPUT_LIMITS.markdown
 * (1M chars, up to ~4MB as UTF-8); 5MB covers either plus the envelope. */
export const MCP_BODY_LIMIT = 5 * 1024 * 1024;

/**
 * Build the MCP server exposing the wiki content. Every tool delegates to the
 * shared core services — no document logic lives here.
 *
 * Body edits are deliberately TARGETED (find/replace, per-section) rather than
 * whole-document rewrites: edits flow through a structural Yjs diff, so only
 * the spans an agent actually changes are attributed to it — a full rewrite
 * would re-attribute the entire document and destroy human authorship (blame).
 */
export function createMcpServer(services: Services, options: McpServerOptions): McpServer {
  const server = new McpServer({ name: "tandem", version: "0.1.0" });
  const ctx = createToolContext(services, options);

  // Tool listing order is observable, so groups register in the original order.
  registerCollectionTools(server, ctx);
  registerReadTools(server, ctx);
  registerCreateTools(server, ctx);
  registerImageTools(server, ctx);
  registerEditTools(server, ctx);
  registerLifecycleTools(server, ctx);
  registerDiscoveryTools(server, ctx);
  registerCommentTools(server, ctx);
  registerVersionTools(server, ctx);
  registerTemplateTools(server, ctx);

  return server;
}
