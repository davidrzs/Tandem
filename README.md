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
its document; checking the box completes it everywhere. Below them, **Due
soon** lists pages whose due or review date (a date field keyed like `due` or
`next_review`) has passed or falls in the next 30 days.

Every save also records the page's tasks in a `tasks` table: text, done,
assignees, order, who wrote the item (from blame), when it was added and when
it was closed. Each task item carries a block id that stays with it through
edits above it, rewording and markdown round trips; markdown itself never
shows the id.

### Live sections

A live section is a read-only list the page works out each time it renders.
Insert one from the `/` menu:

- **Open from last time**: the open tasks of the previous page of the same
  type under the same parent (the previous meeting).
- **Since last meeting**: pages edited, tasks closed and tasks added since that
  page's date, under the nearest typed page above this one (the project).
- **Open tasks under this page**: open tasks in the pages below this one.

In markdown (export, MCP, import) a live section is an HTML comment such as
`<!-- live-section: open_from_last_time -->`. Search and the task list ignore
it. The starter Meeting template opens with the first two and the Project
template ends with the third.

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
workspace owner or admin defines types and their fields; ad-hoc fields (any
page can hold one) come from a markdown import or from **Add field** on a page
that already shows properties. Every definition change is in the workspace
audit log.
Detaching a page's type keeps its values.

Values live in the page's collaborative document, one entry per field, so
they merge field by field when people and agents edit at once, carry blame
like the body, and come back when a version is restored. Every write changes
single fields; nothing rewrites the whole set. The server validates values
when it saves the page: one that no longer fits its field (after a kind
change, say) is kept and reported, never dropped. Property text is searchable.
Renaming a field keeps its old key working.

In the app, the **Type** button in a page's header attaches, changes or
detaches its type, and owners and admins can create a type there. The page's
properties sit under its title as one summary line that opens into a row per
field; owners and admins also get **Add field**. Values an agent wrote carry
an AI badge naming the agent. When every page in a Contents table shares a
type, the table shows that type's first three text-like fields (not page
references or JSON) as sortable columns.

A template can give the pages made from it a type and default values. On a
template's page, the **Type** button sets that type and the panel under the
title edits each field's default (owners and admins): a value, or **Today**,
**Now**, **The creator's name**, or **Same as the previous page**, which
copies the field from the latest page of the type under the same parent (by
its date field, else the newest). A new page gets its type and those values as
the creator's writing; changing the template later leaves existing pages as
they are.

**Add starter types** in the **Type** menu (owners and admins) adds Meeting
(date, attendees, status), Project (status, next review, next action) and
Person (email, affiliation, aliases) with a template each. The Project
template has a **Meetings** sub-page whose **+** makes a Meeting dated today
with the previous meeting's attendees. Running it again adds only what is
missing; types and templates that already exist by name are kept as they are
(an older Meeting template does not gain the live sections).

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
- **Templates**: `list_templates` (each with its `type` and `defaults` by
  field key), `create_from_template` (`templateId` optional: the target
  folder's default, as **+** in the app; `variables` answers the template's
  prompts; the created page comes back with its committed `type` and
  `properties`; `dryRun` returns the expanded pages without creating anything).
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
  `open_tasks` (unchecked items of one page, of a page and everything under
  it, or of the previous page in a series, each with its stable `blockId`);
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

Properties travel as YAML front matter. An export writes each page's values
(option labels, page references as `"[[Title]]"`, ISO dates) in its type's
field order and then alphabetically, with the page's `tandem-id` and
`tandem-type`, and describes every type and field in `_tandem/fields.json` at
the zip root. An import keeps front matter as properties: with that file the
kinds and options come back exactly; without it (an Obsidian vault) each key
gets one kind across the whole vault, values that disagree become text (a
plain date in a key that also holds date-times becomes that day at 00:00
UTC), and nested values become read-only JSON. `tags`/`tag`, `tandem-id` and
`tandem-type`, in any case, are always the page's tags, id and type, never
fields. Keys that match a field (or a field's
old key) land on it; others become new fields, which needs an owner or
admin. Re-importing an export into the same workspace updates the pages it
came from, field by field, instead of copying them: a changed value is one
change, a deleted key clears its field, and titles, tags and bodies stay as
they are. YAML comments and formatting are not kept, and the summary names
the files that had comments.

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
