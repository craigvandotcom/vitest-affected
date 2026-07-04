# Tier-0 stats.jsonl analysis (real BCA selection decisions)

**Bead:** va-yfn.5 (A3) — desk analysis only, no code changed.
**Source:** `/Users/craigvanheerden/Repos/neometa/software/body-compass-app/.vitest-affected/stats.jsonl`
**Lines:** 266 (all parsed cleanly — 0 malformed lines)
**Date range:** 2026-06-26T15:50:04.625Z → 2026-07-04T06:18:50.585Z (9 calendar days, uneven — see Anomalies)
**Method:** `python3` one-shot scripts run via Bash over the raw JSONL (no product code touched). Key numbers below; raw script output kept in shell history, not committed.

Context: `.vitest-affected/` is listed in BCA's `.gitignore` (confirmed: `.gitignore:238:.vitest-affected/`), so every line in this file is a **local dev run** of the plugin (pnpm test / watch invocations on Craig's or an agent's machine) — none of it is CI traffic. BCA's CI (`quality-gate.yml`) forces full-suite via `VITEST_AFFECTED_DISABLED=1` (see the CI-runner recon doc), so this dataset is the only real signal on selective-mode behavior so far.

## Schema (inferred from field presence across all 266 records)

Common to all records: `timestamp` (ISO8601 UTC), `action` (`selective` | `full-suite`), `changedFiles`, `deletedFiles`, `ignoredFiles`, `graphSize`, `durationMs`.

- `selective` (222 records): always also carries `affectedTests`, `totalTests`, `cacheHit`.
- `full-suite` (44 records): always also carries `reason`. 5 of the 44 additionally carry `affectedTests`/`totalTests`/`cacheHit` — these are all `reason: "no-affected-tests"` records (see below), where the plugin computed 0 affected tests and fell back to full-suite rather than running zero tests.
- No record contained an `error` field or action, and no field name containing "error" appeared anywhere in the file.

## 1. Selective vs full-suite ratio

| action | count | % of 266 |
|---|---|---|
| selective | 222 | 83.5% |
| full-suite | 44 | 16.5% |

Roughly **5:1 selective:full-suite** in real local usage.

## 2. Reason frequency (full-suite only — `reason` is absent on all selective records)

| reason | count | % of full-suite (44) |
|---|---|---|
| config-change | 25 | 56.8% |
| no-changes | 7 | 15.9% |
| setup-file-change | 7 | 15.9% |
| no-affected-tests | 5 | 11.4% |

No `cache-miss`, `threshold`, or `error` reasons appear anywhere in this 266-line sample. `config-change` dominates full-suite triggers by a wide margin — worth checking whether that reason is firing more often than intended (e.g. a config file being touched on nearly every session) in a future investigation, but that's outside this desk-analysis scope.

## 3. Selection-size distribution (selective runs only, n=222)

`affectedTests` (count of tests selected):

| stat | value |
|---|---|
| min | 1 |
| p25 | 9 |
| median | 37 |
| p75 | 46 |
| p95 | 76 |
| max | 81 |

As a **percentage of `totalTests`** (selected / total × 100, n=222 — every selective record carries both fields):

| stat | value |
|---|---|
| min | 0.17% |
| p25 | 1.58% |
| median | 6.41% |
| p75 | 8.19% |
| p95 | 13.04% |
| max | 13.85% |

Interpretation: on a real, actively-developed BCA codebase (~550–585 total tests over the window — see graph growth below), the plugin is typically selecting **~6% of the suite** on a median change, topping out at ~14% even at p95/max — i.e. no observed run selected anywhere close to the whole suite while still being classified `selective`. That's a strong practical signal that the affected-test graph is discriminating well in day-to-day use.

`changedFiles` on selective runs: min 1, median 12, max 26 — consistent with typical multi-file dev commits/saves rather than single-file edits.

## 4. durationMs trends

By action (milliseconds, full population):

| action | n | min | median | p95 | max | mean |
|---|---|---|---|---|---|---|
| selective | 222 | 67 | 158 | 731 | 1688 | 255.1 |
| full-suite | 44 | 53 | 183 | 613 | 779 | 228.6 |

Note: this is the **plugin's own selection/decision overhead** (graph diffing, cache lookup, deciding what to run), NOT actual vitest test-execution wall time — the stats file only records the plugin's decision step, not the downstream test run. Selective and full-suite decision costs are close on the median (158ms vs 183ms); selective has a longer tail (max 1688ms vs 779ms for full-suite), plausibly from larger `changedFiles`/`graphSize` diffing on some runs — not investigated further here (out of scope for this pass).

By full-suite `reason` (durationMs):

| reason | n | median | min | max |
|---|---|---|---|---|
| config-change | 25 | 244 | 109 | 779 |
| no-changes | 7 | 139 | 53 | 189 |
| setup-file-change | 7 | 114 | 104 | 682 |
| no-affected-tests | 5 | 123 | 105 | 255 |

`config-change` full-suite decisions are the slowest on median (244ms) and have the widest range — consistent with a full config re-evaluation being heavier than a quick "no changes" short-circuit.

**Over time:** `graphSize` (cached dependency-graph node count) grows monotonically across the window as the codebase grows — sampled every 30th record: 0 (cold start, first line) → 383 (2026-06-27) → 393 → 398 → 399 → 403 → 404 → 406 → 407. `totalTests` tracks the same growth where present: 553 → 558 → 569 → 574 → 574 → 577 (roughly +30 tests over the 9-day window). No evidence of duration growing with graph size in this sample — durations stay in the same 50–800ms band throughout, i.e. no visible scaling problem yet at this graph size.

## 5. Anomalies

- **cacheHit is always `true`.** Every one of the 222 selective records (and all 5 full-suite records that carry the field) shows `cacheHit: true` — zero observed cache misses in this 266-line sample. Either the cache genuinely never missed in this window (plausible for a single-developer-machine local cache that's rarely invalidated), or a `cacheHit: false` path exists in the code but simply wasn't exercised in this sample. Cite: schema supports the field; empirically it's a constant here — worth a targeted test if cache-miss durationMs is ever needed.
- **Uneven daily record counts**, consistent with normal working-hours dev activity, not a data-integrity problem: 2026-06-26: 28, 06-27: 37, 06-28: 2, 06-29: 55, 06-30: 51, 07-01: 3, 07-02: 14, 07-03: 74, 07-04: 2 (partial day at capture time).
- **Largest inter-record gaps** are all overnight/off-hours (e.g. 127,623s ≈ 35.5h between 06-27 08:55 and 06-28 20:22; 88,814s ≈ 24.7h between 07-01 09:26 and 07-02 10:06) — consistent with no dev activity outside working sessions, not a logging outage. No mid-session gaps of concerning length were found.
- **0 malformed lines** — every line parsed as valid JSON with no schema-violating records.
- The five `full-suite`/`no-affected-tests` records are a real, sensible edge case (plugin computed a graph, found 0 affected tests for the touched file(s), and fell back to running everything rather than running nothing) — not a data-quality issue, just a `full-suite` sub-case worth keeping distinct from `config-change`.

## Bottom line for downstream (Tier-0 sizing)

- Selective mode fires ~5x more often than full-suite in real usage.
- Selective runs are cheap on the graph side (~6% of suite selected at the median, never observed above ~14%).
- No `cache-miss` or `error` reasons were observed in this sample — `config-change`, `no-changes`, `setup-file-change`, and `no-affected-tests` are the only fallback triggers seen so far.
- This entire dataset is local-dev-only; it says nothing directly about CI behavior (see the companion CI-runner recon doc for that).
