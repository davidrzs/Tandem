# Running pages plan

Recurring meetings (project syncs, 1:1s) move from one page per meeting to one running page per series. The code learns four generic building blocks and nothing about meetings; "Meeting series" and "Research log" become starter-kit content built from them.

## Model

- An **entry** is a level-2 heading whose text starts with a date: `## 2026-11-24 Advisor`. The heading and everything up to the next level-1 or level-2 heading belong to it. Entries are visible in markdown, so export, import, MCP and agents keep them with no hidden state. Editing the date edits the entry's date.
- A page's **pinned top** is everything before its first entry. New entries go directly below it, so entries read newest first.
- A page's **entry template** is any template. "New entry" fills it in (`{{date}}`, `{{me}}`, prompts) and inserts it below the pinned top. When the filled-in body does not start with a dated level-2 heading, `## {{date}}` is put in front of it.
- Live sections and backlinks report by entry where a page has entries, and by page where it has none.

Out of scope: first-class decisions, agent distillation of transcripts, any per-entry properties.

## PRs

### R1 Entries in the editor package

- [x] `packages/editor/src/entries.ts`: `entriesOf(doc)` (document positions) and `entriesOfMarkdown(md)` (character offsets) return `{ date, heading, from, to }` per entry; `entryDate(text)` checks the date. Only top-level headings count, so a dated heading in a quote, list or code fence is not an entry. Evidence: `entries.test.ts` (undated, level-3 and impossible-date headings, level-1 headings ending an entry, both readings agreeing on the same page).

### R2 Entry templates and New entry

- [ ] `documents.entry_template_id` (FK to templates, `ON DELETE SET NULL`), with the same RLS shape as `default_template_id`.
- [ ] `TemplateService.insertEntry(documentId, templateId?)` inserts through the collab writer so open editors see the new entry live. It uses the page's entry template when none is given. Evidence: core test with an open collab session.
- [ ] tRPC `documents.setEntryTemplate` and `templates.insertEntry`. MCP tool `new_entry` and `entry_template` in `get_document`. Evidence: mcp.test.ts.
- [ ] Web: a **New entry** button in the page header when the page has an entry template, and **Entry template…** in the page row menu. Evidence: e2e `entries.mjs`, screenshot.

### R3 Generic live sections

- [ ] `open_tasks_on_page`: open tasks of this page, grouped by entry heading, newest entry first. Needs each task's entry: either `entry_date` and `entry_heading` columns on `tasks` filled by the projection, or computed at query time from the page body. Decide here; tasks are on hold.
- [ ] `changes_since_last_entry`: cutoff is the newest entry dated before today, so it still works while today's entry is being written. Scope is the subtrees of the pages this page references through page-reference properties, and the page's parent subtree when it has none. Evidence: core tests for both scopes and for "no earlier entry".
- [ ] The slash menu offers the new two plus `open_tasks_here`. `open_from_last_time`, `since_last_meeting` and `meeting_series` keep rendering on existing pages but leave the menu.

### R4 Backlinks by entry

- [ ] `listBacklinks` locates each link in the linking page's markdown and reports the entry it sits in. Computed on the at most 50 result rows; `link_targets` is unchanged. Evidence: core test, MCP `list_backlinks` returns `entry`.
- [ ] Web "Linked from" shows `Advisor 1:1 · 2026-11-24`. Evidence: e2e, screenshot.

### R5 Starter kit as content

- [ ] Replace the Meeting template and Project's Meetings child with a **Meeting series** template: Attendees and Projects page-list fields on a `Series` type, a pinned top with `open_tasks_on_page`, `changes_since_last_entry` and a `## Next` heading, and an entry template `## {{date}}` with Notes, Decisions and Actions.
- [ ] Add a **Research log** template with the same building blocks.
- [ ] Drop the `'meeting'` name check in `meetingSeries`. Workspaces seeded earlier keep their types and templates.

### R6 Retire the per-meeting machinery (decision pending)

- [ ] Only once existing per-meeting pages are dealt with: a **Combine into running page** action on a page whose children share a type turns each child into an entry (title and date from the child, body under it, tasks keep their block ids) and archives the children.
- [ ] Then remove `meeting_series`, `open_from_last_time`, `since_last_meeting`, `previousSibling`, and the `from_previous_sibling` default, with a migration that rewrites the three live-section comments still stored in pages.

## Order

R1, then R2 and R3 in either order, then R4 and R5. R6 waits for the decision on existing data.
