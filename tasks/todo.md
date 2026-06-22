# Realtime — Outline-like wiki with MCP server

Stack A: Vite+React+TipTap (web) · Fastify+tRPC (api) · Postgres+Drizzle · Hocuspocus (Yjs) · MCP — one Node runtime, monorepo.

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

## Phase 2 — Editor UI
- [ ] `apps/web` Vite+React+TipTap, doc tree sidebar, slash commands, markdown I/O
- [ ] tRPC API in Fastify

## Phase 3 — Realtime + remote
- [ ] Hocuspocus mounted in Fastify (/collab), Yjs persistence -> ydoc_state + derived content_md
- [ ] MCP writes via openDirectConnection (uniform write path)
- [ ] HTTP/SSE MCP transport + auth (Better Auth); Redis pub/sub when scaling out

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
