# Can agent-proposed graph structure from meeting notes be trusted?

## Method
- `notes/n1..n6.md`: 6 synthetic notes, 284–341 words each, from the point of view of David (ETH): two Lexchat PI meetings (n1, n5), two MSc supervisions with Lukas (n2, n6), a call with the Fribourg and Lausanne pilot courts (n3), and a CSCS allocation call (n4). Naming is inconsistent on purpose: Sabine Krüger / Sabine / Prof. Krüger / SK / sabine.krueger@ethz.ch; Lukas / Lukas Vogel / LV / lvogel@student.ethz.ch; Amélie / Amelie Rochat; Lexchat / LexChat project / lp42 vs a separate "LexChat 2"; Tribunal cantonal FR / Kantonsgericht Freiburg / Fribourg pilot; Tribunal fédéral / Bundesgericht; "Lausanne" as the cantonal court (n1, n5) and as a city (n6). Some tasks are only stated in prose, and some prose items are already done (decoys).
- `gold.json`: written **before** any extraction. 32 explicit tasks (checkbox `@x` or `Name: action` lines) + 7 implicit (prose-only) + 6 optional (not scored either way), and canonical-entity regexes.
- Extractor: `completion()` with the default model, temperature default, JSON schema (entities/relations/tasks). Same system prompt for every run (`extract_and_score.py`).
- Conditions (48 model calls in total):
  - **base**: 6 notes × 3 runs
  - **registry**: 6 × 3, with a list of 18 canonical entity names in the prompt ("use EXACTLY this name if the mention refers to it"). Patrick Rey, LexChat 2, Tribunale d'appello and entscheidsuche were left out on purpose, to see how new entities are handled.
  - **noeth**: 6 × 1, with "at ETH Zurich" removed from the system prompt (to test where the leakage comes from)
  - **ambiguous**: n1, n2 and n6 × 2, with the registry plus the decoys "Marco Rossi" and "Lukas Meier"
- Scoring: `python3 extract_and_score.py > scores.json` (standalone, reads `runs/*.json`). Each surface name is mapped to a real-world entity with regexes; I checked every mapped name by eye. A quote counts as grounded if it is a substring of the note (after Unicode/quote/dash/whitespace normalization; exact-substring results were identical). An entity counts as "unsupported" if its real-world entity is not mentioned in that note (`MENTIONED`, hand-written).

## Raw numbers

| metric | base (18 runs) | registry (18 runs) |
|---|---|---|
| Distinct exact names for 22 non-meeting real entities | **42** | **23** |
| Real entities with >1 name (non-meeting) | 12/22 | 1/22 (LexChat 2 vs "CSCS production proposal 2027", not in registry) |
| Lower-cased + accent-folded keys, incl. 8 meetings | 50 for 30 | 33 for 30 |
| Naive matching false merges (same key, different entity) | 0 | 0 |
| Within-note: entity present in all 3 runs / same name in all 3 | 71/79, 68/79 | 71/78, 69/78 |
| Relations | 209 | 176 |
| evidence_quote verbatim in note | 207/209 (99.0%) | 176/176 |
| Distinct predicate strings | 49 | 29 |
| Mean Jaccard of (subj,pred,obj) triples between runs of a note | 0.51 | 0.73 |
| Explicit task recall | 84/84 | 84/84 |
| Implicit task recall | 17/21 (81%) | 17/21 |
| Owner correct on matched tasks | 101/101 | 101/101 |
| Due date exactly right | 33/45 | 34/45 |
| Entity mentions not supported by the note | 12/194 (ETH Zurich, 4 notes × 3 runs) | 2/199 (n4 "court pilots" → Fribourg/Lausanne pilot: defensible) |

