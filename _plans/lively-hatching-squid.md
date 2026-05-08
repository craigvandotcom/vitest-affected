# Runtime-First Architecture Refactor

## Context

vitest-affected currently builds its own dependency graph by parsing every source file with oxc-parser and resolving every import with oxc-resolver (~166ms for 433 files). But Vitest's `importDurations` API already provides a **perfect** runtime dependency graph — the entire static analysis pipeline is an approximation of something Vitest gives for free.

**The key proof:** The "one run behind" gap is **logically impossible** in git workflows. Adding a new import requires modifying a file. That modification puts the file in `git diff`. Git diff makes it a BFS seed. BFS finds the file's dependents (tests). Those tests run. `importDurations` captures the new edge. The reverse map is updated. There is no gap — the runtime graph is self-healing through the git-diff-as-seed mechanism.

**Implication:** If delta parse is unnecessary, then oxc-parser and oxc-resolver are unnecessary. The entire static analysis pipeline (builder.ts, cache mtime tracking, glob-based file discovery, sync/async code duplication) can be eliminated.

**Outcome:** ~1,660 lines of source -> ~400 lines. Zero native dependencies (remove oxc-parser, oxc-resolver). Cache format simplified to a plain reverse map. Same safety invariant (any failure -> full suite).

## Architecture

```
Cache hit:   load reverse map -> git diff -> BFS -> select       (~1ms)
Cache miss:  full suite (same as no plugin)                      (happens once)
After run:   importDurations -> update reverse map -> persist    (cache for next time)
Watch mode:  BFS filter using cached reverse map + reporter updates after each run
```

## Implementation Phases

### Phase 1: Rewrite source files

All source changes happen in this phase.

#### 1a. Replace cache.ts (~30 lines replace ~700)

**File:** `src/graph/cache.ts`

Replace all v1 cache logic with two bare functions:

```typescript
interface CacheDiskFormatV2 {
  version: 2;
  builtAt: number;
  reverseMap: Record<string, string[]>;  // source -> test files that import it
}

export function loadCachedReverseMap(
  cacheDir: string, rootDir: string, verbose?: boolean
): { reverse: Map<string, Set<string>>; hit: boolean }

export function saveCacheSync(
  cacheDir: string, reverse: Map<string, Set<string>>
): void
```

- `loadCachedReverseMap`: reads `graph.json`, parses JSON with `safeJsonReviver`, checks `version === 2`, deserializes `reverseMap: Record<string, string[]>` into `Map<string, Set<string>>`. Path confinement via existing `isUnderRootDir`. Any non-v2 format (v1, corrupt, missing) -> `{ reverse: new Map(), hit: false }`. No v1 migration — treat as cache miss, runtime repopulates on first full run.
- `saveCacheSync`: atomic write (`writeFileSync` to `.tmp` + `renameSync`) of `{ version: 2, builtAt: Date.now(), reverseMap }` where reverseMap values are `Array.from(set)`.

Keep helpers: `safeJsonReviver`, `cleanupOrphanedTmp`, `isUnderRootDir`.

Remove everything else: `loadOrBuildGraph`, `loadOrBuildGraphSync`, `saveGraph`, `saveGraphSyncInternal`, `statAllFiles`, `diffGraphMtimes`, `loadCachedMtimes`, `pruneRuntimeEdges`, `entriesToMaps`, `isValidFilesObject`, `isValidRuntimeEdgesObject`, `CacheFileEntry`, `CacheDiskFormat` (v1 interface).

#### 1b. Delete builder.ts and remove native dependencies

**File:** `src/graph/builder.ts` — **DELETE ENTIRELY**

This file contains all static analysis (oxc-parser import extraction, oxc-resolver path resolution, full graph building). With the runtime-first architecture, none of this is needed.

**File:** `package.json` — Remove from `dependencies`:
- `oxc-parser` (native WASM dep)
- `oxc-resolver` (native dep)

Keep `tinyglobby` — still used in `plugin.ts` for globbing test file patterns.

Run `npm install` after removing dependencies.

#### 1c. Rewire plugin.ts

**File:** `src/plugin.ts`

**Import changes:**
- Remove: `buildFullGraph`, `GRAPH_GLOB_IGNORE` from `./graph/builder.js`
- Remove: `loadOrBuildGraph`, `saveGraph`, `loadOrBuildGraphSync`, `saveGraphSyncInternal`, `diffGraphMtimes` from `./graph/cache.js`
- Add: `loadCachedReverseMap`, `saveCacheSync` from `./graph/cache.js`

