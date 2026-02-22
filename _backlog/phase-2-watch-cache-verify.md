# Phase 2: Watch Mode + Caching

**Depends on:** Phase 1 (Static Import Graph)
**Effort:** Days-weeks
**New file:** `src/graph/cache.ts`
**New deps:** None (mtime-only invalidation)

**Deliverable split:** Phase 2a (caching, one-shot) ships first. Phase 2b (watch mode) layers on top.

---

## Goal

Persist the dependency graph across runs for fast startup (Phase 2a), then make vitest-affected work in watch mode (Phase 2b).

**Deferred to Phase 3+:**
- **Verify mode** — diagnostic for static-analysis misses, but the fix (coverage data) doesn't exist until Phase 3. Two-pass execution within a single Vitest plugin has no verified API path.
- **Rename detection** — Phase 1's full-suite fallback on renames is correct and safe. Renames are infrequent; complexity/frequency ratio is poor.

---

## Phase 2a: Graph Caching (One-Shot)

### New file: `src/graph/cache.ts`

Single file handling graph persistence, cache-aware loading, and incremental updates.

#### Disk Format

```json
{
  "version": 1,
  "builtAt": 1708000000000,
  "files": {
    "/abs/path/src/utils/food.ts": {
      "mtime": 1708000000000,
      "imports": ["/abs/path/src/types.ts", "/abs/path/src/constants.ts"]
    }
  }
}
```

Stored at `.vitest-affected/graph.json` (gitignored). Auto-create directory on first write.

#### Public API

```typescript
import type { ResolverFactory } from 'oxc-resolver';

// Runtime type — converted from disk format on load
interface GraphSnapshot {
  forward: Map<string, Set<string>>;
  reverse: Map<string, Set<string>>;
  fileMtimes: Map<string, number>;
  builtAt: number;
}

// Load from cache or build fresh. Incrementally updates stale entries.
function loadOrBuildGraph(rootDir: string, verbose: boolean): Promise<GraphSnapshot>;

// Re-parse changed files, remove deleted files from graph.
// Resolver parameter required — create once via createResolver(rootDir) and reuse.
function updateGraphForFiles(
  snapshot: GraphSnapshot,
  changedFiles: string[],
  deletedFiles: string[],
  rootDir: string,
  resolver: ResolverFactory
): Promise<GraphSnapshot>;

// Atomic write (write-then-rename) to prevent corrupt cache on crash.
function saveGraph(snapshot: GraphSnapshot): Promise<void>;
```

#### Invalidation: mtime-only

Check file mtime via `lstat` (stat-only, no file reads). If mtime changed, reparse. If unchanged, skip.

**Why not content hashing:** Adding xxhash-wasm (dependency + WASM init) to catch "touch without edit" — a scenario where the cost of a false reparse is ~0.5ms. Not worth the complexity.

#### Phase 1 Integration

`buildFullGraph(rootDir)` returns `{ forward, reverse }` without mtimes. `loadOrBuildGraph` wraps this: on cache miss, calls `buildFullGraph`, then stats all files to collect mtimes (~10ms for 400 files, stat-only, one-time on cache miss).

**Required Phase 1 export:** `parseImports(file, source, rootDir, resolver)` — extract single-file parse+resolve from the `buildFullGraph` loop. Also export `createResolver(rootDir)` so both `buildFullGraph` and `updateGraphForFiles` share the same resolver instance.

### Implementation Steps (2a)

1. **Export `parseImports` and `createResolver` from `builder.ts`** — Extract single-file parse+resolve. Returns `Set<string>` of resolved absolute paths. Resolver is created once and reused.
2. **Implement `cache.ts`** — `loadOrBuildGraph`, `updateGraphForFiles`, `saveGraph`. Atomic writes via write-then-rename. Disk format conversion to/from Maps at load/save boundaries.
3. **Update `plugin.ts`** — Replace `buildFullGraph(rootDir)` with `loadOrBuildGraph(rootDir, verbose)`. Keep watch mode guard for now.
4. **Tests** — Cache round-trip, incremental updates (add/remove/modify), corrupt cache recovery, mtime invalidation.

---

## Phase 2b: Watch Mode

### How It Works

Vitest uses Vite's built-in file watcher (chokidar). On file change:
1. Vite HMR detects the change
2. Vitest calls `onFilterWatchedSpecification` for each test spec
3. Specs returning `false` are excluded from the re-run
4. Vitest re-runs remaining specs with a ~100ms debounce

### Key API: `vitest.onFilterWatchedSpecification`

