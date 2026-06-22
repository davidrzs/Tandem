// Markdown <-> document-model serialization lives in @realtime/editor, the
// single source of truth for the schema shared by the client editor, the
// Hocuspocus persistence hook, and MCP writes. Core re-exports it so server
// queries derive exactly the same markdown the editor produces.
export {
  schema,
  nodeToMarkdown,
  markdownToNode,
  markdownToJSON,
  jsonToMarkdown,
  normalizeMarkdown,
} from "@realtime/editor";
