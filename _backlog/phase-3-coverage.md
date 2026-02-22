# Phase 3: Coverage-Enhanced Selection

**Depends on:** Phase 2 (Watch Mode + Caching)
**Effort:** Days (reduced from weeks after refinement)
**New file:** `src/coverage.ts`
**New deps:** None (uses Node.js built-in APIs + Vitest's existing coverage output)

---

## Goal

Augment the static import graph with runtime coverage data. After test runs, read which source files each test worker actually loaded at runtime. Union these edges into the static graph to catch dependencies invisible to static analysis.

---

## Why Coverage Data Matters

Phase 1's static graph misses:

| Invisible dependency | Why static misses it | Coverage catches it |
|---|---|---|
| `import(variable)` | Computed specifier | Runtime reveals actual path |
| `require('./config')[env]` | Dynamic property access | Traces actual file |
| `vi.mock('./foo', () => import('./bar'))` | Mock factory is opaque | Factory executes, bar.ts in coverage |
| `fs.readFileSync('./data.json')` | Not an import | File appears in V8 coverage |

**Safety invariant preserved:** Coverage only ADDS edges (union). False negatives can only decrease.

---

## Integration Strategy: Post-Run File Reader

**Not** a custom coverage provider. Vitest writes per-worker V8 coverage to `<reportsDirectory>/.tmp/coverage-<N>.json` when `coverage.enabled = true`. Default `reportsDirectory` is `./coverage`, so the standard path is `<root>/coverage/.tmp/`. Phase 3 reads these files after the test run completes — no lifecycle hooks, no provider wrapping, no conflict with user coverage config.

### Why Not Custom Provider?

- `coverage.provider: 'custom'` replaces the entire V8/Istanbul pipeline — can't "wrap" it
- Requires a `customProviderModule` file path (separate disk file), not runtime registration
- Breaks users' existing `provider: 'v8'` or `provider: 'istanbul'` configs
- `TestModule.coverageData` doesn't exist on the reporter API

### How It Works

1. User enables V8 coverage in their config (or we auto-enable via Vite `config` hook)
2. Vitest runs tests, collecting V8 coverage per worker as normal
3. Coverage files are written to `<reportsDirectory>/.tmp/` (Vitest's standard behavior)
4. After run completes, our reporter's `onTestRunEnd` reads these files (sync, for atomicity)
5. Extract file-level mappings: which source files each worker loaded
6. Union into the static graph and persist

```typescript
// Reporter hook — runs after all tests complete
onTestRunEnd(testModules: TestModule[], unhandledErrors: Error[]) {
  const reportsDir = vitest.config.coverage?.reportsDirectory ?? 'coverage';
  const coverageDir = path.resolve(rootDir, reportsDir, '.tmp');
  const edges = readCoverageEdges(coverageDir, rootDir, testModules);
  // Union into existing graph and save
}
```

### Coverage File Format (Vitest writes this)

Each file in `<reportsDirectory>/.tmp/` is named `coverage-<N>.json` (auto-incrementing integer) and contains:

```json
{
  "result": [
    {
      "scriptId": "123",
      "url": "file:///abs/path/to/source.ts",
      "functions": [...]
    }
  ]
}
```

We only need `url` — which files were loaded. Function/range details are ignored.

**URL normalization:** Coverage URLs may be `file:///abs/path` or Vite-transformed (`/@fs/abs/path?v=hash`). Normalize by stripping query params and handling `/@fs/` prefix before matching.

---

## Architecture

### Single file: `src/coverage.ts`

```typescript
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Read Vitest's V8 coverage temp files and extract file-level edges.
 * Returns a reverse map: source file → Set<test files that loaded it>.
 *
 * Single-pass: for each coverage file, identify which test files appear
 * in the ScriptCoverage URLs (URL matching), then map all other loaded
 * source files to those test files (per-worker union).
 *
 * Uses sync I/O for atomicity — coverage .tmp/ files may be cleaned
 * by Vitest's reportCoverage shortly after onTestRunEnd fires.
 */
export function readCoverageEdges(
  coverageTmpDir: string,
  rootDir: string,
  testFileSet: Set<string>
): Map<string, Set<string>> {
  const reverse = new Map<string, Set<string>>();

  let files: string[];
  try {
    files = readdirSync(coverageTmpDir);
  } catch {
    return reverse; // No coverage dir — return empty
  }

  for (const f of files) {
    if (!f.startsWith('coverage-') || !f.endsWith('.json')) continue;

    let raw: string;
    try {
      raw = readFileSync(path.join(coverageTmpDir, f), 'utf-8');
    } catch {
      continue; // ENOENT — file cleaned mid-read, skip
    }

    const parsed = JSON.parse(raw);
    const scriptCoverages = parsed.result ?? [];

    // Single pass: separate test files from source files
    const testFilesInWorker: string[] = [];
    const sourceFilesInWorker: string[] = [];

    for (const sc of scriptCoverages) {
      const filePath = normalizeUrl(sc.url);
      if (!filePath) continue;
      if (!filePath.startsWith(rootDir)) continue;
      if (filePath.includes('node_modules')) continue;

      if (testFileSet.has(filePath)) {
        testFilesInWorker.push(filePath);
      } else {
        // Only include files actually executed (any function with count > 0)
        const executed = sc.functions?.some((fn: any) =>
          fn.ranges?.some((r: any) => r.count > 0)
        );
        if (executed) sourceFilesInWorker.push(filePath);
      }
    }

    // Per-worker union: all source files → all test files in this worker
    for (const testFile of testFilesInWorker) {
      for (const sourceFile of sourceFilesInWorker) {
        if (!reverse.has(sourceFile)) reverse.set(sourceFile, new Set());
        reverse.get(sourceFile)!.add(testFile);
      }
    }
  }

  return reverse;
}

/**
 * Normalize a coverage URL to an absolute file path.
 * Handles: file:// URLs, /@fs/ Vite URLs, query param stripping.
 * Returns null for non-file URLs (http, data, etc).
 */
function normalizeUrl(url: string | undefined): string | null {
  if (!url) return null;
  // Strip query params
  const bare = url.split('?')[0];
  if (bare.startsWith('file://')) return fileURLToPath(bare);
  if (bare.includes('/@fs/')) return bare.slice(bare.indexOf('/@fs/') + 4);
  return null;
}

/**
 * Merge coverage reverse graph into static reverse graph (additive union).
 * Coverage can only ADD edges, never remove them.
 */
export function mergeIntoGraph(
  staticReverse: Map<string, Set<string>>,
  coverageReverse: Map<string, Set<string>>
): void {
  for (const [file, tests] of coverageReverse) {
    if (!staticReverse.has(file)) {
      staticReverse.set(file, new Set(tests));
    } else {
      for (const t of tests) {
        staticReverse.get(file)!.add(t);
      }
    }
  }
}
```

### Per-Worker Union (No `isolate` Requirement)

Most users run default settings (`isolate: true` for forks, but `isolate: false` for threads). The plan does NOT require `isolate: true`.

- **`isolate: true`:** 1 test file per worker → 1:1 mapping (precise)
- **`isolate: false`:** N test files per worker → N:M mapping (over-selects, safe)

Per-worker union is always correct — it can over-select (run extra tests) but never under-select (miss failures). The precision difference rarely changes which tests run in practice, because BFS already fans out broadly through the dependency graph.

---

## Persistence: Fold Into `graph.json`

No separate `coverage-map.json`. Coverage edges are stored in the existing Phase 2 cache file:

```json
{
  "version": 2,
  "builtAt": 1708000000000,
  "files": { ... },
  "coverageEdges": {
    "src/utils/food.ts": ["tests/food.test.tsx", "tests/utils.test.ts"],
    "src/types.ts": ["tests/food.test.tsx", "tests/types.test.ts"]
  },
  "coverageCollectedAt": 1708000000000
}
```

**Simple relative paths:** `coverageEdges` maps relative source paths (from `rootDir`) to arrays of relative test file paths. No path compression or integer indices — with relative paths the map is ~200KB for 500 tests x 200 sources, well within tolerance. Add compression later if a real project exceeds 1MB.

**Version bump:** `version: 1` (Phase 2) → `version: 2` (Phase 3). Unknown version triggers full rebuild (existing behavior).

**Version migration:** When reading a version 1 cache (no `coverageEdges` field), treat as valid graph with empty coverage data. Bump to version 2 on next write. This allows seamless upgrade from Phase 2 → Phase 3 without a full rebuild.

### Invalidation

Coverage edges are invalidated when:
- **Test file content changes** (mtime mismatch) — mapping is stale, will be refreshed on next run
- **Source file deleted** — remove from all coverage edges

Between coverage collections, stale mappings are still used — better than no mapping. The next test run refreshes them.

---

## Plugin Integration

### Reporter Registration

The reporter must be pushed to `vitest.reporters` (the runtime array that `vitest.report()` iterates), **not** `vitest.config.reporters` (config-level tuples that are already resolved). This must happen after reporter initialization — in `configureVitest`, `vitest.reporters` is the live array.

**Lifecycle assumption:** `configureVitest` fires after reporters are instantiated. If Vitest changes this order, the reporter push would be overwritten. Verify against the Vitest version at implementation time. If `vitest.reporters` is overwritten after `configureVitest`, fall back to a separate reporter file registered via `vitest.config.reporters` tuple in the Vite `config` hook.

```typescript
// In plugin.ts — Phase 3 additions to configureVitest

// Resolve coverage tmp directory from user's config
const reportsDir = vitest.config.coverage?.reportsDirectory ?? 'coverage';
const coverageTmpDir = path.resolve(rootDir, reportsDir, '.tmp');

// After building/loading graph, merge cached coverage edges if available
const coverageEdges = snapshot.coverageEdges;  // From cached graph.json
if (coverageEdges) {
  mergeIntoGraph(snapshot.reverse, coverageEdges);
}

// Register reporter to collect new coverage after each run
vitest.reporters.push({
  onTestRunEnd(testModules: TestModule[]) {
    const testFileSet = new Set(testModules.map(m => m.moduleId));
    const newEdges = readCoverageEdges(coverageTmpDir, rootDir, testFileSet);
    mergeIntoGraph(snapshot.reverse, newEdges);
    // Persist updated graph with coverage edges
    saveGraph(snapshot, cacheDir);
  }
});
```

### Auto-Enabling Coverage

Coverage must be enabled before Vitest's `initCoverageProvider()` runs — which happens in `Vitest.start()`, before `configureVitest` fires. Therefore auto-enable must happen in the **Vite `config` hook** (runs during config resolution, before Vitest initialization):

```typescript
// In the Vite plugin config hook (runs before Vitest init)
config(config) {
  if (options.coverage === false) return; // User explicitly disabled
  const test = config.test ?? {};
  const cov = test.coverage ?? {};
  if (cov.enabled === undefined) {
    // Auto-enable: user hasn't explicitly configured coverage
    test.coverage = {
      ...cov,
      enabled: true,
      provider: 'v8',
      reporter: ['json'],  // Minimal reporter — needed for provider to function
      all: false,           // Only instrument executed files
    };
    config.test = test;
  }
}
```

**Note:** `reporter: ['json']` produces a small `coverage-final.json`. An empty `reporter: []` may cause the V8 provider to skip processing or error. Verify empirically; use `['json-summary']` as alternative if `['json']` is too large.

---

## Options Added in Phase 3

```typescript
export interface VitestAffectedOptions {
  // Phase 1+2 options
  disabled?: boolean;
  ref?: string;
  verbose?: boolean;
  threshold?: number;
  cache?: boolean;

  // Phase 3 addition
  coverage?: boolean;  // Use V8 coverage for enhanced selection (default: true)
                       // Set false to use static graph only
}
```

---

## Implementation Steps

1. **Implement `coverage.ts`** — `readCoverageEdges` (single-pass with URL matching inlined), `mergeIntoGraph`, `normalizeUrl`. Single file, pure functions, sync I/O.
2. **Update cache format** — Bump `version` to 2. Add `coverageEdges` (relative path strings) and `coverageCollectedAt` to `graph.json`. Handle v1→v2 migration (treat v1 cache as valid with empty coverage edges).
3. **Update `plugin.ts`** — Auto-enable V8 coverage in Vite `config` hook (before Vitest init). Push reporter to `vitest.reporters` in `configureVitest`. Merge cached coverage edges into BFS graph.
4. **Tests** — Coverage file parsing, URL normalization, edge extraction, merge correctness, v1→v2 migration, user-opt-out respect.

---

## Known Limitations (Phase 3)

- **Coverage must be enabled:** Phase 3 reads Vitest's V8 coverage output. If coverage is disabled by the user (`coverage: false`), Phase 3 falls back to static-only graph silently.
- **First-run cold start:** No coverage data on first run. Uses static graph only. Coverage map builds up over subsequent runs.
- **Coverage edges are one run behind:** Coverage data from run N only benefits run N+1's selection. This is acceptable — static analysis catches most cases on the current run, and coverage refines the graph incrementally.
- **Coverage file race:** `onTestRunEnd` fires between `generateCoverage()` and `reportCoverage()` (which calls `cleanAfterRun()`). Files should exist at read time, but sync I/O + per-file ENOENT catch guards against ordering changes in future Vitest versions.
- **URL normalization:** Coverage URLs may use Vite's `/@fs/` scheme or include query params. The `normalizeUrl` function handles known patterns. Unknown URL schemes are silently skipped — add verbose logging to detect silent failures.
- **`transformMode` assumption:** Coverage data may include both SSR and web transform modes. Phase 3 treats all modes uniformly (union). For projects with SSR+client split, this may over-select slightly.
- **Per-worker union with `isolate: false`:** All loaded files assigned to all tests in the worker. Over-selects but never under-selects.
- **Auto-enable coverage lifecycle:** Auto-enabling happens in Vite `config` hook. If Vitest changes when coverage config is consumed, auto-enable may stop working. Users can always explicitly set `coverage.enabled: true` as a guaranteed fallback.
- **Coverage JSON parsing:** Large coverage files (>10MB for complex projects) may cause memory spikes during `JSON.parse`. Add a file-size guard: skip files >20MB with a warning.

---

## Merge Algorithm: Why Additive

```
merged_graph = static_graph ∪ coverage_graph
```

- **Coverage adds edges** static analysis missed (dynamic imports, `require()`, mock factories)
- **Static graph keeps edges** coverage missed (code paths not exercised in test)
- **Result:** More tests may be selected (over-selection possible), fewer tests missed (under-selection reduced)

---

## Refinement Log

### Round 1 (Medium: Builder/Breaker/Trimmer — 3x Opus)

- **Changes:** 9 auto-applied (2 Critical, 7 High)
- **Key fixes:** Replaced custom coverage provider with post-run file reader (3/3 consensus — provider approach unviable). Fixed `AfterSuiteRunMeta.testFiles` plural array (3/3). Removed `TestModule.coverageData` (doesn't exist, 2/3). Auto-enable coverage only if not explicitly set (2/3). Collapsed 3 files into 1 `coverage.ts` (2/3). Folded coverage-map into `graph.json` (2/3). Dropped `coverageIsolate` option — per-worker union always (2/3). Added path compression for scale (2/3). Added 24h staleness TTL (2/3).
- **Consensus:** Provider approach broken 3/3. `testFiles` is array 3/3. Simplification 2/3 across all cuts.
- **Trajectory:** Critical issues found → continue to Round 2 for verification

### Round 2 (Medium: Builder/Breaker/Trimmer — 3x Opus)

- **Changes:** 7 applied (2 Critical, 2 High, 1 Medium consensus + 2 Trimmer simplifications)
- **Key fixes:**
  - Fixed coverage tmp path: `<reportsDirectory>/.tmp/` not `.coverage-v8/.tmp/` (Builder CRITICAL — factual verification against Vitest source)
  - Fixed filename pattern: `coverage-<N>.json` not `coverage-{pid}-{timestamp}.json` — PID matching invalid (Builder CRITICAL)
  - Fixed reporter registration: push to `vitest.reporters` (runtime array), not `vitest.config.reporters` (config tuples) (Builder HIGH + Breaker CRITICAL = 2/3)
  - Added sync I/O + ENOENT guards for coverage file race (Builder HIGH + Breaker HIGH = 2/3)
  - Added v1→v2 cache migration path (Builder MEDIUM — correctness)
  - Deferred path compression — relative paths are ~200KB, integer indices premature (Trimmer HIGH — simplification)
  - Removed 24h staleness TTL — mtime invalidation sufficient (Trimmer HIGH — simplification)
  - Inlined `buildWorkerTestMap` into `readCoverageEdges` — single pass per file (Trimmer MEDIUM)
  - Moved auto-enable coverage to Vite `config` hook — must run before `initCoverageProvider` (Builder HIGH)
  - Added URL normalization for `/@fs/` and query params (Breaker HIGH — noted in architecture)
  - Changed `reporter: []` to `reporter: ['json']` to avoid breaking V8 provider (Breaker HIGH — noted)
- **Noted (1/3, not auto-applied):** Separate reporter file if `vitest.reporters` is overwritten (Breaker CRITICAL-1 fallback). One-run-behind semantics documented (Breaker HIGH-3).
- **Trajectory:** No Critical issues remain. Implementation steps reduced from 6 to 4. Plan converging.
