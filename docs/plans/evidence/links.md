# Links projection vs LIKE backlink scan (PGlite 0.2.17 / Postgres 16.4)

## Verdict
A `links(src,dst)` projection in plain Postgres is **cheap enough to rebuild on every save and fast enough for interactive graph queries at 5k docs, and still OK at 50k**. The LIKE scan that Tandem ships today grows linearly with corpus size: about 14–17 ms at 5k docs, about 126 ms at 50k, and the cost is the same for every doc. The links table answers a typical (median) doc's backlinks in about 1 ms at either size. The one real caveat is the 2-hop neighbourhood: hubs make it explode (at 50k, a hub's 2-hop covers 37% of the corpus), so a graph UI has to cap or skip hubs, whatever the SQL speed.

## Method
- `bench.ts` (Bun 1.4.3, `@electric-sql/pglite@0.2.17`, the version Tandem pins; pg_trgm loaded as in `packages/db/src/index.ts`).
- Synthetic corpus, seeded PRNG: N docs, about 1.63 KB markdown each (headings, sentences, task lines). Each doc links to 0–8 others (uniform count) as `[title](/d/<uuid>)`. Link targets follow a Zipf–Mandelbrot law, weight 1/(rank+10)^1.1, so a few hubs get most inbound links. A stress variant with q=0 (plain Zipf) is also included.
- One DB, three schemas:
  - **A**: `documents(id uuid pk, title, content_md, updated_at, deleted_at, archived_at)`. The query is exactly Tandem's: `content_md LIKE '%](/d/'||$id||')%'`, with deleted/archived filters, `id<>$id`, `ORDER BY updated_at DESC LIMIT 50` (`packages/core/src/services/document-queries.ts:290-305`). Tandem has no index on `content_md`, so this is a seq scan.
  - **A_trgm**: the same table copied into `documents_trgm`, plus `GIN (content_md gin_trgm_ops)`. This is the "tuned A" (checklist Q2): the cheapest fix that adds no table.
  - **B**: `links(src,dst, PK(src,dst))` plus an index on `dst`, filled by regex-parsing the markdown. The backlinks query joins `documents` with the same filters, order and limit.
- Measured: backlinks for the top hub and for a median doc (median inbound count over all docs = 1); a 2-hop undirected neighbourhood through a recursive CTE on B; and the save path:
  - `save_derive_links_B`: parse the body, then `DELETE FROM links WHERE src=$1` plus `INSERT … unnest($2)` in one transaction. The body alternates between the original and a variant with one link swapped, so rows really change each time.
  - `save_update_doc_row`: a plain `UPDATE documents SET content_md`, for scale.
  - `save_update_doc_row_with_trgm_gin`: the same update on the trigram-indexed table.
- Each side was warmed up 3 times. Then 7 runs, alternating order (forward, reverse, …). Each run = median of 5 calls. Reported values are the median and range of the 7 runs, in ms.
- Correctness: all three sides were checked against a ground-truth set computed in JS from the bodies (full sets, no limit). The LIMIT-50 results of A and B match in identical order. 2-hop sets were checked against a JS BFS. Row counts returned were recorded (`workCheck`). **errors = 0 in every run.**
- PGlite ships with `enable_seqscan=off`. Production uses real Postgres (`createDatabase` picks postgres-js for `postgres://` URLs), so the headline numbers use `SEQSCAN=on` (the stock planner). The `seqscanoff` files show PGlite's default for comparison.

Reproduce: `SEQSCAN=on bun bench.ts <N> 7 5 10`. Arguments: N, runs, calls/run, zipf q.

## Results, stock planner (`SEQSCAN=on`), q=10. Median [range] ms, 7 runs

| query | 5k docs (hub in=356) | 50k docs (hub in=3127) |
|---|---|---|
| backlinks hub, A LIKE (today) | 17.0 [15.6–19.1] | 126.3 [125.5–127.3] |
| backlinks hub, A + trgm GIN | 3.9 [3.6–5.0] | 18.6 [18.2–19.4] |
| backlinks hub, B links | 4.5 [2.6–5.2] | 36.1 [35.3–38.7] |
| backlinks median, A LIKE | 17.6 [15.3–19.7] | 126.9 [125.3–128.0] |
| backlinks median, A + trgm | 1.8 [1.2–2.1] | 4.5 [4.1–5.1] |
| backlinks median, B links | 1.0 [0.8–1.4] | 0.8 [0.6–1.3] |
| 2-hop hub, B (result size) | 13.7 [12.0–15.2] (2,035 docs) | 88.1 [87.3–89.8] (18,619 docs) |
| 2-hop median, B (result size) | 1.6 [1.1–2.3] (114) | 10.5 [10.2–10.9] (2,990) |
| save: re-derive links (txn) | 1.8 [1.5–2.1] | 1.3 [1.2–1.4] |
| save: UPDATE doc row only | 0.65 [0.60–1.0] | 0.48 [0.43–0.52] |
| save: UPDATE row, trgm GIN present | 1.1 [0.9–2.3] | 0.84 [0.77–0.86] |

