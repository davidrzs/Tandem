# Templates and typed properties plan

Tandem pages gain templates (how a page starts) and types with typed properties (what a page is). Editors and agents write properties as per-field patches into a root `Y.Map("properties")` in each document's ydoc. YAML exists only at import and export.
The rule the program enforces is that every property write is a patch (`set`, `unset`, `add`, `remove`) on one field id, never a full replace.
The PR ids in order are P0, P1, P2, P3, P4, P5, P6, and P7.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs `/home/david/.agents/skills/poteto-mode/playbooks/autopilot-stack.md`. The work is sequenced and the operator wants review before landing, so autopilot-stack applies and not autopilot-full. No owner merges. The root appends each verified PR to one linear stack on `main`, and David lands every PR himself. P4, P6, and P7 also stop for his review of screenshots and a video.

This harness has no Cursor cloud agents and no `control-ui` skill. Each owner runs locally in its own git worktree off `origin/main`. Each live lane runs locally in a Playwright or CDP browser against the dev server, with a throwaway PGlite database and `DATABASE_URL` cleared. Review media goes under `/tmp/tandem-review/<pr-id>/`.

The pstack skills live on disk under `/home/david/.agents/skills/`, outside the Tandem repo. `git show origin/main:` cannot read them, so read them from disk with `cat`.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

### Apply the operator defaults

The program applies these defaults. David can pick the alternative on any of them before the go.

1. Template improvements never change older pages. The alternative is to offer per-page diffs later.
2. Obsidian values round-trip. YAML comments and key formatting are not kept. The alternative is a byte-exact round trip, which costs much more.
3. The workspace owner or an admin defines types and fields. Agents propose new fields. The alternative is that anyone defines a field on first use, as Obsidian does.
4. A page has at most one type. Cross-cutting labels use tags. The alternative is multiple types per page.
5. A folder default template applies on **+ New page** without asking, and the menu keeps a **Blank** option. The alternative is to always ask.
6. Kill criteria apply. Drop types and keep templates if fewer than 30% of non-default fields are filled after 4 weeks of use. Do not start P3 until David writes down 3 questions that search and filters cannot answer. The alternative is to build types without a kill gate.

## Program checklist

### Arm the program

- [ ] State the protocol and this plan to the operator, then stop. Start execution only on the operator's explicit go.
- [ ] Read these at program start. Re-read them at every tick. The skills sit outside the repo, so the `git show origin/main:` form applies only to repo files, and the skills are read from disk.
  - [ ] `cat /home/david/.agents/skills/poteto-mode/playbooks/autopilot-stack.md`
  - [ ] `cat /home/david/.agents/skills/swarm/SKILL.md`
  - [ ] There is no control skill. Read `playwright.config.ts` and `apps/web/e2e/_helpers.mjs` with `git show origin/main:playwright.config.ts` and `git show origin/main:apps/web/e2e/_helpers.mjs`.
  - [ ] `cat /home/david/.agents/skills/poteto-mode/playbooks/opening-a-pr.md`
  - [ ] `cat /home/david/.agents/skills/poteto-mode/playbooks/shipping.md`, `/home/david/.agents/skills/how/SKILL.md`, `/home/david/.agents/skills/interrogate/SKILL.md`, `/home/david/.agents/skills/no-comments/SKILL.md`, and `/home/david/.agents/skills/benchmark-checklist/SKILL.md`.
  - [ ] `git show origin/main:docs/typed-properties-design.md`
- [ ] On the operator's go, arm the audit tick as `/loop 1h` with the tick prompt below. Never leave the cadence to memory.
- [ ] Use this tick prompt, verbatim. "Re-read the execution playbook from disk. Audit the operation against it and fix drift in this tick. Probe every active lane and judge progress by side effects only. Stand down a stuck lane and dispatch its replacement now. Then post a short status message to the operator in chat only when the audit found a tracked change that no earlier status message reported, such as a PR opened, a code-ready head, a round launched or closed, a verdict, a stack append, a stuck agent and the action taken, a blocker added or cleared, or a decision only the operator can make. Name every such change and nothing else. Do not repeat a table, the stacked list, or an unchanged blocker. If the audit found none, end the turn with no reply text."
- [ ] On the operator's hold or stand-down, send every owner a zero-writes order at once.

### Spawn owners

- [ ] Spawn one owner per PR with the full lifecycle the execution playbook names. Each owner works in its own local worktree, for example `git worktree add ../tandem-<pr-id> origin/main`.
- [ ] Follow this dependency graph. Start dependent work only after its parent is verified, and base it on the parent branch because the execution playbook stacks.
  - [ ] P0 and P1 are independent and first. Both branch from `main`.
  - [ ] P2 after P0. P2 shares transfer code with P0. If it touches none, it still stacks above P0 to keep one linear chain.
  - [ ] P3 after P1 and P2. Start P3 only after David writes down 3 questions that search and filters cannot answer (operator default 6).
  - [ ] P4 after P3.
  - [ ] P5 after P3 and P0. It stacks above P4.
  - [ ] P6 after P2, P3, and P4. It stacks above P5.
  - [ ] P7 after P6.
- [ ] Hold the file boundaries.
  - [ ] P0 touches only `apps/server/src/transfer/**`, `apps/server/src/mcp/tools/write.ts`, `apps/server/src/mcp/tools/edits.ts`, `apps/server/package.json`, `pnpm-lock.yaml`, and `apps/web/e2e/transfer.mjs`.
  - [ ] P1 touches only `packages/editor/src/authors*.ts`, `apps/server/src/http.ts`, `packages/core/src/services/**`, `apps/web/src/components/blame.ts`, `apps/web/src/components/editor/useBlame.ts`, and their tests.
  - [ ] P3 is the only PR that adds `Y.Map("properties")` code to `apps/server/src/collab-writer.ts` and `packages/editor/src/**`.
  - [ ] Each PR with a schema change adds exactly one migration under `packages/db/drizzle/` through `pnpm db:generate`. Two open PRs never both add a migration on the same base.
- [ ] Hold the review gate. P4, P6, and P7 change an interaction. They wait for the operator's review in chat with screenshots and a video before merge.

