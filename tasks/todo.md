# Tandem build-out — living status

Brief: authorship/blame, MCP targeted edits, TODOs + start page, finish core product UI,
deploy fix, quality bars.

## Design decisions (settled)

- **Blame storage**: Y.Map `authors` inside each Y.Doc, keyed by Yjs clientID (string) →
  `{ userId, name, ai: boolean, at: epoch-ms }`. Persisted automatically with `ydoc_state`.
  Insert attribution = item.id.client → authors entry. No deletion attribution (not required).
- **Why not PermanentUserData**: it tracks delete-sets we don't need and has no room for
  ai-flag/timestamp; a plain map keyed by clientID is smaller and simpler.
- **Server-side truthfulness**: clients never self-stamp. The Hocuspocus `onChange` hook
  parses update metadata and stamps any unknown clientID with the *authenticated*
  connection's user (never overwrites). Server-side edits run under a fresh clientID per
  edit, stamped in the same transaction.
- **One edit implementation**: `applyAttributedEdit` / `applyEditToState` in @tandem/editor.
  updateYFragment structural diff = unchanged nodes keep CRDT identity and authorship.
  Used by collab-writer (live docs) and core editBody (stdio fallback), so ydoc_state never
  goes stale on either path.
- **MCP tool surface**: edit_document (exact old_string→new_string, must match once),
  insert_after_heading, replace_section (heading kept), append_section. update_document is
  title-only — no full-body rewrite anywhere.
- **Blame UI**: off by default; "Authors" toggle colours spans per author (subtle tints from
  a deterministic hue hash shared with presence carets), hover card shows name/AI/time,
  legend lists contributors. AI = dotted underline + small "AI" tag; no loud banners.
- **TODO syntax**: `- [ ] @handle text` (handle = email local part or full email).
  taskList/taskItem in the shared schema; canonical serializer emits `- [ ]` GitHub form;
  parser upgrades all-task bullet lists. `/` slash menu has To-do list; `@` autocompletes
  workspace members (plain-text mentions).
- **Routing**: react-router-dom; `/` = start page (my TODOs), `/d/:docId` = document.
- **publishedAt**: dropped (migration 0007) — publish flow out of scope.
- **Lifecycle**: archive/restore/delete stamp the whole subtree (recursive CTE, RLS-scoped);
  archived docs leave tree/search/todos; listArchived returns subtree roots.
- **Search**: returns metadata + ts_headline snippet (chr2/chr3 delimiters), never body/binary.

## Done (all verified by tests)

- [x] Phase 0: baseline green; uploads volume + UPLOADS_DIR in docker-compose (+DEPLOY.md)
- [x] Phase 1: authorship foundation — editor pkg (authors map, attributed edits, blame
      spans, markdown ops), core (seeded creation, editBody, canWrite/system, loud
      saveCollabSnapshot), server (attributed collab-writer w/ permission gate, onChange
      stamping, UNKNOWN legacy seeds), MCP targeted edit tools + permission errors
- [x] Phase 2: blame UI (toggle/legend/hover), presence (CollaborationCursor + peer dots),
      real sync status (provider status/synced), workspaces.members endpoint
- [x] Phase 3: task lists in schema + markdown round-trip; TODO aggregation (listMyTodos,
      RLS-scoped, archived excluded); start page; react-router deep links
- [x] Phase 4: search UI (Cmd+K modal, snippets); doc lifecycle UI (archive/restore/delete,
      archived section, DnD reparent + reorder); collection rename/delete (owner/admin);
      sharing UI (default role, user/group grants, revoke); People modal (member list,
      invites w/ role+expiry, group management incl. removeMember/delete); error boundary +
      query error states everywhere
- [x] Phase 5 (partial): published_at dropped; RLS functions honour collections.deleted_at;
      renderMarkdown/defaultWorkspaceId deleted; every service method wired; tRPC
      documents.get (binary-shipping, unused) removed; search slimmed
- [x] E2E suite (Playwright, real server, in-memory DB): full journey, tenant isolation,
      two-user invite/presence/blame/read-only/group-grant — 3 specs green
