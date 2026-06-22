# Realtime — Outline-like wiki with MCP server

Stack A: Vite+React+TipTap (web) · Fastify+tRPC (api) · Postgres+Drizzle · Hocuspocus (Yjs) · MCP — one Node runtime, monorepo.

## Local dev DB: PGlite (Postgres-in-WASM), prod: Postgres
- `createDatabase` branches on DATABASE_URL: `postgres://` -> real server (prod/CI); else PGlite in-process (dev, persisted to `<repo>/.pglite`; `memory://` for tests). Same SQL + tsvector FTS, full parity. No SQLite (would fork schema + search).
- `pnpm db:migrate` runs the right migrator for the active driver. Tests use in-memory PGlite, migrated fresh — no external DB needed.
- Scripts auto-load `.env` via `--env-file-if-exists`.

## Architecture invariants (do not violate)
- One shared domain layer (`packages/core`). Web API + MCP + Hocuspocus persistence all call it. No duplicated doc logic.
- Yjs is the live WRITE model; markdown (`content_md`) is the derived READ model.
- All writes (human + agent/MCP) funnel through the same Y.Doc via Hocuspocus `openDirectConnection`. Single write path.
- Self-host the Yjs tier in the same Node runtime as core + MCP.

## Phase 0 — Foundation (DONE)
- [x] Toolchain: pnpm, podman Postgres 18, git
- [x] Monorepo: pnpm workspaces + turbo + shared tsconfig
- [x] `packages/db`: Drizzle schema (collections, documents w/ parent_id, ydoc_state bytea, content_md/json, tsvector search) + migrations applied
- [x] `packages/core`: DocumentService + CollectionService + markdown<->prosemirror serialization + search, framework-agnostic
- [x] Unit tests proving CRUD + tree + search against real Postgres (2/2 pass, typecheck clean)

## Phase 1 — MCP server (stdio) (DONE except block-scoped tools)
- [x] `apps/server` package (Fastify lands in Phase 2)
- [x] MCP server over core: list_collections, create_collection, list_documents, get_document, search_documents, create_document, update_document, move_document, archive_document (9 tools)
- [x] stdio entry (`mcp-stdio.ts`), `.mcp.json` for Claude Code registration
- [x] Verified: 3/3 in-memory client tests + live stdio JSON-RPC handshake, typecheck clean
- [ ] Block-scoped write tools (append_section, replace_block, insert_after_heading) — deferred to land with Y.Doc write path in Phase 3

## Phase 2 — Editor UI (DONE except slash menu)
- [x] tRPC API in Fastify (`apps/server`: trpc.ts router + http.ts + serve.ts), CORS, /health
- [x] `apps/web` Vite+React+TipTap: collections + nested doc-tree sidebar, create collection/doc
- [x] Editor: TipTap StarterKit + tiptap-markdown, title input, debounced autosave, markdown input rules
- [x] Markdown I/O: client serializes via tiptap-markdown; server stores via core; markdown is the interchange
- [x] Verified: typecheck (4 pkgs) + unit tests (5) + production build + Playwright browser e2e (create->type->autosave->reload->persisted, heading round-trips to <h1>)
- [ ] Dedicated slash (/) command menu — markdown input rules cover formatting now; slash menu is polish

## Auth — Better Auth (secure-by-default, self-hosted) (DONE)
- [x] Server uses ONE shared db instance (PGlite = single connection) -> services + auth
- [x] `apps/server/src/auth.ts`: betterAuth + drizzleAdapter(db,{provider:'pg'}), emailAndPassword
- [x] Better Auth tables generated (`@better-auth/cli`) into `packages/db/src/auth-schema.ts`; migration 0001 applied
- [x] `/api/auth/*` mounted on Fastify; tRPC context reads session -> ctx.user; `protectedProcedure`
- [x] Write procedures gated (collections.create, documents.create/update/move/archive); reads public for now
- [x] Web: better-auth/react client + AuthGate (sign-in/sign-up); same-origin cookies via vite proxy
- [x] Verified: curl signup + unauth mutation 401 + authed mutation OK + public query; browser e2e signs up then edits; session persists across reload
- Env: BETTER_AUTH_SECRET, BETTER_AUTH_URL, WEB_ORIGIN. Dev auth via vite proxy (/api/auth -> :3001) = same-origin cookies.
- drizzle-kit can't rewrite .js->.ts across files, so config lists both schema files and index.ts merges app+auth schema at runtime.
- Deferred: authorization model (ownership/teams columns + Postgres RLS), MCP HTTP OAuth — land with Phase 3.