```typescript
// On the Vitest instance (NOT TestProject — verified against docs)
// Called ONLY during watch-triggered reruns, NOT on initial run
// Multiple plugins: AND-ed (all must return true to keep a spec)
vitest.onFilterWatchedSpecification((spec: TestSpecification) => {
  return affectedTestSet.has(spec.moduleId);  // O(1) lookup only
});
```

### Architecture: Precomputed Affected Set

The filter callback must NOT compute BFS — it's called once per test spec (N BFS traversals). Instead:

1. **Watcher event fires** → enqueue handler
2. **Handler runs** → update graph incrementally, BFS once, store `currentAffectedSet`
3. **Vitest debounce expires** → calls filter per spec → `Set.has()` lookup

All watcher handlers are serialized through an async queue (`pending = pending.then(fn)`) to prevent concurrent mutation of the graph Maps/Sets.

### Unified Watcher Handler

```typescript
// Single handler for all watcher events — deduplicated logic
async function handleWatcherEvent(
  kind: 'change' | 'add' | 'unlink',
  absPath: string
): Promise<void> {
  if (!snapshot || !testFileSet) return;

  if (kind === 'unlink') {
    // Capture dependents BEFORE removing edges (BFS needs them)
    const dependents = snapshot.reverse.get(absPath);
    const seeds = dependents ? [...dependents] : [];
    snapshot = await updateGraphForFiles(snapshot, [], [absPath], rootDir, resolver);
    testFileSet.delete(absPath);
    // BFS from prior dependents of deleted file
    const isTestFile = (f: string) => testFileSet!.has(f);
    pendingAffectedFiles.push(...seeds);
  } else {
    snapshot = await updateGraphForFiles(snapshot, [absPath], [], rootDir, resolver);
    if (kind === 'add') {
      // New test file may have been added — re-discover
      const newSpecs = await project.globTestSpecifications();
      testFileSet = new Set(newSpecs.map(s => s.moduleId));
    }
    pendingAffectedFiles.push(absPath);
  }
}
```

### Event Coalescing

Rapid file changes (bulk find-and-replace, file renames) generate many watcher events. Without coalescing, each event triggers a separate `saveGraph` + BFS. Worse, a rename (unlink + add) can cause a full-suite fallback if the filter fires between the two events.

**Solution:** Accumulate changed files and flush as a batch after a short delay:

```typescript
let pendingAffectedFiles: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleFlush(): void {
  if (flushTimer) return;  // Already scheduled
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    // BFS once from all accumulated changed files
    const isTestFile = (f: string) => testFileSet!.has(f);
    const affected = bfsAffectedTests(pendingAffectedFiles, snapshot!.reverse, isTestFile);
    currentAffectedSet = new Set(affected);
    pendingAffectedFiles = [];
    await saveGraph(snapshot!, cacheDir);
  }, 50);  // 50ms coalesce window — well within Vitest's ~100ms debounce
}
```

This ensures:
- **Renames** (unlink + add) batch into one flush — no full-suite fallback
- **Bulk saves** (50 files) batch into one BFS + one `saveGraph` write
- **Single file changes** see ~50ms added latency — still well within Vitest's debounce

### Plugin Structure

```typescript
async configureVitest({ vitest, project }) {
  // ... API shape guard, load graph ...

  if (vitest.config.watch) {
    // Register filter (reads precomputed Set — O(1) per spec)
    vitest.onFilterWatchedSpecification((spec) => {
      if (!currentAffectedSet) return true;  // null = run everything (safe)
      return currentAffectedSet.has(spec.moduleId);
    });

    // Register watcher events (may need lazy registration — see Known Limitations)
    const watcher = vitest.server?.watcher;
    if (watcher) {
      for (const event of ['change', 'add', 'unlink'] as const) {
        watcher.on(event, (filePath: string) => {
          const absPath = path.resolve(rootDir, filePath);
          enqueue(() => handleWatcherEvent(event, absPath).then(scheduleFlush));
        });
      }
    } else {
      console.warn('[vitest-affected] No file watcher — watch filtering disabled');
    }
  }

  // One-shot logic runs UNCONDITIONALLY (handles initial run in both modes)
  // In watch mode, this covers the initial run since onFilterWatchedSpecification
  // is NOT called for the first run.
  const { changed, deleted } = await getChangedFiles(rootDir, options.ref);
  // ... Phase 1 BFS, threshold, config.include mutation ...
}
```

### Implementation Steps (2b)

5. **Remove watch mode guard from `plugin.ts`** — Replace with `onFilterWatchedSpecification` registration on the `vitest` instance (not `project`).
6. **Add unified watcher handler** — Single `handleWatcherEvent(kind, absPath)` function. Access watcher via `vitest.server?.watcher` (chokidar).
7. **Add event coalescing** — Accumulate changed files, flush after 50ms. One BFS + one `saveGraph` per batch.
8. **Serialize handlers via async queue** — `enqueue()` wrapper ensures no concurrent graph mutation.
9. **Tests** — Mock watcher events + filter calls, concurrent handler serialization, rename event batching, new test file discovery.