### PR mechanics, for every PR

- [ ] Resolve the forge once. Default to `gh`; if `command -v origin` succeeds and Origin can resolve the repository, use `origin pr` for every PR operation. Record any fallback to `gh`. Never require `gt`.
- [ ] Open the PR ready, never draft, per **Opening a PR**. Use the run's built-in PR tool when it has one, else `origin pr create --status open --base <base-branch>` or `gh pr create --base <base-branch>` according to the resolved forge. A stack child targets its parent branch.
- [ ] Run `pnpm lint` and `pnpm typecheck` once before the PR-facing push. Push with hooks on.
- [ ] Reread the diff and cut slop before each commit, because `/deslop` is not installed here. Run `/no-comments` before review.
- [ ] Triage every Bugbot and security-reviewer comment per `/home/david/.agents/skills/poteto-mode/references/bugbot-triage.md`.
- [ ] Rebase onto current trunk before the code-ready report and babysit. Keep that merge base in fix rounds. Rebase again only at merge prep, on a `git merge-tree` conflict with trunk, or on a CI failure that comes from a change on trunk.

### Verdict and merge, for every PR

- [ ] At the code-ready head SHA and at each later push that changes the patch, run the swarm per `/home/david/.agents/skills/swarm/SKILL.md`. One gates lane runs `pnpm lint`, `pnpm typecheck`, `pnpm test`, `bash apps/web/e2e/run-all.sh`, and `pnpm --filter @tandem/web build && pnpm e2e`. The ten live lanes come from the PR's **Verify, live** block. The perf lane comes from its **Verify, perf** block. Two or more audit lanes, each with its own focus, read the diff and the receipts and distrust the PR body. The root audits the receipts in the stack-ready report before the verdict.
- [ ] Clean only when every lane is `PASS`. Findings go back to the owner, including a defect that a lane filed as a note. A new head gets a fresh swarm and a fresh verdict, except for results that stay valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] On a clean verdict, the root appends the PR to the linear stack on `main` and sets its base to the parent branch. No owner merges, arms auto-merge, or closes. After a rebase, a verdict stays valid only when `git patch-id` at the new SHA equals the patch-id at the verdict SHA, per `playbooks/shipping.md`. David lands the stack bottom-up.

### Boot recipe, for every live lane

Each live lane runs locally at the PR head in its own worktree, because this harness has no cloud VMs. Drive the app through a Playwright or CDP browser, because `control-ui` is not installed.

- [ ] `git fetch origin <head-branch> && git checkout <head SHA>`.
- [ ] Run `pnpm install`, then boot with a cleared `DATABASE_URL` and a throwaway PGlite directory, as `apps/web/e2e/run-all.sh` does. Use `DATABASE_URL=pglite://.pglite-lane-<n>`, run `pnpm --filter @tandem/db exec node --import tsx src/migrate-run.ts`, start `PORT=<3100+n> pnpm --filter @tandem/server exec node --import tsx src/serve.ts`, and start `pnpm --filter @tandem/web exec vite --port <5200+n>`. Wait until `curl -sf http://localhost:<3100+n>/health` succeeds.
- [ ] Deliver input only through Playwright page actions (`page.click`, `page.fill`, `page.keyboard`) or through MCP calls over HTTP with an OAuth token for agent scenarios. Read-only diagnostics are the server log, `page.evaluate` reads of the Yjs state, and SQL reads against the lane's PGlite directory.
- [ ] Save every screenshot to `/tmp/swarm-<pr-id>/worker-<n>/<slug>.png` and return the paths with the report.

## Keep and report frontmatter on import (P0)

**Depends on.** None.

**Files.**

- [ ] Edit `apps/server/src/transfer/markdown-zip.ts`. Replace the hand parser in `parseFrontMatter` with the `yaml` package.
- [ ] Edit `apps/server/src/transfer/import.ts`. Collect dropped keys per file in `importZip`.
- [ ] Edit `apps/server/src/transfer/routes.ts`. Return the dropped-key report in the import response.
- [ ] Edit `apps/server/src/mcp/tools/write.ts` and `apps/server/src/mcp/tools/edits.ts`. Reject leading frontmatter.
- [ ] Edit `apps/server/package.json` to add `yaml`.
- [ ] Edit `apps/server/src/transfer/markdown-zip.test.ts`, `apps/server/src/transfer/transfer.test.ts`, `apps/server/src/mcp.test.ts`, and `apps/web/e2e/transfer.mjs`.

**Build.**

- [ ] Parse frontmatter with YAML 1.2 from `yaml` in `parseFrontMatter`. Keep `tags` as today. Return every other top-level key as `dropped`.
- [ ] Make the import summary list every dropped key per file until P3 can store them.
- [ ] Make `create_document` and the body edit tools return an error that names `set_properties` when the markdown starts with a `---` frontmatter block, instead of storing a horizontal rule and an H2.

**You see.**