## Phase 3 — Realtime + remote (3a-3d DONE)
- [x] 3a. `packages/editor`: shared TipTap StarterKit extension list + getSchema() (one ProseMirror schema for client + server) + markdown serializer/parser. 3/3 round-trip tests.
- [x] 3b. core markdown re-exports @realtime/editor (server-derived markdown == editor output)
- [x] 3c. Hocuspocus v4 in Fastify (/collab via @fastify/websocket); onAuthenticate (Better Auth cookie on handshake), onLoadDocument (hydrate from ydoc_state else seed from content_md), onStoreDocument (persist ydoc_state + derive content_md/json). Verified via direct-connection server test.
- [x] 3d. Client editor -> collab: @tiptap/extension-collaboration (v2) + HocuspocusProvider; body via Yjs, title via tRPC. Provider lifecycle in useEffect (StrictMode-safe). Two-browser e2e proves bidirectional live sync; single-client e2e proves persistence across reload.
- [x] 3e. MCP uniform write path: collab-writer.ts (replaceBody/appendSection via openDirectConnection); update_document body + new append_section route through the live Y.Doc. MCP-over-HTTP mounted in Fastify (/mcp, stateless, shares hocuspocus+writer; optional MCP_TOKEN bearer; OAuth still TODO). Verified by in-process MCP test (write -> live Y.Doc) + HTTP MCP client smoke.
- [x] e2e isolation: run.sh uses a fresh .pglite-e2e DB per run -> deterministic (fixed the two-client navigation flake at root). smoke + collab both stable (6/6).
- [ ] MCP OAuth (production gate for /mcp); Redis pub/sub when scaling out (later)
- Gotchas recorded: y-prosemirror fragment defaults to 'prosemirror' but TipTap Collaboration to 'default' -> pinned 'default' everywhere. @tiptap/extension-collaboration pinned v2 to match StarterKit v2. Provider must be created in an effect, not useState (StrictMode destroys it otherwise).
- Invariant: Yjs = live write model; markdown = derived read model; ONE write path.

## Review
### Phase 0 (complete)
- Monorepo: pnpm workspaces + turbo, shared strict tsconfig. Packages: `@realtime/db`, `@realtime/core`.
- DB: Postgres 18 in podman (`realtime-pg`), Drizzle schema migrated. `ydoc_state bytea` reserved for the Yjs write model from day one; generated `tsvector` STORED column + GIN index for FTS.
- Core: `CollectionService`, `DocumentService` (CRUD, tree via recursive parent_id, fractional position, FTS via `websearch_to_tsquery`+`ts_rank`), markdown<->JSON serialization on prosemirror-markdown's schema (TipTap will align to it).
- Verified: 2/2 node:test cases green against real Postgres; both packages typecheck clean.
- Invariant honored: web/MCP/Hocuspocus will all call this one core. Markdown = derived read model; service writes derive content_md+content_json. Y.Doc write path lands in Phase 3 without schema change.
- Not committed yet (git initialized; awaiting go-ahead).

### Phase 1 (complete)
- `apps/server` (`@realtime/server`): MCP server (`@modelcontextprotocol/sdk`) over the shared core. 9 tools, all delegating to `DocumentService`/`CollectionService` — zero doc logic in the MCP layer (invariant honored).
- Entry: `src/mcp-stdio.ts` (stdio transport). `createMcpServer(services)` is transport-agnostic so the HTTP/SSE transport drops in at Phase 3.
- `.mcp.json` at repo root registers it for Claude Code as `realtime-wiki`.
- Verified: 3/3 in-memory `Client` tests (tool list, full create→get→search→update→tree lifecycle, error path) + live stdio JSON-RPC handshake advertising all 9 tools. Typecheck clean.
- Deferred deliberately: block-scoped write tools — they belong with the Y.Doc write path (Phase 3) so agent edits funnel through the single write path rather than full-body replace.

### Phase 2 (complete)
- API: `apps/server` now also hosts a tRPC router (collections + documents) on Fastify (`serve.ts`, port 3001). Same `createServices` as MCP — one core, two adapters. The MCP server and tRPC API expose the same operations.
- Web: `apps/web` Vite + React 18 + TipTap (StarterKit + tiptap-markdown). Outline-style two-pane layout: sidebar with collections + recursive document tree, main editor pane. Debounced autosave (title 500ms, body 700ms); markdown is the client<->server interchange.
- Decision recorded: markdown is the interchange format between editor and server (sidesteps TipTap-vs-prosemirror-markdown schema mismatch). content_json stays a server-side normalized cache; Phase 3's Yjs hook will rewrite it in TipTap-schema JSON. A single shared ProseMirror schema (TipTap + server) is the Phase 3 prerequisite for y-prosemirror conversions.
- Verified: all 4 packages typecheck; 5 unit/integration tests pass; web production build succeeds; Playwright browser e2e proves the full UI->tRPC->core->Postgres loop persists across reload and markdown round-trips (heading -> <h1>).
- Dev: `pnpm --filter @realtime/server dev` (API) + `pnpm --filter @realtime/web dev` (UI on :5173, proxies /trpc). e2e: `bash apps/web/e2e/run.sh`.
