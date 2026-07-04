# Tandem

A self-hosted collaborative wiki for teams of humans **and** their AI agents —
built around one idea: when several people and an AI edit the same document,
you should always be able to see, calmly and truthfully, **who wrote what**.

- **Live collaboration.** Documents are Yjs CRDTs served over WebSockets
  (Hocuspocus): real-time carets, names, and offline-merge semantics.
- **Accountable authorship ("blame").** Every span of text is attributed to the
  session that wrote it — a specific human, or an AI acting *for* a specific
  human. Toggle **Authors** in the editor to colour text by author; hover shows
  who, human-vs-AI, and when. Off by default, quiet when on.
- **An agent that edits like a colleague.** The built-in MCP server exposes
  targeted edit tools (exact find/replace, insert-after-heading,
  replace-section, append) instead of whole-document rewrites, so an AI edit
  re-attributes only what it actually changed.
- **Tasks that find their owner.** Write a to-do anywhere and mention someone;
  it appears on their start page when they sign in.
- **The usual wiki bones.** Nested documents in collections, full-text search
  (⌘K), archive/restore, drag-to-reorganize, per-collection sharing with
  users/groups, invites — all enforced by Postgres row-level security.

## Tasks and assignment

A task is a GitHub-style checkbox item with an `@mention`:

```markdown
- [ ] @alice draft the intro
- [x] @bob@example.com file the report
```

The mention is the assignee's **email local part** (`@alice` for
`alice@example.com`) or their full email. In the editor, type `[ ] ` at the
start of a line (or use `/to-do`), and `@` autocompletes workspace members.
Open tasks assigned to you are listed on your start page, each linking back to
its document; checking the box completes it everywhere.

## Authorship model (how blame works)

Attribution lives in the Yjs layer, not in markdown: every inserted fragment
carries the client id of the session that created it, and each document keeps
an `authors` map from client id → `{ user, name, ai, time }`, persisted with
the document state.

- Human sessions are stamped **by the server** from the authenticated
  connection — clients don't self-report identity, and a client that tries to
  stamp its own session with a false identity is corrected server-side.
- Every MCP edit runs under a fresh client id stamped `ai: true` plus the
  invoking user, so AI content is always tied to the human whose credentials
  invoked it — never an anonymous "AI". (The one exception: the local stdio
  MCP server runs system-scoped with no signed-in human, so its edits are
  attributed to a visible "Local agent" AI identity.)
- Edits (human or AI) flow through one structural-diff write path, so
  unchanged text keeps its original author.

**Honest limits.** Attribution state lives inside the same CRDT document that
collaborators edit, so a *malicious* user with write access to a document can
corrupt its attribution the same way they could vandalize its text. Blame is
designed as an accountability signal for cooperating humans and AI agents —
who wrote what, human or machine — not as forensic proof against a hostile
co-editor.

## MCP (AI access)

Point an MCP client at `https://<your-domain>/mcp` — Tandem is its own OAuth
2.1 provider (sign in as yourself; the agent acts with your permissions and
its edits are blamed to your AI). Tools: `list_collections`,
`create_collection`, `list_documents`, `get_document`, `search_documents`,
`create_document`, `update_document` (title), `edit_document`,
`insert_after_heading`, `replace_section`, `append_section`, `move_document`,
`archive_document`. There is deliberately no full-body-rewrite tool: it would
re-attribute the whole document to the agent and destroy human blame.

A local stdio variant (`pnpm --filter @tandem/server mcp`) runs system-scoped
against `DATABASE_URL` for personal/offline use.

## Development

```bash
pnpm install
pnpm dev        # server :3001 (PGlite, zero setup) + web :5173
pnpm test       # unit + integration (in-memory Postgres via PGlite)
pnpm typecheck
pnpm --filter @tandem/web build && pnpm e2e   # Playwright, real server
```

The dev database is PGlite (Postgres-in-process — same SQL, RLS, and
full-text search as production). Set `DATABASE_URL=postgres://…` for a real
server. Deployment: see [DEPLOY.md](DEPLOY.md).

## Layout

| Path | What |
| --- | --- |
| `packages/db` | Drizzle schema, migrations, RLS policies, actor scoping |
| `packages/core` | Domain services (documents, collections, workspaces, groups, images) |
| `packages/editor` | Shared document model: schema, markdown round-trip, authorship, edit ops |
| `apps/server` | Fastify: tRPC, Better Auth (+ MCP OAuth), Hocuspocus, MCP, images |
| `apps/web` | React SPA (Tiptap editor, blame view, start page, sharing) |