**Hoisted state changes:**
- Remove `forward: Map<string, Set<string>>` (not needed — reverse map is the only graph)
- Remove `accumulatedRuntimeEdges` (reverse map IS the accumulator)
- Keep `reverse`, `cacheDir`, `runtimeSetRootDir`
- Add `isFullSuiteRun: boolean` (tracks whether this was a full or selective run, for replace vs union in reporter)

**`config()` hook changes:**

1. **Remove `if (!forward) return;` guard** (line 188) from the `onEdgesCollected` callback. With `forward` removed, this guard would silently prevent all edge collection. Replace with `if (!reverse) return;`.
2. `onEdgesCollected` callback: **eagerly and synchronously union** incoming `edges` into the hoisted `reverse` map, then call `saveCacheSync(cacheDir, reverse)`. The union MUST complete before the callback returns because `createRuntimeReporter` calls `runtimeReverse.clear()` immediately after the callback (line 110 of current code). The current `mergeRuntimeEdges` iterates eagerly — the replacement must preserve this property.
3. On full-suite runs (`isFullSuiteRun === true`): the runtime reporter captures the complete dependency graph. **Replace** the reverse map entirely instead of union — this prunes stale edges from deleted imports. For selective runs, union (to preserve edges for non-selected tests).
4. Remove `mergeRuntimeEdges` function (replaced by direct eager union/replace + save)
5. Remove `accumulatedRuntimeEdges` logic
6. On save failure: `reverse` retains all edges in memory — next `onTestRunEnd` retries save. No separate accumulator needed.

**`configureVitest()` changes:**

The ordering of operations is critical. Several things must happen BEFORE the cache-miss early return:

1. Resolve `rootDir`, `cacheDir`, `originalInclude`, `originalExclude` (same as current)
2. **Call `runtimeSetRootDir(vitest.config.root)` UNCONDITIONALLY** — without this, the runtime reporter's `onTestModuleEnd` guard (`if (!rootDir) return;`) drops all edges on cache-miss runs, preventing cache from ever being populated
3. Call `loadCachedReverseMap(cacheDir, rootDir, verbose)` to get `{ reverse, hit }`
4. **Register watch filter UNCONDITIONALLY** (before early return) — the watch filter handles `reverse.size === 0` by passing through all specs. Without this, the first-run Vitest process has no watch filter and watch mode is unfiltered.
5. **On cache miss (`hit === false`):** set `isFullSuiteRun = true`, then **early return** — skip BFS, let Vitest run full suite. Runtime reporter collects edges on this run, populating cache for next time. Do NOT fall through to the zero-tests path — `allowNoTests: true` + empty BFS = zero tests run = cache never populated = stuck forever.
6. Proceed with git diff, BFS, selection (same logic as current, but no delta parse step)
7. BFS seeds are `allChangedFiles` (changed + deleted from git diff)
8. Replace all `forward.size` references with `reverse.size` for stats logging (8 occurrences)
9. Set `isFullSuiteRun` based on whether the result was full-suite or selective (for reporter to know whether to replace or union)

**Watch mode changes:**

1. Simplify `onFilterWatchedSpecification` — replace the full mtime-diff + graph-rebuild logic (~90 lines) with a BFS filter using the cached `reverse` map
2. **`isTestFile` predicate**: hoist the test file set from the initial `glob(includePatterns)` call in `configureVitest`. Pass this to `bfsAffectedTests` in the watch filter. Note: this set is stale for newly-created test files during a watch session, but the conservative pass-through (step 3) handles them safely.
3. **Conservative pass-through for unknown specs**: return `true` for any spec not in the BFS affected set AND not present as a key in `reverse`. The reverse map keys are "imported-by" entries — a leaf test file that imports nothing won't be a key. Using `return true` for unknowns is the correct conservative default (slightly wider than the current `forward.has()` check, since forward tracked all files while reverse only tracks imported files).
4. On file change in watch mode: BFS from changed files using `reverse` + hoisted `isTestFile` -> return true only for specs in the BFS result; return true for unknown specs (conservative)
5. The runtime reporter still fires after each watch-mode test run, updating `reverse` in memory (and persisting to disk)

**Remove from plugin.ts:**
- `mergeRuntimeEdges` function (~12 lines)
- `accumulatedRuntimeEdges` variable
- `if (!forward) return;` guard in onEdgesCollected
- `forward` from hoisted state and all `forward.size` references
- Complex mtime-diff logic in watch filter (~90 lines)
- `forward.has(moduleId)` conservative guard
- All imports from `./graph/builder.js` and removed cache functions

