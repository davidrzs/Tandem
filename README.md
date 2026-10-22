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
- **Inline comments.** Select any text and start a thread —
  anchors ride the CRDT, so discussions follow the text through edits. Reply,
  resolve, reopen; commenting needs only read access.
- **Rich content.** GitHub-flavored tables, syntax-highlighted code blocks,
  inline math (`$E=mc^2$`, rendered with KaTeX), callouts and collapsible
  toggles, alongside the usual headings, lists, quotes, and images. Long
  documents get a contents rail that tracks where you're reading.
- **Tags and version history.** Label documents and filter by them (`#tag` in
  search); every document keeps point-in-time versions you can preview and
  restore, with the restore itself attributed like any other edit.
- **Bring your own notes.** Import a markdown-zip wiki export or an Obsidian-style
  vault, and export any collection or your whole workspace back out.
- **The usual wiki bones.** Nested documents in collections, full-text search
  (⌘K), archive/restore, drag-to-reorganize, per-collection sharing with
  users/groups, invites — all enforced by Postgres row-level security.
- **An action-oriented start.** Home brings unread collaboration, assigned
  tasks, favorites and private browser-local recents together. First-time users
  get a real human+AI editing walkthrough; notifications jump to the exact
  comment, and AI review links open the precise attributed edit session.

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

## Templates

Any page can be a template: **Save as template** in its row menu names it,
and the page stays an ordinary document (same editor, blame and versions).
**Default template…** on a folder or collection makes **+** there start from
that template; the deepest folder with a default wins, then the collection.
The **▾** beside **+** (in the sidebar and on a Contents panel) offers every
template and a **Blank page**.

A new page copies the template's body and up to three levels of its sub-pages,
as writing by whoever created it. `{{date}}`, `{{title}}`, `{{me}}` and
`{{parent}}` are filled in; any other `{{name}}` is asked for when the page is
created. The new page remembers which template and version it came from, and
later edits to the template never change it. Templates and their sub-pages are
left out of search, backlinks, recents, tags, tasks and Home.

## Types and properties

A page can have a type (Meeting, Project) and typed properties: text,
number, checkbox, date, date and time, select, multi-select, URL, a page
reference, a list of page references, and read-only imported JSON. A
workspace owner or admin defines types and their fields, plus ad-hoc fields
any page can hold; every definition change is in the workspace audit log.
Detaching a page's type keeps its values.

Values live in the page's collaborative document, one entry per field, so
they merge field by field when people and agents edit at once, carry blame
like the body, and come back when a version is restored. Every write changes
single fields; nothing rewrites the whole set. The server validates values
when it saves the page: one that no longer fits its field (after a kind
change, say) is kept and reported, never dropped. Property text is searchable.
Renaming a field keeps its old key working.

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
  "David's AI", distinct from "David".
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
its edits are blamed to your AI). The agent has colleague-level access:

- **Content**: `list_collections`, `create_collection`, `list_documents`,
  `recent_documents`, `get_document`, `search_documents` (also filters by an exact tag),
  `create_document`, `update_document` (title and/or tags), `move_document`,
  `archive_document`, `restore_document`, `list_archived`, `list_tags`,
  `list_backlinks`.
- **Templates**: `list_templates`, `create_from_template` (`templateId`
  optional: the target folder's default, as **+** in the app; `variables`
  answers the template's prompts; `dryRun` returns the expanded pages without
  creating anything).