---

## Options Added in Phase 2

```typescript
export interface VitestAffectedOptions {
  // Phase 1 options
  disabled?: boolean;
  ref?: string;
  verbose?: boolean;
  threshold?: number;

  // Phase 2 addition
  cache?: boolean;  // Persist graph to .vitest-affected/ (default: true)
}
```

---

## Known Limitations (Phase 2)

- **`onFilterWatchedSpecification` AND semantics:** If another plugin also registers a filter, results are AND-ed. vitest-affected's filter may conflict with other watch-mode plugins.
- **`vitest.server?.watcher` availability:** Requires a Vite dev server. Available in default pool modes (`threads`, `vmThreads`). May be undefined in `browser` mode or non-standard configurations. Watch filtering silently disables with a warning.
- **`vitest.server` at `configureVitest` time:** The Vite dev server may not be fully initialized when `configureVitest` fires. If `vitest.server` is undefined, watcher registration must be deferred. Verify lifecycle ordering with a spike against Vitest 3.x; if needed, register lazily in a `configResolved` hook or after `onInit`.
- **Async handler / filter timing:** The filter reads `currentAffectedSet` synchronously. Watcher handlers compute it asynchronously. In practice, single-file parse+save is ~5ms (well within the ~100ms debounce). But if a handler takes >50ms (large file, slow disk), the filter may read a stale set from the prior event. This over-runs (safe) rather than under-runs.
- **Event coalescing window:** The 50ms coalesce window means very rapid changes within 50ms batch together. If Vitest's debounce fires before the coalesce flush, the filter sees null or a prior affected set and runs the full suite (safe fallback).
- **New test files in watch mode:** Discovered via `globTestSpecifications()` re-call on `add` events. Brief window between file creation and spec discovery where the test won't be included.
- **Mtime-only invalidation:** `touch` without edit causes unnecessary reparse (~0.5ms per file). Acceptable tradeoff vs adding content hashing dependency.
- **Watcher path format:** chokidar may emit relative or absolute paths depending on config. `path.resolve(rootDir, filePath)` handles both (`path.resolve` with an absolute second arg ignores the first). Assumption: Vite's watcher cwd matches `rootDir`. In monorepo setups where they differ, relative paths could resolve against the wrong base.
- **Cache version migration:** Unknown `version` field triggers full rebuild. No migration path in Phase 2.

---

## Refinement Log

### Round 1 (Medium: Builder/Breaker/Trimmer — 3x Opus)

- **Changes:** 10 auto-applied (3 Critical, 5 High, 2 structural)
- **Key fixes:** Fixed `onFilterWatchedSpecification` API host (project → vitest). Fixed watcher API (chokidar `.on()` vs `vitest.server.watcher`). Removed phantom `getWatcherChangedFiles()` — replaced with precomputed affected set. Fixed BFS-per-spec performance. Added `buildFullGraph` → `GraphSnapshot` wrapping. Added async queue for watcher serialization. Atomic cache writes. Collapsed loader.ts + cache.ts.
- **Deferrals:** Verify mode to Phase 3 (3/3). Rename detection indefinitely (2/3). xxhash-wasm removed (2/3).
- **Consensus:** API host wrong 3/3. Race condition 2/3. BFS-per-spec 3/3. Verify defer 3/3.
- **Trajectory:** Critical issues found → continue to Round 2

### Round 2 (Medium: Builder/Breaker/Trimmer — 3x Opus)

- **Changes:** 9 applied (1 Critical, 5 High, 3 Medium)
- **Key fixes:** Fixed `parseImports` to accept resolver parameter + added `createResolver` export from builder.ts. Fixed `unlink` handler to BFS from dependents before cleanup (avoids full-suite fallback). Added event coalescing (50ms window) to handle rename batching and bulk saves. Clarified one-shot logic runs unconditionally (initial run in both modes). Added `vitest.server` timing to Known Limitations. Compressed pseudocode ~40% (plan-level, not implementation-level). Collapsed 3 watcher handlers into unified handler. Removed duplicate Race Condition section. Removed premature `cacheDir` option.
- **Consensus:** `parseImports` needs resolver 2/3. Unlink BFS fix 2/3. Rename race / event coalescing 2/3. Code structure ambiguity 2/3. Server timing 2/3. Pseudocode compression Trimmer only.
- **Trajectory:** No Critical remaining after fix. High issues addressed. Medium-only findings remain → finalize