- [x] Unit/integration: 50 tests green (editor 28, core 12, server 10); typecheck 5/5

## Reviews (fresh-context subagents) — done, findings addressed

Security review: RLS/actor model, images access, XSS sinks, MCP gating all
confirmed SOLID. Findings fixed:
- HIGH: SVG upload stored-XSS → SVG rejected at upload; /api/images/:id now
  sends nosniff + Content-Disposition: attachment + sandbox CSP.
- MEDIUM: blame forgery by writable collaborators → self-forging sessions are
  corrected server-side (sanitizeClientAuthorsWrites, connection-origin only);
  residual risk documented honestly in README ("Honest limits").
- LOW: create() now validates parentDocumentId is in the same collection;
  grants/group-members validate the principal belongs to the workspace.
- INFO: image tmp-file cleanup + non-UUID id → 404.

Brief compliance: PASS on all six areas. Gaps fixed: dead CollectionService.get
deleted; tRPC documents.update maps RLS-null to FORBIDDEN; stdio-MCP
attribution exception documented in README; DnD now e2e-covered.

## Status log

- Repo mapped; plan written.
- Phase 0+1 done: attribution model implemented and tested end-to-end.
- Phases 2–4 backend + full web UI rebuilt on react-router.
- E2E suite added (4 specs: journey, isolation, two-user collab/ACL, DnD).
- Deploy fix + DEPLOY.md note; dead code removed; published_at migration shipped.
- README written (product identity, task syntax, blame model + honest limits).
- Security + compliance reviews done; all findings addressed.
- FINAL: 54 unit/integration tests, typecheck 5/5, web build, 4/4 e2e — all green.

## Post-review round (user-driven, all verified + committed)

- Design system rebuilt from scratch ("paper & ink": Inter UI + Source Serif
  prose, petrol accent, SVG icons, real dialogs); then dialogs/menus moved onto
  Radix primitives under the same skin (focus trap, keyboard nav, positioning).
- Inline comments (Outline-style): RelativePosition anchors, replies, resolve;
  live sync over Hocuspocus stateless pings (no polling).
- Cross-references: pageRef inline node bound to document ID (move-proof),
  live-title chips (rename-proof), [title](/d/id) markdown round-trip,
  backlinks ("Linked from") per document.
- Search: per-term prefix matching (titles + bodies); mention tints; byline;
  width toggle; unified 720px column; error boundary humanized.
- History rail: per-session edit history from the authorship layer with
  per-session highlight filtering (snapshots/restore explicitly future work).
- Settings: per-user MCP kill switch enforced at /mcp; connect instructions;
  workspace audit trail of agent actions (append-only, RLS-read, system-write).
- Suites: 63 unit/integration tests, 6 e2e specs, typecheck, build — all green.

## Feature batch: fixes, tags, rich content, import/export, versions

Order was: fixes -> tags -> editor blocks -> import/export -> snapshots, one
commit each, suites green per step.

- Step 0 (fixes): task-checkbox vertical alignment (zero inner <p> margins,
  centre the box); a TaskListInputRule so `- [ ]`/`[x]` in a bullet list
  converts to a checklist live (built-in wrappingInputRule can't fire inside a
  list). Refreshed the stale .mjs e2e setup into a shared _helpers.mjs.
- Step 1 (tags, migration 0010): documents.tags text[] + GIN index; normalized
  in the service; listTags + tag search (incl. tag-only browse); tRPC + MCP
  surface; TagBar chips under the title; `#tag` parsing in search.
- Step 2 (rich content): Table nodes in the shared schema + GFM parse/serialize
  (token-remap plugin + pipe serializer; alignment/merges not modeled);
  CodeBlockLowlight highlighting (web); inline KaTeX via a decoration plugin
  ($…$ stays plain text -> round-trips, blame- and MCP-safe). Slash "Table" +
  a table bubble menu.
