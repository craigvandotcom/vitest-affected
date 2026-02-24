# Code Review: Phase 2 Cache + Watch Mode + Phase 3 Runtime Edges

**Date:** 2026-02-24
**Branch:** wave/phase2-cache-watch
**Base:** main
**Plan:** _backlog/intelligent-test-selection.md (Phase 2 + Phase 3)
**Reviewers:** Security, Performance, Architecture, Correctness
**Rounds:** 2

---

## Summary

| Category     | Critical | High | Medium | Auto-Fixed |
| ------------ | -------- | ---- | ------ | ---------- |
| Security     | 0        | 3    | 4      | 2          |
| Performance  | 0        | 4    | 6      | 0          |
| Architecture | 0        | 2    | 5      | 2          |
| Correctness  | 0        | 3    | 5      | 4          |
| **Total**    | **0**    | **12** | **20** | **8**    |

---

## Auto-Fixed Issues (8 total)

### Round 1 (5 fixes — severity-based + consensus)

1. **A1 (High):** Guard `reverse` uninitialized in `config()` callback — added `if (!reverse) return` in `plugin.ts:160`
2. **C4 (High):** `saveGraph` async wiped `runtimeEdges` on startup — added read-merge-write pattern in `cache.ts:216-231`
3. **C3 (Medium, safety):** `saveGraphSyncInternal` throw could crash Vitest reporter — wrapped in try/catch in `plugin.ts:162-165`
4. **C7 (Medium, safety):** Cache hit read error fell back to `[]` dropping edges — changed to `entry.imports` in `cache.ts:157`
5. **S4+C6 (Medium, consensus):** `normalizeModuleId` not applied to `importDurations` keys + `/@id/` guard used `includes` — fixed in `plugin.ts:80` and `normalize.ts:11`

### Round 2 (3 fixes — cross-round consensus)

6. **R1-A5 + R2-Sec-F4 + R2-Arch-F2 (cross-round):** `readFileSync` inside async `saveGraph` — changed to `await readFile` in `cache.ts:220`
7. **R1-C6 + R2-Sec-F1 + R2-Arch-F3 (cross-round):** `/@fs/` strip used `includes` — changed to `startsWith` in `normalize.ts:9`
8. **R2-Corr (High):** `loadOrBuildGraphSync` didn't filter deleted imports — added `existsSync` filter in `cache.ts:461`

---

## Needs Decision

### 1. Watch-mode performance: triple stat + globSync per batch
**Severity:** High | **Reviewers:** Performance, Architecture, Correctness (3/4 consensus)

The watch filter path does: loadCachedMtimes (read+parse graph.json) + loadOrBuildGraphSync (read+parse again, stat all files) + statAllFiles (stat again) + globSync (full filesystem scan) + saveGraphSyncInternal (read graph.json again if runtimeEdges omitted). That's 3 reads of graph.json and 2 stat passes per watch batch.

**Recommendation:** Refactor `loadOrBuildGraphSync` to return `{ forward, reverse, oldMtimes, currentMtimes }` and cache the glob result. This is optimization work suited for a follow-up bead, not a merge blocker.

### 2. loadOrBuildGraph doesn't discover new files
**Severity:** High | **Reviewer:** Correctness

The async cache-hit path only iterates `disk.files`. Files added since the cache was written aren't discovered. In practice: adding an import to an existing file changes that file's mtime, triggering reparse, which discovers the new target. The safety invariant is maintained (git diff catches new files; BFS includes changed seeds). Edge case only.

### 3. Cache JSON not schema-validated, paths not confined to rootDir
**Severity:** High | **Reviewer:** Security

`graph.json` parsed with only version check. Keys used as file paths without rootDir confinement. Low practical risk — cache is written by the same plugin, attacker needs write access to project dir. Defence-in-depth improvement for follow-up.

---

## All Findings

### Security

| # | Severity | File | Summary | Status |
|---|----------|------|---------|--------|
| S1 | High | cache.ts:112 | Unsafe JSON.parse — no schema validation | NEEDS_DECISION |
| S2 | High | cache.ts:135 | Cache path injection via unsanitized keys | NEEDS_DECISION |
| S3 | Medium | cache.ts:225 | Math.random temp file name | Deferred |
| S4 | Medium | plugin.ts:79 | importDurations keys not normalized | **AUTO-FIXED (R1)** |
| S5 | Medium | plugin.ts:209 | rootDir not validated | Deferred |
| S6 | Medium | plugin.ts:419 | Absolute paths in console warnings | Deferred |
| S7 | Medium | cache.ts:344 | runtimeEdges grows indefinitely | Deferred |

### Performance

| # | Severity | File | Summary | Status |
|---|----------|------|---------|--------|
| P1 | High | cache.ts:200 | Double stat in saveGraph startup | NEEDS_DECISION (group) |
| P2 | High | plugin.ts:248 | graph.json read twice in watch batch | NEEDS_DECISION (group) |
| P3 | High | plugin.ts:266 | Third stat pass in same batch | NEEDS_DECISION (group) |
| P4 | High | plugin.ts:270 | globSync on every watch batch | NEEDS_DECISION (group) |
| P5 | Medium | cache.ts:351 | saveGraphSyncInternal re-reads graph.json | NEEDS_DECISION (group) |
| P6 | Medium | cache.ts:162 | existsSync per-import on warm cache | Deferred |
| P7 | Medium | cache.ts:331 | Duplicate serialization loops | Deferred |

### Architecture

| # | Severity | File | Summary | Status |
|---|----------|------|---------|--------|
| A1 | High | plugin.ts:141 | reverse uninitialized in config() callback | **AUTO-FIXED (R1)** |
| A2 | High | cache.ts:351 | Read-modify-write in sync hot path | NEEDS_DECISION (group) |
| A3 | Medium | plugin.ts:248 | Double stat/diff per watch trigger | NEEDS_DECISION (group) |
| A4 | Medium | cache.ts:62 | Graph inversion duplicated 3x | Deferred |
| A5 | Medium | cache.ts:203 | lstatSync in async saveGraph | **AUTO-FIXED (R2)** |
| A6 | Medium | plugin.ts:57 | createRuntimeReporter in wrong layer | Deferred |
| A7 | Medium | plugin.ts:266 | Watch statAllFiles misses leaf-only files | Deferred |

### Correctness

| # | Severity | File | Summary | Status |
|---|----------|------|---------|--------|
| C1 | High | plugin.ts:248 | Watch filter stale oldMtimes first cycle | Deferred |
| C2 | High | cache.ts:135 | loadOrBuildGraph drops new files | NEEDS_DECISION |
| C3 | Medium | plugin.ts:105 | saveGraphSyncInternal throw crashes reporter | **AUTO-FIXED (R1)** |
| C4 | High | cache.ts:195 | saveGraph wipes runtimeEdges on startup | **AUTO-FIXED (R1)** |
| C5 | Medium | cache.ts:436 | Double diffGraphMtimes computation | NEEDS_DECISION (group) |
| C6 | Medium | normalize.ts:11 | /@id/ guard too broad | **AUTO-FIXED (R1)** |
| C7 | Medium | cache.ts:156 | Read error falls back to empty imports | **AUTO-FIXED (R1)** |