Details:
- **Identity drift (base).** Sabine had 4 names: Sabine Krüger / Sabine / Prof. Krüger / Sabine Krueger. The last one was assembled from her email address, so even accent folding does not merge it with "Sabine Krüger". Amélie had 4 names (2 after folding), Lukas 2, Marco 2, Favre 2. Lukas's thesis had 7 names across notes, and 2–3 different names within a single note across runs. Tribunal fédéral and Bundesgericht stayed separate. The Lausanne court surfaced as "Lausanne legal service" in n1. Meetings referenced from another note also got different names: "CSCS call 2026-09-17" vs "CSCS call re. allocation 2026-09-17", "Lexchat PI meeting 2026-09-22" vs "LexChat PI sync 22/09". Naive name matching would create roughly 2× too many pages, and it never wrongly merged two different entities.
- **Grounding.** The only 2 ungrounded quotes were "David, a researcher at ETH Zurich", copied from the *system prompt*. Verbatim grounding does not mean the quote supports the relation. I hand-checked 30 random base relations: 24 supported, 3 weak (e.g. Amélie works_on Lexchat ← "Amélie's estimate: 18'000 node hours"), 3 unsupported (David works_at ETH Zurich with the quote "David"; 2× Nathalie Favre affiliated_with "Lausanne legal service"). So about 80% are clearly supported. "attended" makes up 54/209 relations.
- **Hallucination.** In base runs, "ETH Zurich" appeared in all 18 runs, including the 12 runs on notes that never mention ETH. With the ETH phrase removed from the system prompt (noeth), ETH appeared only in n2 and n5, which actually mention ETH (building, email). So the leak came from context the agent was given, not from the note. No invented people or projects appeared.
- **Tasks.** Explicit tasks were trivial (100%, including non-Tandem owners written as "Nathalie: …", "Thomas will send …"). Both misses were the same pair of implicit n5 tasks ("Amelie co-writes the technical part, Marco writes the paragraph"), missed in 2/3 runs in both conditions. Extra tasks: "Sabine edits the status" (n1, 3/3 runs). This is a legitimate task that my gold list missed. The extractor also added "submit LexChat 2 to CSCS by 3 Nov", which is defensible. Due-date errors: **9/12 come from one systematic error**. n5's header "22/09" has no year, and in all 3 runs (and all 3 registry runs) the model resolved it to **2025**. The other errors were 1 off-by-one (09-30 for "before 1 Oct") and 2 nulls for an agenda item. Three runs that agree can still be wrong together.
- **Registry.** It fixed name drift for every entity it listed, cut the number of predicate strings, and made runs more alike. It did not merge LexChat 2 into Lexchat, and it correctly linked bare "Lausanne" to Tribunal cantonal vaudois. It does nothing for entities that are not yet in it: the 2027 proposal got two names across n4 and n5, and meetings were still renamed. In the **ambiguous** test, a bare "Marco" in n1 and n6 (no surname in either note) was **silently** resolved to "Marco Bernasconi" in 4/4 runs even though "Marco Rossi" was also listed. The answer happened to be right, and there was no signal that it was a guess. [INFERENCE: list order or a weak Ticino cue may have decided it; not tested.]

## Verdict
- **Auto-accept:** checkbox `@owner` tasks (Tandem's parser already handles these without an LLM), and links from a note to people/projects that are **already in the registry** when the surface form matches a registered name or a known alias exactly.
- **Propose for human confirmation:**
  - any **new** entity, or any new alias attached to an existing one (including name-from-email such as "Sabine Krueger" and cross-language pairs such as Bundesgericht = Tribunal fédéral)
  - every typed relation: quotes are about 99% verbatim but only about 80% support the relation, and predicates drift (49 strings in 18 runs)
  - implicit (prose) tasks, which have about 80% recall
  - every resolved due date: relative dates and dates without a year fail systematically, so the note's own date should be passed to the extractor [INFERENCE: not tested]
  - every registry match where the registry lists more than one candidate for a short name
- **Never trust from the agent's context:** facts about the author or organisation in the agent's background prompt end up as entities and quotes. Grounding checks must run against the note text only, and they catch this.
- **Does a canonical registry fix identity drift?** Mostly, for entities it already knows: exact names per real entity fell from 42 → 23 for 22 entities, with zero false merges. It does not help with new entities or meeting references, and it turns ambiguity into silent, confident guesses. The workable design is registry + alias table + "new entity / ambiguous match → ask the human". Free-form auto-created entity pages would roughly double the page count.