- Step 3 (import/export): fflate; transfer/{markdown-zip,export,import,routes}.
  Outline layout, Obsidian vault support, front matter for tags, relative link
  + wikilink rewriting, image up/download, zip-bomb caps, two-phase import for
  single-session importer blame. Shared saveImageBytes/readImageBytes/uploadsDir.
  Vite dev proxy collapsed to /api. Settings "Data" + collection "Export".
- Step 4 (snapshots, migration 0011): document_snapshots (system-write, RLS
  read-only); SnapshotService (boundary/interval/pre-restore capture with a
  byte-equality dedupe guard); restore by ProseMirror JSON via collab-writer
  (minimal-diff blame; no-op guard; pre-restore capture); tRPC list/get/restore
  (JSON, never bytes); History "Versions" + SnapshotPreview + restore banner.
- Suites: 84 unit/integration tests (editor 35, core 20, server 29), typecheck
  5/5, web build, e2e (tasks, tagging, richtext, transfer, versions + refreshed
  smoke) — all green. Final fresh-context security review of the new surfaces.

## Structural blocks: callouts, toggles + Outline-style TOC rail (DONE)

Change from v1 per feedback: the TOC is an Outline-style LEFT-SIDE RAIL (a live view
of the doc's headings that tracks scroll), NOT an inline block — so no TOC node, no
markdown round-trip, no blame for it. Callouts + toggles use the most-standard
markdown for each. Additive, no DB migration, no RLS surface.

Insertion points confirmed: shared nodes = `Node.create()` specs in
packages/editor/src/schema.ts (Image/PageRef precedent, no React — server parses);
markdown round-trip via core-ruler token-remap plugins + serializer/parser specs in
markdown.ts (taskList/table precedent; markdown-it already `html:true`); web NodeView
via `Shared.extend({ addNodeView })` (ClientPageRef/ClientImage); slash = flat ITEMS.

### Decisions (finalized — "most standard + makes sense")
- Callouts -> GitHub/Obsidian blockquote alerts `> [!TYPE] title` (note/tip/warning/
  important/caution; unknown type -> neutral callout so Obsidian's extras still
  import). Static coloured box. Most standard, matches our import/export compat.
- Toggles -> standard `<details><summary>` HTML (stays collapsible on GitHub,
  portable). Editor model toggle > toggleSummary + toggleContent (inline-editable
  title + block content). Parse = token-range remap: markdown-it (html:true) emits
  `<details…>`/`</details>` as html_block tokens and auto-parses the inner markdown
  between them (rule-6 closes on blank lines), so we remap the two ends + wrap the
  middle — comparable to the table remap.
- TOC -> left sticky rail, pure view (no node/markdown/blame). Auto from h1-h3;
  IntersectionObserver scroll-spy highlights the active section; click scrolls to it.
  Hidden when <2 headings, when a right rail (History/Comments) is open, or on narrow
  viewports (avoids app-sidebar + TOC + doc + right-rail cramming). [The one UX
  tradeoff — flag if you'd rather it stay pinned and push the doc instead.]

### Step 1 — callouts + toggles: shared schema + markdown round-trip (packages/editor)
- schema.ts: `Callout` (block, content "block+", attrs {type,collapsible,collapsed},
  parseHTML div[data-callout]); `Toggle`+`ToggleSummary`+`ToggleContent`
  (details/summary/content, parseHTML details/summary). Add to baseExtensions.
- markdown.ts: calloutPlugin (core.ruler; blockquote whose 1st paragraph inline
  starts `[!type]([+-]?)` -> remap ends to callout_open/close +attrs, strip marker,
  drop emptied 1st paragraph); detailsPlugin (html_block `<details>` +inline
  `<summary>` … nesting-aware `</details>` -> toggle_open/toggleSummary_*/
  toggleContent_* around the inner tokens). Serializer: callout (`> [!type]`+fold+
  title, `> `-wrapped content) + toggle (`<details>\n<summary>`+title+`</summary>\n\n`
  +content+`\n</details>`). Parser spec + `.use(calloutPlugin).use(detailsPlugin)`.
- Tests: callout note/warning/unknown/nested + fold `-`/`+`; toggle round-trip incl.
  summary + block content + nesting; idempotence; a blockquote NOT starting with `[!`
  stays a blockquote; a tight `<details>` still parses.

### Step 2 — web: callout + toggle node views (apps/web)
- callout-node.tsx / toggle-node.tsx: Client extensions with React NodeViews +
  commands (setCallout(type), setToggle). Callout = coloured box (icon+title+content).
  Toggle = triangle + inline summary + collapsible content; open/close is LOCAL state,
  never mutates the CRDT (no phantom blame — PageRef discipline).
- Editor.tsx: register both. slash-command.tsx: "Callout", "Toggle". styles.css:
  callout per-type palette from tokens (note=accent-wash, tip=ok, warning=warn,
  important=accent, caution=danger) + toggle triangle/indent. Icon.tsx: info if needed.

### Step 3 — web: Outline-style TOC rail (apps/web)
- TocRail.tsx: reads editor headings (recompute on update) -> nested nav; click ->
  scroll the matching `.ProseMirror` heading into view; IntersectionObserver sets the
  active entry. No doc mutation.
- Editor.tsx + styles.css: add a left sticky column to `.doc-shell` (sits in the left
  gutter, doc stays centred); show only when >=2 headings AND no right rail open AND
  viewport wide enough. Reconcile with the right rail, full-width toggle, preview mode.

### Step 4 — docs + verify
- README "Rich content": callouts (`> [!note]`), toggles (`<details>`), auto TOC rail;
  honest limits. No MCP change (agents see `> ` lines / `<details>`).
- e2e: slash-insert callout + toggle (local collapse/expand, persist+reload); a doc
  with several headings shows the TOC rail and clicking an entry scrolls.
- Verify: pnpm -r test, typecheck, web build, full e2e, screenshots (callout/toggle,
  TOC rail with active-section highlight).

Risks: two token-remap plugins (callout marker surgery; details html_block pairing)
are the fiddly parts — covered by round-trip tests. markdown-ops/MCP unaffected
(blocks are markdown lines). TOC rail's only real decision is when to hide it.

Review (all shipped, two commits): callouts+toggles (ee08a53) — shared schema
nodes + two markdown-it token-remap plugins + serializer/parser entries (5 editor
round-trip tests), web node views (local fold = no CRDT mutation, no phantom
blame), slash items (toggle insert lands the caret in the summary), per-type
palette from tokens; e2e blocks.mjs (render, persist across reload, fold). TOC
rail — pure view (TocRail.tsx): heading list recomputed on update, scroll-spy
active section, click-to-scroll (scroll-margin clears the sticky toolbar), left
gutter column in .doc-shell, hidden when a right rail/preview/full-width is on or
<1220px; e2e toc.mjs. Verify: 90 unit + 19/19 e2e, typecheck, web build all green.
Deviation: toggles default OPEN on load (no persisted per-toggle open state in the
markdown yet — `<details open>` round-trip is a possible follow-up). Callouts have
no separate title field (GitHub model — the type is the header); an imported
`[!note] Title` keeps the title text as the first body line.

## Restyle: "Outline / pine" design handoff (DONE)

Source: `design_handoff_outline_app/` (Claude Design). It repaints ONE screen
(editor + sidebar). Decisions taken: adopt fully = single Hanken Grotesk (retire
the serif); plan-then-build. This is a restyle, not features — every component it
shows already exists and is wired.

Approach: drive it from the token table. ~50 refs already route through
`var(--accent*)` + tokens, so re-authoring `:root` retints all ~20 surfaces in one
move; then pixel-match the two designed surfaces on top, then sweep stragglers.

- [x] Step 1 — Typography (single Hanken). Add `@fontsource-variable/hanken-grotesk`;
  drop inter + source-serif-4 (imports in main.tsx + package.json). `--font-ui` and
  `--font-prose` both -> Hanken (keep `--font-prose` as alias; 5 rules reference it).
  `--font-mono` stays system mono (code must be monospaced — justified exception;
  handoff has no code). Math keeps KaTeX fonts. Self-host only — no Google `<link>`
  (preserves `font-src 'self'` CSP). Apply the handoff's FULL type scale (designed
  FOR Hanken's metrics, which differ from Inter): title 40/700/-0.02em, body 16/1.75,
  ws label 14/600, nav 13.5/450, collection parent 13.5/600, leaf 13/450, toolbar
  btn 13/500, section label 11/600/0.09em, meta 13, presence 11-12.5/600. Hanken's
  x-height/width differ from both Inter and the serif -> line-heights and the article
  measure need a visual rhythm pass, not just a token swap (expected rework, not a
  surprise — that's what the screenshot-diff in Step 5 is for).
- [x] Step 2 — Color tokens (pine + green-tinted neutrals). Re-author `:root`:
  surface #ffffff; paper #fbfbfa->#ffffff; sunken(sidebar) #f4f4f1->#f6f8f6;
  ink #1f2732->#132019; +ink-body #33443a; ink-2 #67707e->#5a6f63;
  ink-3 #9aa1ad->#9aab9f; line #e8e7e2->#eef2ee; line-strong #d8d7d1->#e2e9e3;
  +border-side #e6ece7; accent #17656d->#1f6b4f; accent-ink #114e54->#1a5a42;
  accent-wash ->rgba(31,107,79,.08); +hover #eaf0ea; +hover-strong #eef2ee;
  +tag-bg #f0f4f1 / +tag-hover #e6ede8; ::selection ->#cfe3d8. Sweep the 14
  `rgba(31,39,50,…)` (hovers -> tokens; shadows -> green-black `rgba(19,32,25,…)`).
  Doc-mention: #1f6b4f / underline rgba(31,107,79,.3) / hover bg #f0f7f2.
  Presence: dot #2f9e63 + glow rgba(47,158,99,.18); avatar green #3fa06a.
  Code-highlight palette left as-is this pass (works on white; retint = later polish).
- [x] Step 3 — Pixel-match the two designed surfaces (exact numbers from README):
  sidebar (14/12 pad, 26px mark r7, nav 7/9 gap11, tree branch #e2e9e3, active leaf
  #1f6b4f/600 bg #eaf0ea, footer 28px avatar); toolbar (right-aligned, .85 white +
  blur6, ghost Comments/History, 20px divider, presence stack -8px overlap, "N
  editing" #2f9e63); article (max 1080, pad 26/56/120, h1 40/700/-0.02em);
  inline collab cursors — restyle only (already wired via CollaborationCursor):
  caret -> 2px bar in the writer's color; name flag radius 4px 4px 4px 0, sits
  atop the caret, white 11px/600. Colors come from the per-user awareness palette
  (shared with blame via colors.ts) — verify it still reads against the greener
  neutrals (Step 4 check). Also in Step 3: ⌘K kbd chip (11px #93a49a, bg #eaf0ea,
  radius 5px — current uses a bordered chip); section label letter-spacing
  0.06->0.09em + margin-top 22px; collection tree caret rotation (exists as
  `.twist.open`, restyle); sidebar/main divider on the sidebar right edge
  (#e6ece7, new --border-side); page-ref/doc-mention (page-ref.tsx `.page-ref`):
  file icon + text, underline rgba(31,107,79,.3), hover bg #f0f7f2; TagBar existing
  chips take the same tag-bg/tag-hover language as the Add-tag chip.

- [x] Step 3b — TOOLBAR RECONCILIATION (the handoff omits real controls — decision
  needed, do NOT silently drop). Handoff toolbar = right-aligned Comments + History +
  presence only. The real `.editor-tools` also has: presence on the LEFT (small dots,
  not avatars), a **Full width** toggle, a **save-state** pill ("Saving/Saved" +
  dot), and a **Read only** badge. Reconciliation: (a) presence -> move right, and
  it's a MARKUP change not just CSS — enlarge dots to 28px avatars (2px white border,
  -8px overlap) and ADD the "N editing" green dot+count element (doesn't exist today);
  (b) KEEP save-state (essential UX) + Read-only, styled quietly into the right-aligned
  bar; (c) Full-width toggle — keep (restyled) or cut? PROPOSED: keep. Note: History
  IS the blame/Authors view (blameOn = rail==="history"), so "Authors" isn't missing.
  App is LIGHT-ONLY (no dark theme) -> retint is single-mode, no dark variants.
- [x] Step 4 — Extend language to undesigned surfaces (mostly inherit via tokens;
  manual pass for hardcoded cool-gray): Home, SearchModal, People/Settings/Share +
  base Modal, Comments/History rails, SnapshotPreview, TagBar, AuthGate/Consent/
  InviteAccept, ErrorBoundary, slash/bubble/suggestion menus. Check blame/authors
  generator (colors.ts) still reads against greener neutrals — the authorship layer
  stays the loud thing.
- [x] Step 5 — Docs + verify. Rewrite styles.css header comment + README identity
  para (drop "prose in a serif"; new single-Hanken/pine language). typecheck, web
  build, full e2e (assert on classes/behavior not colors — should stay green),
  screenshot-diff the designed screen vs the mockup.

Review: single-file token foundation retinted all ~20 surfaces at once; only
apps/web touched (styles.css, main.tsx, Editor.tsx, Sidebar.tsx, TagBar.tsx,
package.json). Verified: typecheck clean, web build (Hanken woff2 bundled, old
fonts dropped), e2e 17/17 (dnd assertion updated to the new indent math; tag
button text updated in crash/tagging specs), screenshots of editor / History
rail / Search modal all coherent. README had no visual-identity copy to change.
Deviations flagged: (a) code blocks keep their dark theme this pass (deferred
polish); (b) editor measure kept at 720px, NOT the handoff's 1080px — 1080 is
too wide for readable prose; easy to widen if wanted. Author/blame colours kept
(colors.ts) — the footer avatar / cursor / blame tints stay per-user, so the
authorship layer remains the loud thing against the greener neutrals.

## RLS for the four remaining tables (remove the manual-authz special case)

Goal: make `groups`, `group_members`, `collection_permissions`,
`workspace_invites` database-enforced (RLS), so a forgotten app-layer check is
backstopped by Postgres. Keep app-layer role checks as defense-in-depth + clear
error messages. One capability path (`accept_invite`) stays explicit as a
SECURITY DEFINER function (the invitee isn't a member yet, so membership RLS
can't authorize the redemption — the secret token is the capability).

- [ ] Baseline: run existing suite green (prove starting state).
- [ ] Migration `0012`: grants + RLS policies for the 4 tables + helper fns
      (`app_admin_workspaces`, `app_member_group_ids`, `app_admin_group_ids`,
      `app_admin_collection_ids`) + `app_accept_invite(text)` SECURITY DEFINER.
      Journal entry for 0012.
- [ ] Services: switch the 4-table writes from `system()` to actor-scoped
      `exec()` so RLS enforces (GroupService all; CollectionService grant/revoke/
      listPermissions; WorkspaceService createInvite). Keep manual checks.
      `acceptInvite` -> calls `app_accept_invite()`.
- [ ] New `authz.test.ts`: assert the RLS backstop (raw actor-scoped writes by
      non-admins/outsiders are refused by the DB, independent of app checks) +
      the positive paths (owner/admin succeed, invite redemption works).
- [x] Run full suite green + typecheck.

Review (DONE): The four sharing tables are now RLS-enforced.
- Migration 0012: grants + policies for groups/group_members/
  collection_permissions/workspace_invites; helper fns app_admin_workspaces,
  app_member_group_ids, app_admin_group_ids, app_admin_collection_ids; and
  app_accept_invite(text) SECURITY DEFINER for token redemption (the invitee
  isn't a member yet, so RLS can't authorize the join — the token is the
  capability; the fn acts only for current_setting('app.user_id'), so you can
  only accept as yourself).
- Services switched from system() bypass to actor-scoped exec() so RLS is the
  enforcing authority: GroupService (all), CollectionService grant/revoke/
  listPermissions, WorkspaceService createInvite; acceptInvite now calls the
  function. setDefaultRole/softDelete stay on the collections table's own RLS +
  app admin-gate (unchanged). App-layer role checks kept for clear errors +
  defense-in-depth.
- acceptInvite dropped its redundant userId param (derived from the actor);
  updated the tRPC caller + two test call sites.
- New authz.test.ts (7 cases) proves the DB backstop with RAW actor-scoped
  writes (no service call): non-admin/outsider cannot create groups, add group
  members, self-grant collection access, or forge invites; members can still
  read their groups; invite redemption joins as self, is single-use, rejects
  bogus tokens. This is the regression lock — it fails if a future method
  forgets its check.
- Verified: core 27 (incl. 7 new), server 29, editor 41, typecheck 5/5; and the
  two-user invite/sharing e2e passes end-to-end through the real HTTP server on
  a freshly-migrated DB (migration 0012 applies clean on PGlite).
- Prod note: acceptInvite normalizes execute()'s row shape across drivers
  (array for postgres-js, {rows} for PGlite); the PGlite branch is exercised by
  tests, the postgres-js branch is the standard drizzle idiom.

## Gap-closing build-out (started 2026-07-11)

Source: five-angle review (web UX, editor, server/MCP, ops, cleanliness).
Order: bugs/security first, then email, MCP parity, editor UX, app shell, platform/ops.
One commit per phase, suites green per step.

### Phase A — real bugs + security quick wins
- [x] Domain errors in core (NotFound/Forbidden/InvalidInput) + mapError -> proper tRPC codes (stop 500-ing "not found")
- [x] /api/export: rate limit + audit records for export and import
- [x] Audit sharing changes (grant/revoke/setDefaultRole) + workspace invite create/accept
- [x] /health checks DB connectivity (503 when down); LOG_LEVEL env for logger
- [x] 2FA backup codes: regenerate + remaining count in Settings
- [x] Round-trip data loss: toggle-summary marks preserved; table cells keep line structure via <br>
- [x] Stale collaborative title: broadcast meta ping on rename, editor updates when not editing

### Phase B — email infrastructure
- [ ] Mailer (nodemailer, SMTP_URL/EMAIL_FROM env, graceful off-state); DEPLOY.md docs
- [ ] Better Auth sendResetPassword + forgot-password UI (shown only when email configured)
- [ ] Invites: optional email delivery (workspace + server invites)

### Phase C — MCP colleague parity
- [ ] Tools: list_comments, add_comment, resolve_comment, my_tasks, list_members,
      list_versions, read_version, restore_document, list_tags, list_archived, get_authors (blame read)
- [ ] Comment writes ping live clients (notify wiring for MCP path)

### Phase D — editor UX
- [ ] Formatting bubble menu (bold/italic/strike/code/link + comment)
- [ ] Link add/edit/remove popover
- [ ] Placeholder ("Type / for commands")
- [ ] Code block: language label/picker + copy button
- [ ] Callout type picker; image alt-text editing
- [ ] Find in document (basic)

### Phase E — app shell
- [ ] Toast system + wire copy/mutation feedback
- [ ] Doc header: copy link, breadcrumbs; duplicate document; per-doc markdown export + print CSS
- [ ] Favorites (migration) + recents (local) on Home/sidebar
- [ ] Profile: display name + password change; active sessions list/revoke
- [ ] Dark mode (tokens + toggle + prefers-color-scheme)
- [ ] Responsive shell: collapsible sidebar drawer under ~900px
- [ ] In-app notifications: comments on your threads + task assignment (inbox + badge)

### Phase F — platform/ops
- [ ] Background jobs: snapshot retention (env) + orphaned-image GC
- [ ] Dockerfile: compiled prod build, prod deps, USER node; compose mem limits + healthy depends_on
- [ ] Biome lint/format + CI step; CI docker build
- [ ] myTodos: prefilter candidates (stop full-scan) + list caps/pagination pass

### Needs a product decision (not started)
- Public read-only doc share links (new unauthenticated surface)
- API tokens (PATs), outbound webhooks
- Embeds/mermaid; footnotes
- Full mobile polish beyond responsive shell; i18n/RTL
- S3/object storage; collection icons; doc emoji/covers; templates beyond duplicate
