# Typed properties — design proposal (v2)

Status: PROPOSED, not implemented. 2026-08-24. This supersedes the fixed
project/task/entity schemas sketched in Phases 4–6 of the "Tandem Improvement
Ideas" document. Revised after a three-way adversarial review (storage/CRDT,
product/agent-ergonomics, security) verified against the current codebase.

## Problem

The Phase 4 plan bakes one research methodology into product columns
("Carlini pass condition" as a field name is workflow, not product). Fixed
columns make the acceptance tests easy but freeze the schema at the wrong
layer, and they don't survive the second user. The opposite pole — free-form
YAML frontmatter — is untyped, merge-hostile, and fails the same acceptance
tests it was meant to serve ("kill review overdue" needs a date type;
rename-safety needs IDs, not names).

## Invariants

1. **Documents stay the primitive.** `type_id` is nullable and null is the
   default forever. A plain wiki page never sees a properties panel and
   costs nothing.
2. **The document is canonical; everything queryable is a projection.** Same
   pattern as `search_vector` and checkbox-derived tasks. Projections are
   rebuildable and disposable.
3. **Schema edits never rewrite documents.** Values are keyed by stable
   field IDs; renames are display-only; retired fields/options flag values,
   never delete them. Adoption (backfill, promotion) may write documents —
   but only as explicit, attributed, reviewable acts.
4. **Enforcement lives at the projection step, nowhere else.** The Y.Map is
   client-writable through the collab protocol, so validation attached to
   any single write path (e.g. MCP tools) is advisory. The server-side
   projection on save is the one chokepoint all paths share: it validates,
   normalizes, and flags, trusting nothing in the map.
5. **No frontmatter in stored content, ever.** Frontmatter is emitted only
   by the export writer (field *names*, plus an embedded type block) and
   parsed/stripped on import. `content_md` never contains it — the
   derive-on-every-write pipeline would otherwise corrupt documents
   (`---` parses as a horizontal rule), pollute `search_vector`, break
   `edit_document`'s read-then-replace contract, and produce phantom tasks
   in the `listMyTodos` prefilter.

## Data model

### Types and fields

- `document_types`: `id`, `workspace_id`, `name`, timestamps. RLS
  workspace-scoped. **Editing types is admin-only and audited** — an option
  rename ("Approved" → "Rejected") is a semantic mass-rewrite of the whole
  workspace with zero document diffs, in a product whose thesis is "who
  wrote what". Rename history (aliases) is kept append-only.
- `document_type_fields`: one row per field — `id` (stable, short),
  `type_id`, `name`, `kind`, `position`, options as rows or JSONB per
  field. Row-per-field avoids the lost-update hazard of a single JSONB
  array under concurrent admin edits.
- Field kinds in v1: `text | select | multi_select | number | date |
  checkbox | url | doc`. (`user` is deliberately absent — see "Deferred".)
- Saved views live on the type: `{id, name, filter, sort}`, filter DSL
  below.

### Values

- Canonical storage: a `Y.Map("properties")` inside the document's ydoc,
  keyed by field ID. `select` stores option IDs, `doc` stores document IDs.
  Living in the ydoc means values merge via CRDT, are attributable (Y.Map
  entries carry client IDs; blame extends to them), and ride versions.
- **Every key mints a stable ID at first write**, including ad-hoc untyped
  keys (an ad-hoc key is an anonymous workspace-level field). "Promote to
  field" then only attaches metadata to an existing ID and touches zero
  documents — this is what keeps invariant 3 unconditional.
- Concurrent writes to the same key are last-writer-wins, like concurrent
  text overwrite. "Who last set it" comes from the map entry's client ID
  and the audit trail; history comes from versions.

### Projection

On every save path, the server projects the Y.Map into:

- `documents.properties` JSONB — for serving whole documents cheaply.
- `document_properties` side table — `(document_id, field_id, value_text,
  value_number, value_date, value_ref)` with plain btree indexes. Filters,
  range queries ("kill review overdue"), sorts, and group-by-reference are
  ordinary SQL. Values that fail their kind get a flag row, not a typed
  value — so one bad date can never abort a whole view (JSONB casts throw;
  GIN indexes don't cover ranges; this table is the answer to both).
- Normalization at projection: absent, null, `""`, and `[]` all project as
  *absent*; retired-option and kind-invalid values are kept and flagged.

The projection is written only alongside the same `ydocState` it was
derived from — never independently — and `set_properties` writes it
synchronously in the same call so agents get read-your-writes on
`query_documents`. For live sessions, view freshness is bounded by the
collab store debounce, and that is documented behavior.

**Prerequisite:** `CollabWriter` must learn Y.Map writes. Without it, a
property set through the writer-less fallback during a live session is
silently dropped from the CRDT on the next debounced store while the
projection keeps it — permanent split-brain.

## Validation semantics

- Soft and symmetric. Human panel edits and agent `set_properties` both
  succeed on missing/incomplete data and surface `warnings`; standing lint
  views ("Active without owner", "Kill review overdue") are the enforcement
  mechanism — an empty view is compliance.
- Hard refusal only for type errors (wrong kind, unknown option), where
  fabrication is impossible. Hard gates on *missing* data are rejected by
  design: a refused agent satisfies the validator by inventing a value,
  converting visible missing data into plausible wrong data. No
  agent-only asymmetry — it contradicts the colleague-level access model
  and is not a security boundary anyway (invariant 4).
- Validation covers only the fields being written. A legacy document that
  predates a field is never wedged by unrelated gaps.
- `user`-reference resolution (when the kind ships) must be
  workspace-membership-scoped, rendering non-members as unknown — a
  system-scoped ID lookup is a cross-workspace identity oracle on
  multi-tenant instances.

## MCP surface

`list_types`, `set_document_type`, `set_properties`, `query_documents`
(typed filters, keyset pagination), plus property filters on
`search_documents`. Ergonomics requirements (LLMs are the primary caller):

- Accept field *and option* names case-insensitively everywhere; resolve to
  IDs when unambiguous; ambiguity errors list candidates.
- Every validation error embeds the type's full field schema inline.
- `get_document` returns properties dual-keyed (ID + name + display value)
  as a structured field beside clean markdown — never inside it.
- `properties` stays out of `list_documents` defaults (opt-in via `fields`)
  to preserve the bounded listing contract.

## Views

- A view is implicitly scoped to its type (otherwise "No next action"
  matches every prose document in the workspace — key absent).
- Filter DSL is a closed, versioned zod discriminated union:
  `empty | not_empty | eq | in | lt | gt` per kind, `v: 1`. The same schema
  is `query_documents`' input schema, so agents learn it from the tool.
  New operators require a version bump and a decision — this is the fence
  against the DSL becoming an unversioned query language.
- v1 surfaces views as filter tabs on the collection page. Query blocks
  embedded in documents are explicitly later.

## Linking

Prose links stay `pageRef` nodes (`[title](/d/<uuid>)`), backlinks stay
derived. The `doc` field kind adds *named* relations ("parent research
program") in the indexed `value_ref` column. Backlinks then have two
sources — body pageRefs and incoming property references — and the panel
labels the latter by field name ("referenced as *parent program* by 3
projects"). Reference titles resolve at read time, RLS-scoped; a reference
to an unreadable document renders as restricted, never its title.

## Adopting structure on an existing corpus

Introducing a type writes only `type_id`; prose is untouched and remains
canonical. Backfill is an agent job — extract `status`, `kill criterion`,
etc. from prose into `set_properties` — attributed, audited, reviewable,
with lint views doubling as the progress tracker. Kind changes never
convert values; conversions are agent-proposed batches reviewed the same
way.

## Versions

Snapshots already capture the ydoc bytes, so the map is stored. Restore
must include the properties map (restoring text while silently keeping
current properties is a footgun). Known follow-ups, not v1: property diffs
in version previews; snapshot byte-dedupe degrades under property churn.

## Shipped template

One editable "Research Project" type per workspace seed, carrying the
Phase 4 fields (minus owner) and views: Potential projects, Active
projects, Awaiting a decision, No next action, Kill review overdue.
The fixed schema becomes data, not code.

## Explicitly out of v1

- Rollups, formulas, computed fields, joins beyond group-by-reference.
- Per-block objects: tasks stay checkbox-derived; no second task store.
- Value migrations on kind change (flag, don't convert).
- Entity dedup/merging (linking only ever suggests).
- Query blocks in documents; board/kanban UI; cross-workspace types.
- Frontmatter anywhere except the export writer.

## Deferred: the `user` kind and lifecycle gates

Cut from v1 because the pair produces three failures at once: the identity
oracle (above), agent value-fabrication under hard refusal, and a second
ownership concept incoherent with checkbox `@mention` tasks (a document
with `Owner: alice` that never appears on Alice's Home is the "second,
poorly synchronized to-do list" the improvement plan explicitly fears).

**Open product decision, blocking `user`:** do properties feed the
existing surfaces (Home, my-tasks, notifications), or remain separate from
`@mention` tasks? Everything else in this design is independent of that
call.

## Acceptance-test mapping (Phase 4)

- "Which projects have not passed their Carlini test?" — typed filter on a
  template field; no semantic inference.
- "Kill review overdue" — indexed date range on the side table.
- "A killed project retains reasoning and artifacts" — it is still a
  document; views just stop matching it.
- "Every active project has one owner" — deferred with the `user` kind.

## Build order

1. Migrations + `TypeService` + projection (incl. `CollabWriter` map
   support) — agents can use structure before any UI exists.
2. MCP tools.
3. Properties panel.
4. Collection-page views.
5. Research Project seed template + agent backfill of the existing corpus.
