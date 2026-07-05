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
- **Cross-references.** Type `@` to link another page as a live chip: the
  reference is bound to the document's ID, so moving it never breaks a link
  and renaming updates every mention. Each page lists what links to it.
- **Inline comments.** Select any text and start a thread, Outline-style —
  anchors ride the CRDT, so discussions follow the text through edits. Reply,
  resolve, reopen; commenting needs only read access.
- **Rich content.** GitHub-flavored tables, syntax-highlighted code blocks, and
  inline math (`$E=mc^2$`, rendered with KaTeX) alongside the usual headings,
  lists, quotes, and images.
- **Tags and version history.** Label documents and filter by them (`#tag` in
  search); every document keeps point-in-time versions you can preview and
  restore, with the restore itself attributed like any other edit.
- **Bring your own notes.** Import an Outline backup or an Obsidian-style vault
  (markdown zip), and export any collection or your whole workspace back out.
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
start of a line — or `- [ ] ` in a bullet list, or use `/to-do` — and `@`
autocompletes workspace members.
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
  invoked it — never an anonymous "AI". Blame renders it possessively:
  "David's AI", distinct from "David". (The local stdio MCP has no sign-in;
  set `TANDEM_USER=<your email>` so its edits are your AI too — otherwise
  they're attributed to a visible "Local agent".)
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
`create_document`, `update_document` (title and/or tags), `edit_document`,
`insert_after_heading`, `replace_section`, `append_section`, `move_document`,
`archive_document`. `search_documents` also filters by an exact tag. There is
deliberately no full-body-rewrite tool: it would re-attribute the whole document
to the agent and destroy human blame.

A local stdio variant (`pnpm --filter @tandem/server mcp`) runs system-scoped
against `DATABASE_URL` for personal/offline use; set `TANDEM_USER` (your email
or user id) so its edits appear in blame as your AI.

## Rich content, tags, and versions

- **Tables / code / math.** Insert a table from the `/` menu; code blocks are
  highlighted by language (from the ```` ```lang ```` fence); inline `$…$` renders
  with KaTeX. Math is stored as its TeX source, so it round-trips through
  markdown, carries blame, and stays editable by agents. Block `$$…$$` math and
  table column-alignment/merged-cells aren't modeled yet (a table serializes to
  plain GitHub pipes).
- **Tags.** Add tags under a document's title; filter with `#tag` in search
  (a `#tag` on its own browses everything carrying it). Tags are per-document
  labels — not a folder system.
- **Versions.** Tandem snapshots a document's state at the end of each editing
  session and periodically during long ones. Open **History → Versions** to
  preview a past version and **Restore** it; the restore is a normal attributed
  edit, so only the reverted spans are blamed on you and the pre-restore state
  is itself captured (nothing is lost). Snapshots are kept indefinitely — there
  is no retention/pruning policy yet.

## Import and export

Export any collection (its `…` menu) or your whole workspace (Settings → Data)
as a markdown zip in Outline's layout — collection folders, child documents
nested in a same-named folder, attachments under `uploads/`, tags as YAML front
matter. You can only export what you can read.

Import (Settings → Data) accepts that same layout, so **Outline backups** and
**Obsidian-style vaults** both work: folders become collections and nested
documents, relative `[links](other.md)` and `[[wikilinks]]` become live
cross-references, and images are uploaded and re-pointed. Everything is created
as **you** (blame), in one attributed edit per document. Non-image attachments
and SVGs are skipped (SVG is a script vector), and unresolved links are left
as-is and reported in the summary.

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