- [ ] Importing a zip with `status: draft` in one note shows that file name and `status` in the import summary, and the page has no horizontal rule at the top.
- [ ] An MCP `create_document` call whose markdown starts with `---\nstatus: draft\n---` returns an error that names frontmatter, and no document is created.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `markdown-zip.test.ts` gains cases for block lists, quoted strings, nested maps, and a broken fence. Each asserts the literal `tags`, `dropped`, and `body`. Run `pnpm --filter @tandem/server test`.
- [ ] `transfer.test.ts` gains a case that imports two notes with extra keys and asserts the exact summary. `mcp.test.ts` gains a case for the frontmatter rejection. Run `pnpm --filter @tandem/server test`.
- [ ] Run `pnpm test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Import the same Obsidian zip with `tags` and `status` keys at trunk and head. Trunk drops `status` with no report. Gate that head lists `status` per file and that the imported page body matches trunk byte for byte. Save `regression-import.png`. Pass when the head summary names every dropped key and the bodies match.
- [ ] Lane 2. Import a note whose frontmatter has a block list under `tags`. Save `block-tags.png`. Pass when the page shows every tag in the tag bar.
- [ ] Lane 3. Import a note with nested `review: {owner, due}`. Save `nested-dropped.png`. Pass when the summary lists `review` and the body has no YAML text.
- [ ] Lane 4. Import a note with a broken frontmatter fence. Save `broken-fence.png`. Pass when the import finishes, the summary reports the file, and the body keeps the original text.
- [ ] Lane 5. Import a zip of 50 notes, 30 with extra keys. Save `summary-50.png`. Pass when the summary lists exactly 30 files.
- [ ] Lane 6. Call MCP `create_document` with leading frontmatter. Save `mcp-reject.png` of the JSON response rendered in the browser. Pass when the error names `set_properties` and `list_documents` shows no new document.
- [ ] Lane 7. Call MCP `update_document` with leading frontmatter on an existing page. Save `mcp-update-reject.png`. Pass when the page body is unchanged in the editor.
- [ ] Lane 8. Call MCP `create_document` with a body whose first line is `---` used as a horizontal rule after a paragraph. Save `hr-allowed.png`. Pass when the document is created with a horizontal rule.
- [ ] Lane 9. Export a workspace, then reimport the zip. Save `roundtrip-tags.png`. Pass when tags survive and the summary reports no dropped keys.
- [ ] Lane 10. Import a note with a UTF-8 BOM and CRLF line endings before the fence. Save `bom-crlf.png`. Pass when the tags parse and no fence text shows in the body.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Wall time of `importZip` for a 1,000-note zip where every note has frontmatter.
- [ ] Probe. A script under `/tmp/perf-p0/` that builds the zip and times `POST` to the import route at trunk and head, 7 interleaved runs each.
- [ ] Baseline. Record the trunk median first.
- [ ] Rule. Fail when the head median exceeds trunk by more than 10% or by more than 500 ms.

**Review gate.** None. P0 changes import output and an MCP error, not an interaction.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends P0 to the stack on `main`. David lands it bottom-up.

## Show the agent in blame (P1)

**Depends on.** None.

**Files.**

- [ ] Edit `packages/editor/src/authors.ts`. Add `agent?: string` and `source?: string` to `AuthorInfo`.
- [ ] Edit `apps/server/src/http.ts` near lines 345 to 353. Resolve `oauth_access_token.clientId` to `oauth_application.name` and pass it as `agent`.
- [ ] Edit `apps/web/src/components/blame.ts` and `apps/web/src/components/editor/useBlame.ts`. Render the agent name in the blame card.
- [ ] Edit `packages/editor/src/authors.test.ts` and `apps/server/src/mcp-collab.test.ts`.

**Build.**

- [ ] Look up the OAuth application name for the token in the MCP handler in `http.ts` and set `author.agent`.
- [ ] Format the blame card label as "David's AI (Claude)" when `ai` is true and `agent` is set, and as "David's AI" when `agent` is missing.

**You see.**

- [ ] After Claude edits a page through MCP, hovering the span shows "David's AI (Claude)".

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `authors.test.ts` gains a case that stamps an author with `agent: "Claude"` and reads it back. Run `pnpm --filter @tandem/editor test`.
- [ ] `mcp-collab.test.ts` gains a case that writes through an OAuth client named "Claude" and asserts the stored `AuthorInfo` equals the literal object. Run `pnpm --filter @tandem/server test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Edit a page through MCP with an OAuth client named "Claude" at trunk and head, then hover the span. Trunk shows "David's AI". Gate that head shows "David's AI (Claude)". Save `regression-blame.png`. Pass when head shows the agent name and trunk's label is otherwise unchanged.
- [ ] Lane 2. Edit through a second client named "Cursor". Save `two-agents.png`. Pass when each span shows its own agent.
- [ ] Lane 3. Edit as a human in the browser. Save `human-span.png`. Pass when the card shows the human name with no agent suffix.
- [ ] Lane 4. Open a page whose blame was written before this PR. Save `legacy-span.png`. Pass when the card shows "David's AI" with no error.
- [ ] Lane 5. Rename the OAuth application after the edit. Save `renamed-app.png`. Pass when the card keeps the name from stamp time.
- [ ] Lane 6. Call MCP `get_authors`. Save `get-authors.png`. Pass when the response includes `agent` for the AI entry.
- [ ] Lane 7. Restore an older version after an agent edit. Save `restore-blame.png`. Pass when restored spans blame the human restorer.
- [ ] Lane 8. Two browsers watch while the agent edits. Save `live-blame.png`. Pass when both show the agent name without reload.
- [ ] Lane 9. Use the local system MCP. Save `system-mcp.png`. Pass when the card shows the system author with no crash.
- [ ] Lane 10. Delete the OAuth application, then edit with a still-valid token. Save `deleted-app.png`. Pass when the edit succeeds and the card falls back to "David's AI".

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Latency of the MCP request setup in `http.ts`, from request start to the first tool call, which now includes one extra query.
- [ ] Probe. A script under `/tmp/perf-p1/` that sends 200 `get_document` MCP calls at trunk and head, interleaved in 7 runs.
- [ ] Baseline. Record the trunk p50 and p95 first.
- [ ] Rule. Fail when the head p95 exceeds trunk by more than 5 ms.

**Review gate.** None. The blame card text changes, but the interaction does not.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends P1 to the stack. David lands it bottom-up.

## Add templates as documents (P2)

**Depends on.** P0, for shared transfer code only. It stacks above P0.

**Files.**

- [ ] Edit `packages/db/src/schema.ts`. Add `templates(document_id, workspace_id, name, default_type_id null)` and `default_template_id` on `collections` and `documents`.
- [ ] Create one migration under `packages/db/drizzle/` with `pnpm db:generate`.
- [ ] Create `packages/core/src/services/templates.ts` for list, templatize, instantiate with variables, and the subtree copy capped at 3 levels.
- [ ] Edit `packages/core/src/services/document-queries.ts`. Exclude templates from search, backlinks, recents, and tasks.
- [ ] Edit `apps/server/src/trpc.ts` for the template routes.
- [ ] Create `apps/server/src/mcp/tools/templates.ts` with `list_templates` and `create_from_template` with `dryRun`. Register it where the other tool files register.
- [ ] Edit `apps/web/src/components/useCreateDocument.ts`, `apps/web/src/components/create-document.ts`, `apps/web/src/components/sidebar/useSidebarActions.tsx`, `apps/web/src/components/CollectionPage.tsx`, `apps/web/src/components/DocumentPage.tsx`, and `apps/web/src/components/Home.tsx`.
- [ ] Create `apps/web/e2e/templates.mjs`. Edit `packages/core/src/core.test.ts` and `apps/server/src/mcp.test.ts`.

