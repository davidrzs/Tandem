// Smoke test for MCP-over-HTTP against a running server (PORT 3001).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const transport = new StreamableHTTPClientTransport(new URL("http://localhost:3001/mcp"));
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

const parse = (r) => JSON.parse(r.content[0].text);

const { tools } = await client.listTools();
console.log("tools:", tools.length);

const col = parse(
  await client.callTool({
    name: "create_collection",
    arguments: { name: "HTTP MCP", slug: `http-mcp-${Date.now()}` },
  }),
);
const doc = parse(
  await client.callTool({
    name: "create_document",
    arguments: { collectionId: col.id, title: "Via HTTP MCP", markdown: "# Start\n\nseed." },
  }),
);
await client.callTool({
  name: "append_section",
  arguments: { id: doc.id, markdown: "## Added over HTTP\n\nby an agent." },
});
const fetched = parse(
  await client.callTool({ name: "get_document", arguments: { id: doc.id } }),
);

await client.close();

if (tools.length !== 10) throw new Error(`expected 10 tools, got ${tools.length}`);
if (!fetched.markdown.includes("## Added over HTTP"))
  throw new Error(`append not reflected: ${fetched.markdown}`);
console.log("MCP-HTTP PASS — 10 tools, create + append + get over HTTP, append landed");
