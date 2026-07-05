import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // Guarantee a single instance of the packages whose identity matters: two
  // Reacts crash hooks ("Cannot read properties of null (reading 'useContext')"),
  // two ProseMirrors/Yjs break the editor and collaboration. The install is
  // already deduped; this also protects the dev server across HMR restarts.
  resolve: {
    dedupe: ["react", "react-dom", "@tiptap/core", "@tiptap/pm", "yjs"],
  },
  // Pre-bundle the heavy/nested deps at startup so Vite doesn't discover them
  // mid-session and trigger a full reload + re-optimize (which is what can tear
  // an already-open tab into a duplicate-React state).
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "@tiptap/react",
      "katex",
      "lowlight",
      "@tiptap/extension-code-block-lowlight",
      "@tiptap/extension-table",
      "@tiptap/extension-table-row",
      "@tiptap/extension-table-header",
      "@tiptap/extension-table-cell",
    ],
  },
  server: {
    port: 5173,
    proxy: {
      "/trpc": "http://localhost:3001",
      "/api": "http://localhost:3001",
      "/mcp": "http://localhost:3001",
      "/.well-known": "http://localhost:3001",
      "/collab": { target: "ws://localhost:3001", ws: true },
    },
  },
});
