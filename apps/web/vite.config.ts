import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** Matches a module inside one of the named packages; `*` stands for any
 * part of a name ("@tiptap/*", "prosemirror-*"). Whole package names, not
 * substrings of the path: pnpm folder names carry their peers' names, and
 * @tiptap/extension-code-block-lowlight is not lowlight. */
const SEP = String.raw`[\\/]`;
const pkg = (...names: string[]) => {
  const name = (n: string) =>
    n
      .split("/")
      .map((part) => part.replaceAll(".", String.raw`\.`).replaceAll("*", String.raw`[^\\/]*`))
      .join(SEP);
  return new RegExp(`${SEP}node_modules${SEP}(?:${names.map(name).join("|")})${SEP}`);
};

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
  build: {
    // The server's CSP is font-src 'self': a small font subset inlined as a
    // data: URI would be blocked, so fonts always ship as files.
    assetsInlineLimit: (filePath) => (/\.(woff2?|ttf|otf)$/.test(filePath) ? false : undefined),
    rolldownOptions: {
      output: {
        // Split the big libraries into cacheable chunks that load in parallel;
        // the editor vendors sit behind the lazy document route. A group also
        // takes the dependencies of what it captures, unless a group of
        // higher priority claimed them: React ranks first, so the editor
        // group can't pull react-dom in and make the entry load the editor.
        codeSplitting: {
          groups: [
            {
              name: "react-vendor",
              priority: 40,
              // React and the app shell's libraries (sidebar tree, panes, auth):
              // the entry loads them all, and they change less than the app.
              test: pkg(
                "react",
                "react-dom",
                "scheduler",
                "react-router",
                "react-router-dom",
                "@tanstack/*",
                "@trpc/*",
                "@radix-ui/*",
                "@headless-tree/*",
                "react-resizable-panels",
                "better-auth",
                "@better-auth/*",
                "@better-fetch/*",
                "better-call",
                "nanostores",
              ),
            },
            { name: "katex", priority: 30, test: pkg("katex") },
            { name: "highlight", priority: 30, test: pkg("lowlight", "highlight.js") },
            {
              name: "editor-vendor",
              priority: 10,
              test: pkg("prosemirror-*", "@tiptap/*", "y-prosemirror", "yjs", "@hocuspocus/*"),
            },
          ],
        },
      },
    },
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
