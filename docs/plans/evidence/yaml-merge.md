# YAML-in-Y.Text vs Y.Map properties under concurrent offline edits

Files: `sim.mjs` (simulation), `check.mjs` (Y.Map side checks), `run-output.txt` (raw output),
`results.json` (all counts), `examples.txt` (first merged text for each failure class).
Reproduce: `npm i && node sim.mjs && node check.mjs` (yjs 13.x, yaml 2.x, Node 24; seed 20261022, `TRIALS` env, default 250).

## Method
Base note: `---` fence + frontmatter (`date`, `status`, `project: "[[Apollo]]"`, `attendees` block list,
`tags` block list, nested `review: {owner, due}`) + markdown body, all in one `Y.Text`.
Per trial: a base Y.Doc is cloned into 2–3 clients with random clientIDs (randomizes Yjs tie-breaks);
each client edits offline; all updates are exchanged; convergence is asserted; the merged
frontmatter is parsed with `yaml` (`uniqueKeys: true`) and checked against a per-scenario intended outcome.

Text-edit methods (how an editor turns an intent into Y.Text ops):
- `targeted`: cursor-level edit — select the value and type over it; list append as Enter+type at end of
  last item (`eol`) or type+Enter at start of next line (`bol`), chosen randomly; new key inserted at a random
  top-level boundary or at the end. Reformat ops have no cursor form and use `lineDiff`.
- `charDiff`: single prefix/suffix minimal diff of old→new text (what a CodeMirror/ProseMirror "set value" diff does).
- `lineDiff`: LCS line diff applied as line-replacement hunks (LSP-formatter style).
- `block`: a properties panel serializes the object and replaces the whole frontmatter region.
- `mixed`: each edit picks one of the four at random.

Y.Map side: one Y.Map per note, scalars as values, lists as `Y.Array`, `review` as nested `Y.Map`.
- `granular`: `set` per field, `push` for list appends, `delete` for removal; reformat = no-op (serializer concern).
- `naive-rewrite`: panel writes *every* field back (fresh Y.Array/Y.Map per list/object) on each change.

Outcome classes: `intended` (every concurrent intent preserved, nothing else changed); `lww` (valid, one intent
cleanly dropped where the conflict is inherent — same scalar, delete vs edit); `wrong` (parses, but values are
corrupted/lost: concatenations like `2026-11-072026-11-11`, glued keys like `Hermesattendees`, lost list items or
fields); `dupkey` (only error is a duplicate key — strict parsers reject, lenient ones silently keep one);
`invalid` (any other parse error or broken `---` fence).

Scenarios (250 trials × 7 variants each = 1,750 trials/scenario, 15,750 total):
S1 both set `date`; S2 edit `status` vs add `location`; S3 both append to `attendees`; S4 reformat
(sortKeys / flowLists / indent4 / quoteAll, random) vs edit `status`; S5 delete `project` vs edit `project`;
S6 nested: edit `review.due` vs add `review.notes`; S7 reformat (indent4/flowLists/sortKeys) vs add
`review.approved` + append attendee; S8 three clients: date / append attendee / append tag + edit status;
S9 both add different new keys.

## Raw numbers (% of 250 per cell; ok = intended + lww)