- **Properties**: `get_document` returns `type`, `properties` (display values
  by field key; page references as `{id, title, url}`) and `property_issues`
  beside `markdown`, never inside it. `set_properties` takes a patch (`set`,
  `unset`, `add`, `remove`) by field key; keys and option labels match
  case-insensitively, and an unknown key is an error listing the page's
  fields (agents can't define fields). `create_document` takes `type` and
  `properties`; `list_types` and `list_fields` describe the schema. Property
  writes are audited.

`list_documents` is intentionally bounded for agent context windows: it returns
a flat, compact page (`id`, `title`, `path`, `tags`, `updatedAt`, `url`),
defaults to top-level documents only, and accepts `depth`, `limit`, `cursor`,
`updated_after`, `fields`, and `parentDocumentId` (one document's subtree).
`recent_documents` provides a separately paginated, newest-first view across all
readable collections or one collection. `search_documents` ranks lexically, so
`excludeDocumentIds` and `excludeTags` exist to keep documents that merely quote
a query (a backlog of example searches) out of the results. `list_tags` returns
each tag with its document count.

- **Targeted edits**: `edit_document` (exact find/replace),
  `insert_after_heading`, `replace_section`, `append_section`. There is
  deliberately no full-body-rewrite tool: it would re-attribute the whole
  document to the agent and destroy human blame.
- **Images**: `request_image_upload` (a short-lived signed bearer token — the
  agent POSTs the file bytes directly, e.g. with curl, instead of inlining
  base64; alt text is given up front so it can't be lost in transit; 25MB cap)
  and `upload_image` (base64 in, for small images; 3MB cap). Both yield a
  private workspace image and a `![alt](/api/images/<id>)` snippet to embed
  with the edit tools; raster formats only.
- **Collaboration**: `list_comments`, `add_comment` (reply via `parentId`),
  `resolve_comment` — comment threads sync live into open editors;
  `my_tasks` (to-dos assigned to the human the agent acts for);
  `list_members` (names and `@handles` for assigning and mentioning).
- **History & blame**: `list_versions`, `read_version` (a past version's
  markdown and properties), and `get_authors` — the blame view as data: every
  span of text and every property value attributed to the human or AI
  session that wrote it.

Document, collection, and comment objects returned by MCP include an absolute
`url` for handing a clickable link back to the user. These canonical links are
ID-based, so renaming or moving an item does not invalidate them.

## Rich content, tags, and versions

- **Tables / code / math.** Insert a table from the `/` menu; code blocks are
  highlighted by language (from the ```` ```lang ```` fence); `$…$` (inline) and
  `$$…$$` (centered display) render with KaTeX. Math is stored as its TeX source,
  so it round-trips through markdown, carries blame, and stays editable by
  agents. Table column-alignment and merged cells aren't modeled yet (a table
  serializes to plain GitHub pipes).
- **Callouts and toggles.** Insert a **callout** (`/callout`) for a coloured
  note/tip/warning/important/caution box, or a **toggle** (`/toggle`) for a
  collapsible section. Both round-trip through markdown in their standard forms —
  callouts as GitHub/Obsidian alert blockquotes (`> [!note] …`, `> [!warning]-`
  for a folded one), toggles as `<details><summary>…</summary></details>` — so
  they carry blame and stay agent-editable, and an Obsidian vault's callouts
  import as-is. Folding a section is a local view only; it never edits the
  document, so reading one leaves no trace in blame or history.
- **Contents rail.** A document with two or more headings shows a
  table of contents in the left margin that highlights the section you're reading
  and jumps to a heading on click. It's a live view of the headings — nothing is
  stored in the document. (It steps aside when the comments/history rail is open
  or on a narrow screen.)
- **Tags.** Add tags under a document's title; filter with `#tag` in search
  (a `#tag` on its own browses everything carrying it). Tags are per-document
  labels — not a folder system.
- **Versions.** Tandem snapshots a document's state at the end of each editing
  session and periodically during long ones. Open **History → Versions** to
  preview a past version and **Restore** it; the restore is a normal attributed
  edit, so only the reverted spans are blamed on you and the pre-restore state
  is itself captured (nothing is lost). Old snapshots are pruned daily after
  `SNAPSHOT_RETENTION_DAYS` (default 180); the newest ten versions of every
  document are always kept. You can only export what you can read.

Import (Settings → Data) accepts that same layout, so **markdown wiki backups** and
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