One-off costs:

| | 5k | 50k |
|---|---|---|
| links rows | 19,857 | 200,228 |
| backfill all links (parse + insert) | 158 ms | 2.4 s |
| trgm GIN build | 1.5 s | 15.6 s |
| documents size | 9.5 MB | 92 MB |
| links size (with both indexes) | 2.8 MB | 27 MB |
| trgm GIN size | 5 MB | 49 MB |

PGlite default planner (`enable_seqscan=off`), 50k: B hub 16.4 [13.1–23.4], A LIKE hub 147.9 [125.1–168.9], A_trgm hub 22.0, 2-hop hub 97.4. The other rows are close to the table above. At 50k the stock planner hash-joins the whole `documents` table for the hub (a seq scan of 50k rows, 55 ms in EXPLAIN). The forced nested loop with Memoize is about 2x faster. So the B hub number is a planner-choice artefact. It can be tuned by avoiding the join, for example by denormalising `updated_at`/flags into `links`, or by fetching `LIMIT 50` ids and then joining. That tuning was not measured.

Stress case, plain Zipf q=0, 5k docs, seqscan off (`results-5000-steep-q0.json`): the hub has 2,262 inbound links (45% of docs). B hub 6.8 ms, A LIKE 11.7, A_trgm 9.6, 2-hop hub 34 ms (4,491 docs).

## Limiter and sanity
- Load average: 0.9–1.0 at the first run, rising to about 3.4–3.9 during the later runs (other agents on the box), on 16 cores. All sides were interleaved, so they saw the same noise.
- The limiter is **one CPU core inside single-threaded PGlite WASM**: `/usr/bin/time` on the 50k run gives user 44.8 s vs wall 43.2 s. RSS was 3.3 GB for the whole process, including the JS-side corpus copy.
- For A, EXPLAIN shows a seq scan that filters 46,873 rows. 92 MB / 126 ms ≈ 0.73 GB/s of LIKE matching. That is plausible for WASM and far below memory bandwidth. The 10x corpus gives 7.4x the time, so the cost is linear in bytes, as expected.
- For B, EXPLAIN shows index scans on `links_dst_idx` / `links_pkey`. The cost scales with the number of inbound rows, not the corpus. The median doc stays at about 1 ms from 5k to 50k.
- Limiting to 50 does not save A anything: the whole table is scanned before the top-N sort.

## Caveats
- PGlite/WASM only. Native Postgres on prod hardware should be several times faster on all sides [INFERENCE: not measured]. The *ratios* and the O(corpus) vs O(inbound) scaling are the transferable result.
- Tandem runs backlinks under RLS as `app_user` inside a transaction. RLS adds a per-row predicate on every side; it is not modelled here. With RLS, B's join filters only the inbound rows, while A pays the RLS cost on every row it scans [INFERENCE].
- The save cost is measured alone, in its own transaction (BEGIN/DELETE/INSERT/COMMIT round trips). Tandem's real save path also writes Yjs state, search_vector, task_assignees and audit rows. It was not measured (the repo is read-only), so the ~1.3–1.8 ms share of a real save is unknown. Inside the existing save transaction it would be cheaper.

## Answer
- **Rebuild on every save: yes.** About 1.3–1.8 ms per save at 5k and at 50k: flat, because it touches only one src's rows. That is roughly 1 ms more than the bare row update, and about the same as keeping a trigram GIN up to date.
- **Interactive queries: yes.** Backlinks take ≤ 5 ms at 5k for any doc. 2-hop takes ≤ 14 ms at 5k, even for a hub.
- **At 50k (10x):** today's LIKE goes to about 126 ms on *every* doc page and keeps growing linearly. B stays at about 1 ms for typical docs and 16–36 ms for a 3k-inbound hub (tunable). 2-hop stays under 100 ms, but its *result* is the problem: 3k–19k docs. Any graph view needs hub damping, depth 1, or a cap; this is a product problem, not a database one.
- If only backlinks matter, a trigram GIN on `content_md` is a one-migration fix: 4.5–19 ms at 50k. But it takes about 2x the space of `links`, and it cannot give outbound edges, 2-hop queries or typed relations. The links projection is the better base for anything graph-like, and it needs no graph DB.