#### 1d. Update exports in `src/index.ts`

Current exports are just `vitestAffected` and `VitestAffectedOptions` — these stay. `mergeRuntimeEdges` and `createRuntimeReporter` are exported from `plugin.ts` but not re-exported from `index.ts`, so no changes needed unless we want to clean up those exports.

**Gate:** `tsc --noEmit && npm run build && npx vitest run`

### Phase 2: Update tests

#### Tests to delete entirely:
- `test/cache.test.ts` (387 lines) — tests v1 async cache logic
- `test/cache-sync.test.ts` (628 lines) — tests v1 sync variants, mtime diffing
- `test/cache-robustness.test.ts` (714 lines) — tests v1 schema validation
- `test/cache-new-file-discovery.test.ts` (286 lines) — tests v1 glob discovery
- `test/builder.test.ts` (327 lines) — tests static analysis functions (all removed)

#### Tests to add:
- `test/cache-v2.test.ts` (~50 lines) — v2 round-trip, corruption recovery, non-v2 treated as miss, path confinement

#### Tests to update:
- `test/plugin.test.ts` — update mock context (no forward graph, cache miss = full suite, no builder imports)
- `test/watch.test.ts` — simplify to BFS-filter tests (no mtime-diff scenarios, no graph rebuild, no perf ceiling)
- `test/runtime.test.ts` — update integration scenarios (direct union + save, not mergeRuntimeEdges; replace vs union based on isFullSuiteRun)
- `test/runtime-unit.test.ts` — remove mergeRuntimeEdges tests, keep createRuntimeReporter tests
- `test/integration.test.ts` — update assertions for v2 cache format and simplified flow

**Gate:** `tsc --noEmit && npm run build && npx vitest run`

## Files Summary

| File | Action | Before | After (est.) |
|------|--------|--------|--------------|
| `src/plugin.ts` | Heavy modify | 560 | ~350 |
| `src/graph/builder.ts` | **Delete** | 216 | 0 |
| `src/graph/cache.ts` | Heavy modify | 704 | ~30 |
| `src/graph/normalize.ts` | Unchanged | 16 | 16 |
| `src/git.ts` | Unchanged | 138 | 138 |
| `src/selector.ts` | Unchanged | 25 | 25 |
| `src/index.ts` | Unchanged | 2 | 2 |
| **Source total** | | **~1,660** | **~560** |

| Test File | Action | Before | After (est.) |
|-----------|--------|--------|--------------|
| `test/builder.test.ts` | **Delete** | 327 | 0 |
| `test/cache.test.ts` | **Delete** | 387 | 0 |
| `test/cache-sync.test.ts` | **Delete** | 628 | 0 |
| `test/cache-robustness.test.ts` | **Delete** | 714 | 0 |
| `test/cache-new-file-discovery.test.ts` | **Delete** | 286 | 0 |
| `test/cache-v2.test.ts` | **New** | 0 | ~50 |
| `test/plugin.test.ts` | Modify | 116 | ~100 |
| `test/runtime.test.ts` | Modify | 601 | ~350 |
| `test/runtime-unit.test.ts` | Modify | 246 | ~180 |
| `test/watch.test.ts` | Heavy simplify | 576 | ~100 |
| `test/integration.test.ts` | Modify assertions | 439 | ~350 |
| `test/selector.test.ts` | Unchanged | 85 | 85 |
| `test/git.test.ts` | Unchanged | 175 | 175 |
| `test/graph/normalize.test.ts` | Unchanged | 34 | 34 |
| **Test total** | | **~4,614** | **~1,424** |

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| First run (no cache) | Early return -> full suite. importDurations populates cache. |
| v1 cache (any format) | Treated as cache miss -> full suite -> cache repopulated as v2. |
| Corrupt cache | JSON parse fails -> cache miss -> full suite. |
| Changed file adds new import | File in git diff -> BFS seed -> test runs -> importDurations captures new edge. No gap. |
| New test file (not in cache) | In git diff + in test glob -> selected directly as BFS seed. |
| Deleted source file | In git diff as BFS seed -> dependents from cached reverse map run. |
| No git changes | Full suite (same as current). |
| Config file changed | Full suite (same as current). |
| Watch mode | BFS filter using cached reverse map. Reporter updates reverse map after each run. |
| `allowNoTests: true` + cache miss | Early return path (not zero-tests path) -> full suite runs, cache populated. |
| Runtime reporter save fails | Edges retained in memory `reverse`, retried on next onTestRunEnd. |
| Stale edges (deleted import) | Full-suite runs replace reverse map entirely (pruning). Selective runs union (preserving). |

