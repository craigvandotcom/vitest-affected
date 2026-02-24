# Code Review: Phase 2 Cache + Watch

**Date:** 2026-02-24
**Branch:** wave/phase2-cache-watch
**Base:** main
**Plan:** _backlog/intelligent-test-selection.md
**Reviewers:** Security, Performance, Architecture, Correctness
**Rounds:** 1

---

## Summary

| Category     | Critical | High | Medium | Auto-Fixed |
| ------------ | -------- | ---- | ------ | ---------- |
| Security     | 0        | 2    | 5      | 2          |
| Performance  | 0        | 4    | 3      | 1          |
| Architecture | 1        | 4    | 2      | 2          |
| Correctness  | 0        | 2    | 3      | 0          |
| **Total**    | **1**    | **12** | **13** | **5**    |

---

## Auto-Fixed Issues

1. **normalize.ts off-by-one** (Critical — Security + Architecture consensus): `id.slice(4)` → `id.slice(5)` — fixes silent watch filter bypass for /@fs/ prefixed modules
2. **forward guard in onEdgesCollected** (High — Architecture): Added `if (!forward) return;` guard to prevent crash if test completes before graph build
3. **saveGraph async prune + validate runtimeEdges** (High — Architecture + Correctness consensus): Added `isValidRuntimeEdgesObject` check and `pruneRuntimeEdges` call — async save now matches sync path behavior
4. **existsSync redundancy** (High — Performance): Removed redundant `existsSync` before `lstatSync` try/catch — eliminates 1 syscall per cached file on startup
5. **JSON.parse prototype pollution reviver** (High — Security): Added `safeJsonReviver` to all 5 `JSON.parse` call sites — rejects `__proto__`/`constructor`/`prototype` keys

---

## Needs Decision

1. **runtimeReverse.clear() on interrupted** (High — Correctness): Stale edges from interrupted runs accumulate in memory. However, existing tests explicitly assert edges survive interrupts for accumulation. Trade-off: over-selection (safe) vs clean state per run.
2. **Dual async/sync divergence** (High — Performance + Architecture consensus): Sync path does full rebuild on any staleness vs async incremental reparse. Extract shared reconcile function to maintain in lockstep.
3. **existsSync per import O(imports)** (High — Performance): 2500 existsSync calls per cache-hit cycle on 500-file project. Needs design decision on batch-stat vs deferred filter.
4. **saveGraph redundant re-read** (High — Performance): saveGraph re-reads graph.json immediately after loadOrBuildGraph already parsed it. Needs API change to thread runtimeEdges.
5. **TestRunEndReason import provenance** (High — Architecture): Type import from vitest/reporters — needs version-pinned verification for >=3.1.0.
6. **New file discovery gap in sync path** (High — Correctness): Sync `loadOrBuildGraphSync` doesn't glob for new files when all cached files are up-to-date. Adding glob has performance implications.

---

## All Findings

### Security

1. **(High, AUTO-FIXED)** Prototype pollution via JSON.parse — added safeJsonReviver
2. **(High, AUTO-FIXED)** /@fs/ off-by-one in normalize.ts — `id.slice(4)` → `id.slice(5)`
3. **(Medium, DEFERRED)** No file size limit on cache read — potential OOM on crafted file
4. **(Medium, DEFERRED)** TOCTOU — existsSync + lstatSync without symlink check
5. **(Medium, DEFERRED)** Math.random() temp filename — not CSPRNG, collision in concurrent CI
6. **(Medium, NOTE)** Normalize bug + confinement coupling — dependent on fix #2
7. **(Medium, DEFERRED)** Error message info disclosure — absolute paths in logs

### Performance

1. **(High, AUTO-FIXED)** Double stat per file (existsSync + lstatSync) — removed existsSync
2. **(High, NEEDS_DECISION)** existsSync per import in cache-hit path — O(imports) syscalls
3. **(High, NEEDS_DECISION)** saveGraph reads graph.json again after loadOrBuildGraph parsed it
4. **(High, NEEDS_DECISION)** Full rebuild on any mtime change in sync path (watch hot path)
5. **(Medium, DEFERRED)** new Set(testFiles) rebuilt per watch batch
6. **(Medium, DEFERRED)** saveGraphSyncInternal re-reads cache on watch save
7. **(Medium, DEFERRED)** isUnderRootDir recomputes rootPrefix on every call

### Architecture

1. **(High, NEEDS_DECISION)** Dual async/sync paths with divergent staleness semantics
2. **(High, AUTO-FIXED)** saveGraph async doesn't prune runtimeEdges — now pruned + validated
3. **(Critical, AUTO-FIXED)** /@fs/ off-by-one — consensus with Security F2
4. **(High, AUTO-FIXED)** forward unguarded in onEdgesCollected — added guard
5. **(Medium, DEFERRED)** Internal functions exported — saveGraphSyncInternal leaks API
6. **(High, NEEDS_DECISION)** TestRunEndReason import provenance unverified
7. **(Medium, DEFERRED)** 95-line god function in onFilterWatchedSpecification

### Correctness

1. **(High, NEEDS_DECISION)** Stale runtimeReverse leaks across interrupted runs
2. **(High, NEEDS_DECISION)** New source files invisible to sync watch-filter staleness detection
3. **(Medium, AUTO-FIXED)** saveGraph async preserves runtimeEdges without validation — consensus with Architecture F2
4. **(Medium, DEFERRED)** bfsAffectedTests throw leaves batch rebuilding N times
5. **(Medium, DEFERRED)** isUnderRootDir uses path.sep — breaks on Windows
