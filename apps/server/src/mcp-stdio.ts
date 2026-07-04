#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./mcp.js";
import { servicesFromEnv } from "./services.js";

async function main() {
  const server = createMcpServer(await servicesFromEnv());
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio transport keeps the process alive; log to stderr so stdout stays clean.
  process.stderr.write("tandem MCP server listening on stdio\n");
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
