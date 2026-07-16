/**
 * Analysis — turns a replay run's raw per-commit artifacts (A2a layout:
 * ledger.jsonl, stats/<sha>.jsonl, outcomes/<sha>.json, graphs/<sha>.json)
 * into an honest measurement. This module (with detector.ts) is the canonical
 * home of the denominator/exemption rules.
 *
 * MEASUREMENT MODEL
 * -----------------
 * Per ok commit C (in walk order):
 *   - freshMap_C  = graphs/<sha>.json — the ground-truth full runtime edge map
 *     captured at C (the harness ran the full suite). Used for the REQUIRED set.
 *   - cacheBefore_C = the simulated live selective cache (see evolution.ts) —
 *     what a live plugin would have LOADED at C. evolveStep yields both the
 *     SIMULATED live selection at C (detection input AND — for selective /
 *     cache-dependent decisions — the persistence scope; recorded
 *     selectedFiles are never fed back, preserving the drift feedback loop)
 *     and cacheAfter_C, which threads into C+1. The harness never writes the
 *     live repo's cache — this evolution exists only in analysis memory.
 *   - misses_C (shadow-selective commits only) = required(freshMap_C, changed)
 *     minus the simulated live selection at C.
 *
 * DENOMINATOR & EXEMPTIONS (the honesty rules)
 *   - Miss-rates are computed over shadow-selective decisions ONLY. Designed
 *     full-suite fallbacks (config-change, cache-miss, threshold-exceeded, and
 *     every other full-suite reason) are miss-exempt BY DEFINITION (selection
 *     ⊇ all) — they are reported as segmented fallback-frequency instead.
 *   - Leading warm-up commits (ok full-suite decisions before the FIRST
 *     selective decision) are segmented out of both the rate and the fallback
 *     frequency: a cold cache warming up is not a fallback event.
 *   - Selective commits with missing artifacts are UNMEASURABLE: listed
 *     loudly, excluded from the denominator — never silently counted clean.
 *   - DEGENERATION GUARD: zero selective decisions across the ENTIRE walk
 *     throws (surfaced on the report path → process exit) — a silent
 *     all-full-suite walk is list-only degeneration in disguise.
 *
 * IMPORT NOTE (load-bearing): mergeRuntimeEdges / ReverseMap come from the
 * BUILT private entry ('../../dist/internal.js') via evolution.ts — the same
 * artifact the replay harness ships against — never from src (importing src
 * would measure unbuilt code). Run `npm run build` if dist is stale/missing.
 *
 * This file is a THIN BARREL over the four seam modules below — kept as a
 * re-export surface so every existing `./analysis.js` /
 * `../tools/replay/analysis.js` import keeps working:
 *
 *   - parsers.ts       — artifact parsing (ledger/outcomes/graph)
 *   - flake.ts         — flake guard (flakeCheckCommit/spawnDisabledRerun/loadFlakyBySha)
 *   - analyze.ts       — analyzeRun (the run-analysis core implementing the model above)
 *   - report-writer.ts — analysis.md render + write, degeneration diagnosis
 */
export * from './parsers.js';
export * from './flake.js';
export * from './analyze.js';
export * from './report-writer.js';