**Build.**

- [ ] Store a template as a document plus a `templates` row. Expand `{{date}}`, `{{title}}`, `{{me}}`, and `{{parent}}` at instantiation.
- [ ] Resolve the deepest `default_template_id` on **+ New page**, and keep **Blank** in the menu.
- [ ] Add **Save as template** and a **New page** menu in the sidebar and on the Contents page.
- [ ] Exclude template documents and their bodies from tasks, search, backlinks, and Home.
- [ ] Never change existing pages when a template body changes.

**You see.**

- [ ] A folder with a default template creates a new page with that template's body and today's date in place of `{{date}}`.
- [ ] Search for a word that exists only in a template body returns no results.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `core.test.ts` gains cases for variable expansion, the deepest default, the 3-level cap, and search exclusion, each against literal expected bodies and ids. Run `pnpm --filter @tandem/core test`.
- [ ] `mcp.test.ts` gains `list_templates` and `create_from_template` with and without `dryRun`. Run `pnpm --filter @tandem/server test`.
- [ ] `apps/web/e2e/templates.mjs` covers **+ New page** with a folder default. Run `bash apps/web/e2e/run-all.sh`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Click **+ New page** in a folder at trunk and head. Trunk has no templates, so record that. Gate that head with no default creates a blank page the same as trunk, and that head with a folder default creates the expanded template page. Save `regression-new-page.png`. Pass when both cases hold.
- [ ] Lane 2. Save a page as a template, then create from it. Save `templatize.png`. Pass when the new page body equals the template with variables expanded.
- [ ] Lane 3. Set a default on a folder and a different one on a subfolder. Save `deepest-wins.png`. Pass when a page in the subfolder uses the subfolder template.
- [ ] Lane 4. Pick **Blank** from the menu in a folder with a default. Save `blank-option.png`. Pass when the page is empty.
- [ ] Lane 5. Instantiate a template with a 4-level subtree. Save `subtree-cap.png`. Pass when 3 levels are copied and the 4th is not.
- [ ] Lane 6. Put an unchecked task in a template body. Save `tasks-excluded.png`. Pass when Home and `my_tasks` do not list it.
- [ ] Lane 7. Link to a page from a template body. Save `backlinks-excluded.png`. Pass when the target page shows no backlink from the template.
- [ ] Lane 8. Edit a template body after creating a page from it. Save `no-retro-change.png`. Pass when the older page is unchanged.
- [ ] Lane 9. Call MCP `create_from_template` with `dryRun: true`, then without. Save `mcp-dry-run.png`. Pass when the dry run creates nothing and the real call returns the expanded body.
- [ ] Lane 10. Two users create pages from the same template at once. Save `concurrent-create.png`. Pass when both pages exist and each shows its own `{{me}}`.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. `search_documents` latency at 5,000 documents, which now filters templates. The diff-added work is also measured as instantiate latency for a template with a 3-level subtree of 20 pages.
- [ ] Probe. A script under `/tmp/perf-p2/` that seeds 5,000 documents and 50 templates into PGlite, then times 100 searches at trunk and head, interleaved in 7 runs, and 20 instantiations at head.
- [ ] Baseline. Record the trunk search median first.
- [ ] Rule. Fail when the head search median exceeds trunk by more than 10%, or when the median instantiation exceeds 500 ms.

**Review gate.** None. The new-page menu is a new entry point that P6 puts under review together with typed templates.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends P2 to the stack. David lands it bottom-up.

## Store types, fields, and properties (P3)

**Depends on.** P1 and P2. Start only after David writes down the 3 questions that search and filters cannot answer.

**Files.**

- [ ] Edit `packages/db/src/schema.ts`. Add `document_types`, `type_fields` (id, key, label, kind, options jsonb with option ids, retired), and field key aliases. Add `documents.type_id` and `documents.properties` jsonb. Add properties text to the `search_vector` expression near line 200.
- [ ] Create one migration under `packages/db/drizzle/` with `pnpm db:generate`.
- [ ] Create `packages/editor/src/properties.ts` for the `Y.Map("properties")` read, the patch apply, and the JSON projection. Export it from `packages/editor/src/index.ts`.
- [ ] Create `packages/core/src/services/types.ts` for types, fields, aliases, validation, and normalization at the projection step.
- [ ] Edit `apps/server/src/collab-writer.ts`. Add `setProperties(docId, patch)` under a fresh attributed client id.
- [ ] Edit the six body-only paths.
  - [ ] The restore no-op check in `apps/server/src/collab-writer.ts` near line 72.
  - [ ] `read_version` in `apps/server/src/mcp/tools/versions.ts` and `stateToJSON` in `packages/editor/src`.
  - [ ] `get_authors` in `apps/server/src/mcp/tools/versions.ts`.
  - [ ] `duplicate` in `packages/core/src/services/documents.ts` line 214.
  - [ ] The editor undo scope in `apps/web/src/components/editor/extensions.ts`, so undo in the body never reverts a property.
  - [ ] `applyEditToState` in `packages/editor/src`, so a body edit keeps the properties map.
- [ ] Edit `apps/server/src/mcp/tools/read.ts` (`get_document` returns `properties` beside `markdown`), `apps/server/src/mcp/tools/write.ts` (`create_document` with `type` and `properties`), and create `apps/server/src/mcp/tools/properties.ts` with `set_properties`, `list_types`, and `list_fields`.
- [ ] Edit `apps/server/src/trpc.ts` for type and field routes.
- [ ] Create `packages/editor/src/properties.test.ts`. Edit `packages/core/src/core.test.ts`, `apps/server/src/mcp-collab.test.ts`, `apps/server/src/collab.test.ts`, and `apps/server/src/snapshots.test.ts`.