## Verification

After Phase 1 (source changes), run the quality gate:
```bash
tsc --noEmit && npm run build && npx vitest run
```

After Phase 2 (final):
1. Run quality gate
2. Test against a real project: modify a source file, run `npx vitest run`, verify selective test execution
3. Verify first-run behavior: delete `.vitest-affected/graph.json`, run full suite, verify v2 cache created
4. Verify second-run behavior: modify a file, run again, verify selective execution from cached runtime graph
5. Verify watch mode: run `npx vitest --watch`, modify files, verify BFS-filtered test selection
6. Verify cache miss recovery: corrupt `graph.json`, run, verify full suite + cache repopulated

## Refinement Log

### Round 1 (Medium: Builder/Breaker/Trimmer)

- **Changes:** 8 applied (3 Critical, 5 High)
- **Key fixes:**
  - Delta parse: fixed from no-op (seeds without edges) to recursive BFS parse that mutates reverse map in-place
  - onEdgesCollected: union into hoisted reverse map before saving (prevents partial overwrites)
  - Cache miss: early return instead of falling through to zero-tests path (prevents stuck state with allowNoTests)
  - Watch mode: BFS filter using cached reverse map instead of pass-through (preserves filtering value)
  - Collapsed 4 phases into 2 (source changes + test updates)
  - No v1 migration (treat as cache miss, runtime repopulates)
  - Keep save retry resilience via accumulator pattern
  - Replace forward.size with reverse.size in stats (8 occurrences)
- **Consensus:** 3/3 on delta parse being broken as designed (diverged on remove vs fix -- chose fix based on Builder+Breaker evidence that the *concept* matters even though the *implementation* was wrong). 2/3 on onEdgesCollected overwrite bug. 2/3 on watch mode pass-through being a regression.
- **Trajectory:** Critical/High fixes applied -> continue to Round 2 for verification

### Round 2 (Medium: Builder/Breaker/Trimmer)

- **Changes:** 6 applied (2 Critical, 4 High)
- **Key fixes:**
  - Early return restructured: setRootDir and watch filter register BEFORE cache-miss early return (prevents stuck state where reporter can't collect edges, and first-run watch mode has no filter)
  - Removed `if (!forward) return;` guard in onEdgesCollected (would silently block all edge collection with forward removed)
  - Specified eager/synchronous union requirement (runtimeReverse.clear() fires after callback -- lazy iteration would lose data)
  - Watch mode: specified isTestFile source (hoisted test file set) + conservative pass-through for unknown specs
  - Accumulator pattern simplified: reverse map IS the accumulator, no separate variable
  - Added replace-on-full-suite-runs to prevent reverse map growing without bound (stale edges from deleted imports)
  - Fixed plugin.ts estimate from ~300 to ~490
- **Consensus:** 3/3 on watch mode needing isTestFile + conservative pass-through. 2/3 on early return skipping registrations. Trimmer re-raised delta parse removal with structural BFS-direction proof (deferred to user).
- **Trajectory:** No new Critical after fixes. Remaining contention: delta parse (user decision). -> finalize

### Round 3 (Paradigm shift: eliminate all static analysis)

- **Changes:** 1 paradigm-level change
- **Key insight:** The Trimmer's BFS-direction proof from R2 was correct: delta parse edges are structurally unreachable by the current-run BFS. BFS walks `reverse.get(file)` (dependents, upward toward tests), while delta parse inserts `reverse[newImport].add(changedFile)` (downward). These edges only serve future runs -- which importDurations already handles. Further analysis proved the "one run behind" gap is **logically impossible** in git workflows: adding an import requires modifying a file -> file in git diff -> BFS seed -> tests run -> importDurations captures the new edge. No gap exists.
- **Implication:** If delta parse is unnecessary, oxc-parser and oxc-resolver are unnecessary. The entire static analysis pipeline is eliminated. builder.ts is deleted. Dependencies reduced to zero native packages.
- **Architecture:** `cache hit -> git diff -> BFS -> select (~1ms)`. Cache miss = full suite = same as running Vitest without the plugin. Runtime reporter populates cache after every run.
- **Trajectory:** Paradigm shift accepted by user. Plan rewritten to runtime-only architecture.
