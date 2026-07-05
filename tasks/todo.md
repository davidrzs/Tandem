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