**Build.**

- [ ] Store each property as one entry in `Y.Map("properties")` keyed by field id. List kinds use `Y.Array`.
- [ ] Apply a patch of `set`, `unset`, `add`, and `remove` ops with one Yjs op per field. Never rewrite the map.
- [ ] Validate and normalize at the projection step into `documents.properties`. Keep a renamed field's old key as an alias.
- [ ] Let only the owner or an admin define fields. An agent that sends an unknown field gets an error that lists the existing fields. Proposals are a later program.
- [ ] Make `get_document` return `properties` beside `markdown`, never inside it.

**You see.**

- [ ] MCP `set_properties` with `{"op":"set","field":"status","value":"done"}` returns the committed properties, and `get_document` shows `properties.status` equal to `done` with an unchanged `markdown`.
- [ ] A search for `done` finds the page.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `properties.test.ts` replays the yaml-merge scenarios S1 to S9 through the real patch apply and asserts 0 wrong and 0 invalid outcomes against literal expected maps. Port the scenario definitions from `/tmp/graph-tests/yaml-merge/` into the test file first, because `/tmp` does not survive a reboot. Run `pnpm --filter @tandem/editor test`.
- [ ] `core.test.ts` gains validation cases per kind, alias resolution, and the projection to jsonb. Run `pnpm --filter @tandem/core test`.
- [ ] `mcp-collab.test.ts` and `snapshots.test.ts` gain one case for each of the six body-only paths, asserting properties survive or are reported. Run `pnpm --filter @tandem/server test`.
- [ ] Run `pnpm test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run MCP `get_document` and `update_document` on the same seeded page at trunk and head. Trunk has no properties, so record that. Gate that head returns the same `markdown` as trunk plus a `properties` object, and that a body edit leaves properties unchanged. Save `regression-get-document.png`. Pass when `markdown` matches trunk byte for byte.
- [ ] Lane 2. Set a field through MCP while a browser has the page open. Save `live-set.png`. Pass when `page.evaluate` reads the new value from the ydoc without reload.
- [ ] Lane 3. Two MCP clients append to the same list field at once. Save `concurrent-append.png`. Pass when both values are present.
- [ ] Lane 4. Restore a version from before a property change. Save `restore-props.png`. Pass when the restore is not reported as a no-op and the old value returns.
- [ ] Lane 5. Call `read_version` on a version with properties. Save `read-version.png`. Pass when the response shows those properties.
- [ ] Lane 6. Duplicate a typed page. Save `duplicate.png`. Pass when the copy has the same type and values.
- [ ] Lane 7. Press undo in the editor after an agent set a property. Save `undo-scope.png`. Pass when the property keeps its value.
- [ ] Lane 8. An agent sends `set_properties` with an unknown field. Save `agent-unknown-field.png`. Pass when the call returns a proposal error and no field is created.
- [ ] Lane 9. Rename a field, then set it by its old key. Save `alias.png`. Pass when the value lands on the renamed field.
- [ ] Lane 10. Call `create_document` with `type` and `properties`. Save `create-typed.png`. Pass when `list_fields` and `get_document` agree on every value.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Save-path latency for a body edit through `CollabWriter`, and `get_document` response size for a page with 12 fields. The diff-added work is also measured as `set_properties` latency and filtered query latency over `documents.properties` at 5,000 documents.
- [ ] Probe. A script under `/tmp/perf-p3/` that seeds 5,000 documents, runs 200 body edits and 200 `get_document` calls at trunk and head in 7 interleaved runs, and runs 200 `set_properties` calls and 100 filtered queries at head.
- [ ] Baseline. Record the trunk save-path p50 and p95 and the trunk `get_document` byte size first.
- [ ] Rule. Fail when the head save-path p95 exceeds trunk by more than 10%, when `get_document` grows by more than the serialized properties plus 200 bytes, when `set_properties` p95 exceeds 50 ms, or when the filtered query p95 exceeds 30 ms.

**Review gate.** None. P3 has no editor UI. P4 carries the review.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends P3 to the stack. David lands it bottom-up.

## Show the properties panel and attach a type (P4)

**Depends on.** P3.

**Files.**

- [ ] Create `apps/web/src/components/PropertiesPanel.tsx` with one widget per kind.
- [ ] Edit `apps/web/src/components/DocumentPage.tsx` to render the panel under the title.
- [ ] Edit `apps/web/src/components/editor/useCollabDoc.ts` to expose the `Y.Map("properties")`.
- [ ] Edit `apps/web/src/components/editor/useBlame.ts` and `apps/web/src/components/blame.ts` to mark AI-authored values.
- [ ] Edit `apps/web/src/components/CollectionPage.tsx` for property columns in the Contents table.
- [ ] Edit `apps/web/src/styles.css`.
- [ ] Create `apps/web/e2e/properties.mjs`.
- [ ] Create `apps/web/src/components/properties.test.ts`.

**Build.**

- [ ] Render widgets for text, number, checkbox, date, select, multi_select, url, doc ref, and doc list. Each widget writes one field with one patch op.
- [ ] Add **Attach type** and **Detach type**. Detach clears the type and keeps the values.
- [ ] Mark values whose last writer is an AI author with the agent name from P1.

**You see.**

- [ ] Under the title, a Meeting page shows its fields. Changing `status` in one browser updates the other browser within one second, and the AI-set `date` shows "David's AI (Claude)" on hover.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `apps/web/src/components/properties.test.ts` asserts the patch each widget emits for a literal input. Run `pnpm --filter @tandem/web test`.
- [ ] `apps/web/e2e/properties.mjs` covers attach, edit, and detach. Run `bash apps/web/e2e/run-all.sh` and `pnpm --filter @tandem/web build && pnpm e2e`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Open a page, type in the body, and check the title at trunk and head. Trunk has no panel, so record that. Gate that head typing and title behave as on trunk, and that attaching a type shows the panel with fields. Save `regression-page.png`. Pass when body typing matches trunk and the panel renders.
- [ ] Lane 2. Edit every widget kind once. Save `all-kinds.png`. Pass when the ydoc holds the typed value for each.
- [ ] Lane 3. Two browsers edit different fields at once. Save `two-fields.png`. Pass when both edits survive.
- [ ] Lane 4. Two browsers append to the same multi_select at once. Save `multi-append.png`. Pass when both options are present.
- [ ] Lane 5. An agent sets a field while the panel is open. Save `ai-marker.png`. Pass when the value shows the AI marker with the agent name.
- [ ] Lane 6. Detach the type. Save `detach.png`. Pass when the panel hides typed fields and the values remain after reattach.
- [ ] Lane 7. Pick a doc ref value from the page picker. Save `doc-ref.png`. Pass when the value links to the chosen page.
- [ ] Lane 8. Show property columns in the Contents table. Save `contents-columns.png`. Pass when the columns match the panel values.
- [ ] Lane 9. Edit a field offline, then reconnect. Save `offline-edit.png`. Pass when the value syncs to the other browser.
- [ ] Lane 10. Navigate the panel with the keyboard only. Save `keyboard.png`. Pass when every widget is reachable and editable without a mouse.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from navigation to an editable body on a page, and keystroke latency in the body. The diff-added work is also measured as time from a widget change to the value in the other browser.
- [ ] Probe. A Playwright script under `/tmp/perf-p4/` that loads a 12-field page 20 times and types 200 characters at trunk and head, interleaved, and times 50 widget changes at head.
- [ ] Baseline. Record the trunk median load and keystroke times first.
- [ ] Rule. Fail when head load median exceeds trunk by more than 100 ms, keystroke p95 exceeds trunk by more than 5 ms, or widget-to-peer p95 exceeds 1 second.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 2, 5, and 6 screenshots into `/tmp/tandem-review/P4/P4-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change on a lane browser with Playwright `recordVideo`. Save it as `/tmp/tandem-review/P4/P4-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends P4 to the stack after the operator's review. David lands it bottom-up.

## Import and export properties as YAML (P5)

**Depends on.** P3 and P0. It stacks above P4.

**Files.**

- [ ] Edit `apps/server/src/transfer/export.ts` and `apps/server/src/transfer/markdown-zip.ts` (`emitFrontMatter`, `composeExportDoc`).
- [ ] Edit `apps/server/src/transfer/import.ts` and `apps/server/src/transfer/markdown-zip.ts` (`parseFrontMatter`, `rewriteImportLinks`).
- [ ] Create `apps/server/src/transfer/properties-yaml.ts` for type inference, the `_tandem/fields.json` sidecar, and the diff into patches.
- [ ] Edit `apps/server/src/transfer/transfer.test.ts`, `apps/server/src/transfer/markdown-zip.test.ts`, and `apps/web/e2e/transfer.mjs`.

**Build.**

- [ ] Export frontmatter with keys in type field order and then alphabetical, select labels, doc refs as `"[[Title]]"`, and a flat `tandem-id`. Write `_tandem/fields.json`.
- [ ] Infer types vault-wide on import. Store unknown and nested values as the read-only `json` kind. Resolve `[[links]]`.
- [ ] On reimport, diff into per-field patches. Report comment and format loss per file.

**You see.**

- [ ] Export, edit one value in Obsidian, and reimport. Only that field changes, and the summary reports YAML comment loss for files that had comments.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `markdown-zip.test.ts` asserts the literal exported YAML for a Meeting page. `transfer.test.ts` asserts that a reimport with one changed value produces exactly one `set` patch. Run `pnpm --filter @tandem/server test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Export and reimport the same untyped workspace with tags at trunk and head. Gate that untyped pages export the same bytes as trunk, and that typed pages round-trip their values. Save `regression-export.png`. Pass when the untyped export diff is empty.
- [ ] Lane 2. Export a typed page. Save `export-yaml.png`. Pass when keys follow type field order.
- [ ] Lane 3. Reimport after one value change. Save `reimport-one.png`. Pass when blame shows one changed field.
- [ ] Lane 4. Import an Obsidian vault with mixed value types. Save `infer.png`. Pass when inferred kinds match the values.
- [ ] Lane 5. Import nested YAML. Save `json-kind.png`. Pass when the panel shows a read-only `json` field.
- [ ] Lane 6. Import `"[[Title]]"` links. Save `doc-ref-import.png`. Pass when the doc ref links to the matching page.
- [ ] Lane 7. Import a file with YAML comments. Save `comment-loss.png`. Pass when the summary reports the loss.
- [ ] Lane 8. Reimport while a browser edits a different field. Save `reimport-concurrent.png`. Pass when both values survive.
- [ ] Lane 9. Reimport with a renamed key that matches an alias. Save `alias-import.png`. Pass when the value lands on the field.
- [ ] Lane 10. Export, delete a key in the file, reimport. Save `unset-import.png`. Pass when the field is unset and no other field changes.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Import time and export time for 1,000 notes. The diff-added work is the reimport diff of 1,000 typed notes.
- [ ] Probe. A script under `/tmp/perf-p5/` that runs export and import at trunk and head, interleaved in 7 runs, and times the reimport at head.
- [ ] Baseline. Record the trunk import and export medians first.
- [ ] Rule. Fail when head import or export exceeds trunk by more than 25%, or when the 1,000-note reimport exceeds 30 seconds.