| Scenario | targeted | charDiff | lineDiff | block | mixed | Y.Map granular | Y.Map naive |
|---|---|---|---|---|---|---|---|
| S1 same scalar | 0 ok, 100 wrong (concat) | 1.2 ok, 98.8 wrong | 1.6 ok, 98.4 dup | 100 dup | 0 ok | 100 lww | 100 lww |
| S2 edit vs add key | 100 | 100 | 100 | 100 dup | 77.2 ok | 100 | 45.2 ok, 54.8 wrong (status clobbered) |
| S3 both append list | 100 | 100 | 100 | 100 dup | 53.6 ok, 41.6 invalid | 100 | 0 ok (one append lost) |
| S4 reformat vs edit | 55.2 ok, 44.8 wrong | 50 ok, 50 wrong | 50 ok, 50 dup | 100 dup | 24.4 ok | 100 | 47.2 ok |
| S5 delete vs edit | 100 invalid | 100 wrong (`Hermesattendees`) | 100 lww | 100 dup | 45.6 ok | 100 lww (set wins 200/200) | 100 lww |
| S6 nested both edit | 50.8 ok, 49.2 wrong (`notes: ok2026-11-23`) | 100 | 46.8 ok, 53.2 wrong | 100 dup | 46.8 ok | 100 | 0 ok |
| S7 reindent vs nested add | 100 invalid | 100 invalid | 100 invalid | 100 dup | 0 ok | 100 | 47.6 ok |
| S8 three-way | 100 | 100 | 100 | 100 dup | 35.2 ok | 100 | 0 ok |
| S9 both add keys | 100 | 100 | 100 | 100 dup | 91.6 ok | 100 | 100 |

Aggregate over all 9 scenarios (n = 2,250 each):

| Variant | ok | wrong | dupkey | invalid | bad total |
|---|---|---|---|---|---|
| text targeted | 56.2 | 21.6 | 0.0 | 22.2 | **43.8** |
| text charDiff | 61.2 | 27.6 | 0.0 | 11.1 | **38.8** |
| text lineDiff | 66.5 | 5.9 | 16.5 | 11.1 | **33.5** |
| text block-replace | 0.0 | 0.0 | 100.0 | 0.0 | **100.0** |
| text mixed | 41.6 | 17.4 | 17.1 | 23.9 | **58.4** |
| Y.Map granular | 100.0 | 0.0 | 0.0 | 0.0 | **0.0** |
| Y.Map naive rewrite | 48.9 | 51.1 | 0.0 | 0.0 | **51.1** |

Y.Map checks (`check.mjs`): concurrent `delete` vs `set` → set survives 200/200. Key iteration order after
concurrent key adds differed between replicas in 200/200 trials (converged content, different `keys()` order).

## Verdict
- Raw YAML in Y.Text is safe only for *disjoint-line* edits (S2, S3, S8, S9: 100% with editor-style ops).
  Any same-line, same-key, delete/edit, or formatting collision corrupts it: 33.5–43.8% of all trials across
  editor-style methods, and 100% for S1 (same scalar → `2026-11-072026-11-11` or duplicate `date:`),
  S5 (`"[[Orion]]"attendees:` invalid, or `Hermesattendees:` silently swallowing `attendees`),
  S7 (reindent vs nested add → invalid, incl. text glued onto the closing `---`).
  The worst failures are *valid-but-wrong* (21.6% for targeted, 27.6% for charDiff): no parser error to catch.
- A properties panel that rewrites the frontmatter block in a shared Y.Text duplicates the block on every
  concurrent edit (100% dupkey). Mixing panel and text editing: 58.4% bad.
- Y.Map with per-field ops + Y.Array lists: 0 invalid, 0 wrong in 2,250 trials; the only losses are inherent
  LWW (S1: one date wins; S5: set beats delete). But it only stays safe if writes are granular — a panel that
  writes back all fields loses concurrent edits 51.1% of the time (never invalid, but silently wrong).
- Implications: properties belong in a Y.Map (Y.Array for lists, granular ops); YAML is a serialization at
  the file boundary, written with a deterministic key order (Y.Map key order diverges across replicas, so
  order must come from the template/schema or an explicit order array). Inbound file edits must be diffed
  into per-field Y.Map ops, not written back wholesale.

Limitations: one base document; values are short; Yjs tie-break is driven by random clientIDs only; char-by-char
typing modeled as one insert (Yjs keeps a client's typed run contiguous, so the merge result is the same);
the `yaml` lib's YAML 1.2 core schema reads dates as strings (doesn't change classification).
