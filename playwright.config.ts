import { defineConfig } from "@playwright/test";

/**
 * E2E against the real single-process deployment shape: the Node server with
 * an in-memory PGlite database, serving the built web SPA. Run
 * `pnpm --filter @tandem/web build` first (CI and `pnpm e2e` do).
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  // One worker: tests share the server (and its in-memory database).
  workers: 1,
  use: {
    baseURL: "http://localhost:3799",
  },
  webServer: {
    command: "node --import tsx src/e2e-serve.ts",
    cwd: "apps/server",
    port: 3799,
    reuseExistingServer: false,
    stdout: "ignore",
    stderr: "pipe",
  },
});