**Review gate.** None. P5 changes file output, not an interaction.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends P5 to the stack. David lands it bottom-up.

## Add typed templates and the meeting flow (P6)

**Depends on.** P2, P3, and P4. It stacks above P5.

**Files.**

- [ ] Edit `packages/db/src/schema.ts` and add one migration for template default values and `origin {template_id, version}` on documents.
- [ ] Edit `packages/core/src/services/templates.ts` for typed instantiation and default expressions.
- [ ] Create `packages/core/src/services/seed-types.ts` for Meeting, Project, and Person.
- [ ] Edit `apps/server/src/mcp/tools/templates.ts` to add `instantiate_template`.
- [ ] Edit `apps/web/src/components/sidebar/useSidebarActions.tsx`, `apps/web/src/components/useCreateDocument.ts`, and `apps/web/src/components/PropertiesPanel.tsx`.
- [ ] Create `apps/web/e2e/meeting.mjs`.

**Build.**

- [ ] Let a template declare a type and default values, including the expressions `date=today` and `attendees=from previous sibling`.
- [ ] Make instantiation set the type, `origin`, and the values in one patch.
- [ ] Seed Meeting, Project, and Person types and templates.
- [ ] Use the per-folder default template under a series parent.
- [ ] Make `instantiate_template` return the committed values.

**You see.**

- [ ] **+ New page** under a "Weekly sync" parent creates a Meeting page with today's date and the previous meeting's attendees.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `core.test.ts` asserts the literal values for `date=today` with a fixed clock and for `attendees` from the previous sibling. Run `pnpm --filter @tandem/core test`.
- [ ] `mcp.test.ts` asserts `instantiate_template` returns committed values. Run `pnpm --filter @tandem/server test`.
- [ ] `apps/web/e2e/meeting.mjs` covers the series flow. Run `bash apps/web/e2e/run-all.sh`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Create a page from an untyped template at trunk and head. Trunk has no typed templates, so record that. Gate that the untyped flow matches trunk, and that a Meeting template creates a typed page with values. Save `regression-template.png`. Pass when both hold.
- [ ] Lane 2. Create the second meeting in a series. Save `prev-attendees.png`. Pass when attendees match the first meeting.
- [ ] Lane 3. Create the first meeting in a series. Save `first-meeting.png`. Pass when attendees are empty and no error shows.
- [ ] Lane 4. Change the Meeting template after use. Save `template-change.png`. Pass when older pages keep their values.
- [ ] Lane 5. Detach the type on a meeting. Save `detach-meeting.png`. Pass when values stay and `origin` is unchanged.
- [ ] Lane 6. Call MCP `instantiate_template`. Save `mcp-instantiate.png`. Pass when the response values equal the panel values.
- [ ] Lane 7. Create a Project page from its template. Save `project.png`. Pass when the Project fields show.
- [ ] Lane 8. Create a Person page from its template. Save `person.png`. Pass when the Person fields show.
- [ ] Lane 9. Pick **Blank** under the series parent. Save `series-blank.png`. Pass when the page has no type.
- [ ] Lane 10. Two users create meetings in the same series at once. Save `concurrent-series.png`. Pass when both pages exist with valid values.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from **+ New page** to an editable page. The diff-added work is typed instantiation with the previous-sibling lookup in a series of 500 meetings.
- [ ] Probe. A Playwright script under `/tmp/perf-p6/` that creates 20 pages at trunk and head, interleaved, and 20 meetings in the 500-page series at head.
- [ ] Baseline. Record the trunk median first.
- [ ] Rule. Fail when head exceeds trunk by more than 150 ms, or when the series instantiation median exceeds 400 ms.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 2, 4, and 6 screenshots into `/tmp/tandem-review/P6/P6-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change on a lane browser with Playwright `recordVideo`. Save it as `/tmp/tandem-review/P6/P6-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends P6 to the stack after the operator's review. David lands it bottom-up.

## Project tasks and add live sections (P7)

**Depends on.** P6.

**Files.**

- [ ] Edit `packages/db/src/schema.ts` and add one migration for `tasks(document_id, block_id, text, done, handles, due)`.
- [ ] Edit `packages/editor/src/schema.ts` to give task items stable block ids and to add the live section node.
- [ ] Edit `packages/core/src/services/document-queries.ts`. Move `my_tasks` from `scanTaskItems` over `contentMd` to the `tasks` table. Add queries by document, subtree, type, and previous sibling.
- [ ] Edit `packages/core/src/services/documents.ts` to write the projection on save.
- [ ] Create `apps/web/src/components/live-section-node.tsx` and edit `apps/web/src/components/slash-command.tsx` and `apps/web/src/components/Home.tsx`.
- [ ] Edit `apps/server/src/trpc.ts` and `apps/server/src/mcp/tools/read.ts`.
- [ ] Create `apps/web/e2e/live-sections.mjs`.

**Build.**

- [ ] Project tasks into the `tasks` table on save, keyed by stable block ids.
- [ ] Add a live section node with a fixed menu ("Open from last time", "Since last meeting", "Open tasks under this page") that resolves at render.
- [ ] Show date fields with due or review semantics on Home as overdue and next 30 days.

**You see.**

- [ ] A new meeting page with "Open from last time" lists the open tasks from the previous meeting, and checking one there checks it in the source page.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `core.test.ts` asserts literal task rows after save, after a move, and after deletion, and the result of each live query. Run `pnpm --filter @tandem/core test`.
- [ ] `packages/editor/src/markdown.test.ts` asserts block ids survive a markdown round trip. Run `pnpm --filter @tandem/editor test`.
- [ ] `apps/web/e2e/live-sections.mjs` and `apps/web/e2e/tasks.mjs` pass. Run `bash apps/web/e2e/run-all.sh`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Open Home and `my_tasks` on the same seeded workspace at trunk and head. Gate that head lists the same tasks as trunk, and that a meeting's "Open from last time" section lists the previous meeting's open tasks. Save `regression-tasks.png`. Pass when the task lists match and the section renders.
- [ ] Lane 2. Check a task inside a live section. Save `check-through.png`. Pass when the source page shows it done.
- [ ] Lane 3. Insert "Since last meeting". Save `since-last.png`. Pass when it lists pages changed since the previous meeting date.
- [ ] Lane 4. Insert "Open tasks under this page" on a parent. Save `subtree-tasks.png`. Pass when it lists open tasks from the subtree only.
- [ ] Lane 5. Edit a task's text in the source page. Save `task-edit.png`. Pass when the live section shows the new text after re-render.
- [ ] Lane 6. Move a task between pages. Save `task-move.png`. Pass when the block id is kept and the projection follows.
- [ ] Lane 7. Set a due field to yesterday. Save `home-overdue.png`. Pass when Home lists the page as overdue.
- [ ] Lane 8. Set a review field to 20 days out. Save `home-next30.png`. Pass when Home lists it under next 30 days.
- [ ] Lane 9. Put a task in a template body. Save `template-task-excluded.png`. Pass when no live section or Home lists it.
- [ ] Lane 10. Export a page with a live section. Save `export-live.png`. Pass when the export contains readable text and no broken node.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. `my_tasks` and Home query latency at 5,000 documents, and save-path latency. The diff-added work is live section resolve time.
- [ ] Probe. A script under `/tmp/perf-p7/` that seeds 5,000 documents with 20,000 tasks, then runs 100 `my_tasks` calls and 200 saves at trunk and head, interleaved in 7 runs, and 100 live section resolves at head.
- [ ] Baseline. Record the trunk `my_tasks` median and save p95 first.
- [ ] Rule. Fail when head `my_tasks` median is not at least 2x faster than trunk, when save p95 exceeds trunk by more than 10%, or when live section resolve p95 exceeds 50 ms.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1, 2, and 7 screenshots into `/tmp/tandem-review/P7/P7-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change on a lane browser with Playwright `recordVideo`. Save it as `/tmp/tandem-review/P7/P7-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends P7 to the stack after the operator's review. David lands the stack bottom-up.

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] Reply to the operator with the report the execution playbook names. Link the stack root and tip, give a one-line verdict per PR, and list anything parked or excluded with the reason.

## Appendix A. Prototype evidence

The prototypes ran outside the repo, so they have no branch or SHA. Their artifacts are on disk.

The YAML merge test in `/tmp/graph-tests/yaml-merge/README.md` settled the storage question. Raw YAML in a `Y.Text` produced bad merges in 33.5% to 58.4% of 2,250 trials per editor method. A panel that rewrote the frontmatter block produced duplicate keys in 100% of trials. A `Y.Map` with whole-object writes lost edits in 51.1%. A `Y.Map` with per-field writes and `Y.Array` lists had 0 wrong and 0 invalid outcomes in 2,250 trials, with losses only from inherent last-writer-wins. `Y.Map` key order differed between replicas in 200 of 200 trials, so export order must come from the type.

The links benchmark in `/tmp/graph-tests/links/README.md` measured a `links(src,dst)` projection in PGlite. Re-deriving links on save cost 1.8 ms at 5,000 documents and 1.3 ms at 50,000. Median backlinks took about 1 ms at both sizes, against 17 ms and 126 ms for the shipped `LIKE` scan. The same projection pattern backs the P7 `tasks` table, and the links table itself is a follow-on program.

The extraction test in `/tmp/graph-tests/extract/README.md` ran 48 model calls over 6 meeting notes. Explicit task recall was 84 of 84 and implicit recall 17 of 21. Without a registry, 22 entities got 42 distinct names. With a registry, they got 23. Due dates without a year failed in 9 of 12 errors. That result supports default 3, where agents propose fields and do not mint them.

These stay unproven.

- How the properties panel feels in daily use. P4's review gate is the first check.
- How live sections work for a real meeting series. P7's review gate is the first check.
- Field fill rate. Kill criterion 6 measures it after 4 weeks.

## Appendix B. Alternatives rejected

- Raw YAML text in the document body lost because concurrent edits corrupted it in 33.5% to 58.4% of trials, and many failures parse as valid but wrong values.
- A jsonb column as the source of truth lost because it bypasses the ydoc. Offline edits, blame, and versions would need a second sync path. P3 keeps jsonb only as a projection for search and queries.
- A frontmatter node inside the ProseMirror document lost because body tools and body undo would treat properties as text, and the panel would rewrite the node as a whole.
- Using a template link as the page's kind lost because a template describes how a page starts. A type describes what the page is, and a type has many templates.
- Workspace-wide field types keyed by name lost because the same name means different things in different types. Fields belong to a type and have stable ids, so renames keep aliases.

The follow-on programs are out of scope. They are the links table with Person open commitments, an identity resolver with aliases and identifiers, proposals with auto, propose, and human tiers and a review bar, and transcripts.

## Appendix C. Risks

- Six body-only paths drop properties (P3). The restore no-op check, `read_version` and `stateToJSON`, `get_authors`, `duplicate`, the editor undo scope, and `applyEditToState` read only the body today. The owner adds one test per path.
- `CollabWriter` split-brain (P3). A property write and a body write from different client ids can race on the same ydoc. The owner watches that `setProperties` uses a fresh attributed client id and that both writes converge in `collab.test.ts`.
- `Y.Map` key order on export (P5). Replicas iterate keys in different orders. The owner sorts by type field order, then alphabetically, and never by map order.
- Last-writer-wins on the same field (P3 and P4). Two users who set the same scalar lose one value. The owner watches that blame shows who won and documents the behavior.
- Schema creep (P3 and P6). Types and fields can grow without bound. The owner keeps field definition with owners and admins per default 3.
- Empty fields (P4 and P6). Typed pages may stay unfilled. Kill criterion 6 measures fill rate after 4 weeks.
- No cloud VMs and no `control-ui` in this harness (all PRs). Live lanes run locally on Playwright and CDP. Port collisions between lanes are the main risk, so each lane uses its own port pair and PGlite directory.
- Follow-on programs are not covered (P7 boundary). Links, identity resolution, proposals, and transcripts stay out of this program, and P7 must not add their tables.

## Appendix D. Links and reading list

Read these before editing.

- `docs/typed-properties-design.md` for the data model, validation, MCP surface, and views.
- `/tmp/graph-tests/yaml-merge/README.md`, `/tmp/graph-tests/links/README.md`, and `/tmp/graph-tests/extract/README.md` for the prototype evidence.
- `apps/web/e2e/run-all.sh` and `playwright.config.ts` for how e2e boots.
- `apps/server/src/collab-writer.ts` and `packages/editor/src/authors.ts` for the write and blame paths.

P3 and P5 run `/home/david/.agents/skills/how/SKILL.md` before code. P3, P4, P6, and P7 run `/home/david/.agents/skills/interrogate/SKILL.md` on the design before the first push. Keep the decision trail per `/home/david/.agents/skills/show-me-your-work/SKILL.md` in a local file next to the plan, uncommitted unless the operator asks.
