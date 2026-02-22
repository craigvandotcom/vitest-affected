# Phase 3: Coverage-Enhanced Selection

**Depends on:** Phase 2 (Watch Mode + Caching)
**Effort:** Weeks
**Accuracy:** ~95% (up from Phase 1's static-only analysis)
**New files:** `src/coverage/collector.ts`, `src/coverage/mapper.ts`, `src/coverage/merge.ts`
**New deps:** None (uses Node.js built-in `node:inspector/promises`)

---

## Goal

Augment the static import graph with runtime coverage data. After test runs, record which source files each test file actually executes at runtime. Merge this coverage map with the static graph to catch dependencies invisible to static analysis: dynamic imports, `require()`, `vi.mock()` factory helpers, config-driven dependencies, and runtime-only code paths.

---

## Why Coverage Data Matters

Phase 1's static graph misses:

| Invisible dependency | Why static analysis misses it | Coverage catches it |
|---|---|---|
| `import(variable)` | Computed specifier — can't resolve statically | Runtime execution reveals actual path |
| `require('./config')[env]` | Dynamic property access | Execution traces the actual file |
| `vi.mock('./foo', () => import('./bar'))` | Mock factory imports are opaque | Factory executes, bar.ts appears in coverage |
| `fs.readFileSync('./data.json')` | Not an import statement | File access appears in V8 coverage |
| Shared global state via `globalThis` | No import edge exists | Both files execute in coverage |

**Safety invariant preserved:** Coverage data only ADDS to the static graph (union). If coverage misses something, static analysis still catches it. False negatives can only decrease, never increase.

---

## How V8 Coverage Works in Vitest

### Coverage Pipeline

```
Vitest Worker Process
  → V8 Inspector: Profiler.startPreciseCoverage({ callCount: true, detailed: true })
  → Test file executes (imports/requires resolved, code runs)
  → V8 Inspector: Profiler.takePreciseCoverage()
  → ScriptCoverage[] returned (one per loaded script)
  → Vitest writes coverage-{pid}-{N}.json to .coverage-v8/.tmp/
  → Vitest's coverage provider merges and reports
```

### ScriptCoverage Type

```typescript
// From V8 Inspector protocol (CDP)
interface ScriptCoverage {
  scriptId: string;
  url: string;          // file:///abs/path/to/source.ts  ← the key field
  functions: FunctionCoverage[];
}

interface FunctionCoverage {
  functionName: string;
  ranges: CoverageRange[];
  isBlockCoverage: boolean;
}

interface CoverageRange {
  startOffset: number;
  endOffset: number;
  count: number;        // Execution count — 0 means uncovered
}
```

**Key insight:** `ScriptCoverage.url` tells us which files a test actually loaded at runtime. We don't need the detailed function/range data for test selection — just the file-level mapping: "test A loaded files [X, Y, Z]".

### Per-Test-File Granularity

V8 coverage is collected per **worker process**, not per test file. To get per-test-file mappings:

**Option A: `isolate: true` (recommended for accuracy)**

With `pool: 'forks'` and `isolate: true`, each test file runs in its own forked process. The coverage data for that process maps directly to that test file.

```typescript
// vitest.config.ts — required for per-test-file coverage mapping
export default defineConfig({
  test: {
    pool: 'forks',
    poolOptions: {
      forks: {
        isolate: true,  // default is true for forks
      },
    },
  },
  plugins: [vitestAffected()],
})
```

**Option B: `isolate: false` (degraded accuracy)**

Multiple test files share a worker. Coverage data is aggregated — we can only say "these tests collectively loaded these files". Less precise but still useful as a union over the static graph.

### Intercepting Coverage Data

Vitest writes per-worker coverage files to `.coverage-v8/.tmp/coverage-{pid}-{timestamp}.json` before cleanup. We can intercept this data via two approaches:

**Approach 1: Custom Coverage Provider (preferred)**

```typescript
// Vitest allows custom coverage providers via the coverage.provider config
// We can wrap the v8 provider to intercept per-file data

import type { CoverageProvider, AfterSuiteRunMeta } from 'vitest/coverage';

export class AffectedCoverageProvider implements CoverageProvider {
  name = 'vitest-affected-v8';

  // Called after each worker/suite finishes
  onAfterSuiteRun(meta: AfterSuiteRunMeta): void {
    // meta.coverage contains the raw V8 coverage for this worker
    // meta.projectName identifies which project (for workspaces)
    // meta.transformMode is 'ssr' or 'web'

    // Extract file-level mapping
    const loadedFiles = meta.coverage
      .filter((sc: ScriptCoverage) => sc.url.startsWith('file://'))
      .map((sc: ScriptCoverage) => fileURLToPath(sc.url))
      .filter((f: string) => !f.includes('node_modules'));

    // Store the mapping: testFile → loadedFiles
    this.recordMapping(meta.testFile, loadedFiles);
  }
}
```

**Approach 2: Reporter Hook (simpler, less granular)**

```typescript
import type { Reporter, TestModule } from 'vitest/reporters';

export class CoverageCollector implements Reporter {
  // onCoverage is called with the merged coverage data
  // Less granular than provider approach — all tests merged
  onCoverage(coverage: unknown): void {
    // Process merged coverage data
  }
}
```

**We use Approach 1** — the coverage provider gives us per-worker data before Vitest merges it, which is exactly what we need for per-test-file mapping.

---

## Architecture

### New file: `src/coverage/collector.ts`

Collects per-test-file coverage mappings during test execution:

```typescript
// collector.ts — records which source files each test file loads at runtime
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export interface CoverageMapping {
  testFile: string;                    // absolute path to test file
  loadedFiles: string[];               // absolute paths of source files loaded at runtime
  collectedAt: number;                 // timestamp
}

export class CoverageCollector {
  private mappings: Map<string, CoverageMapping> = new Map();
  private rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  // Called per-worker with raw V8 ScriptCoverage data
  recordCoverage(testFile: string, scriptCoverages: ScriptCoverage[]): void {
    const loadedFiles = scriptCoverages
      .filter(sc => {
        // Only file:// URLs (skip eval, wasm, etc.)
        if (!sc.url.startsWith('file://')) return false;
        const filePath = fileURLToPath(sc.url);
        // Only files under rootDir (skip node_modules, vitest internals)
        if (!filePath.startsWith(this.rootDir)) return false;
        if (filePath.includes('node_modules')) return false;
        return true;
      })
      .map(sc => fileURLToPath(sc.url));

    // Only record if file had non-zero coverage (actually executed)
    const executedFiles = loadedFiles.filter(f =>
      scriptCoverages.some(sc =>
        fileURLToPath(sc.url) === f &&
        sc.functions.some(fn => fn.ranges.some(r => r.count > 0))
      )
    );

    this.mappings.set(testFile, {
      testFile,
      loadedFiles: [...new Set(executedFiles)].sort(),
      collectedAt: Date.now(),
    });
  }

  getMappings(): Map<string, CoverageMapping> {
    return new Map(this.mappings);
  }
}
```

### New file: `src/coverage/mapper.ts`

Converts coverage mappings into a reverse dependency graph:

```typescript
// mapper.ts — converts coverage mappings to a reverse graph
export function buildCoverageReverseGraph(
  mappings: Map<string, CoverageMapping>
): Map<string, Set<string>> {
  // coverage reverse: source file → Set<test files that loaded it>
  const reverse = new Map<string, Set<string>>();

  for (const [testFile, mapping] of mappings) {
    for (const sourceFile of mapping.loadedFiles) {
      if (!reverse.has(sourceFile)) {
        reverse.set(sourceFile, new Set());
      }
      reverse.get(sourceFile)!.add(testFile);
    }
  }

  return reverse;
}
```

### New file: `src/coverage/merge.ts`

Merges the static graph with coverage graph:

```typescript
// merge.ts — additive merge: static_graph ∪ coverage_graph
export function mergeReverseGraphs(
  staticReverse: Map<string, Set<string>>,
  coverageReverse: Map<string, Set<string>>
): Map<string, Set<string>> {
  // Union merge: for each source file, the set of test files is the union
  // of static analysis dependents AND coverage-observed dependents
  const merged = new Map<string, Set<string>>();

  // Copy all static entries
  for (const [file, deps] of staticReverse) {
    merged.set(file, new Set(deps));
  }

  // Add coverage entries (union)
  for (const [file, deps] of coverageReverse) {
    if (!merged.has(file)) {
      merged.set(file, new Set(deps));
    } else {
      for (const dep of deps) {
        merged.get(file)!.add(dep);
      }
    }
  }

  return merged;
}
```

**Critical design decision:** Coverage graph is additive — it can only ADD edges to the static graph, never remove them. This preserves the safety invariant: if static analysis says "test A depends on source B", that edge is kept even if coverage didn't observe it (the coverage run may not have exercised that code path).

---

## Coverage Map Storage

### File format: `.vitest-affected/coverage-map.json`

```json
{
  "version": 1,
  "collectedAt": 1708000000000,
  "isolateMode": true,
  "mappings": {
    "/abs/path/__tests__/food.test.tsx": {
      "loadedFiles": [
        "/abs/path/src/utils/food.ts",
        "/abs/path/src/types.ts",
        "/abs/path/src/config.ts"
      ],
      "collectedAt": 1708000000000
    }
  }
}
```

**Size estimate:** ~125KB for 50 test files × 50 source files per test (stripped JSON, absolute paths). Acceptable for disk persistence.

### Invalidation

Coverage mappings are invalidated when:
1. **Source file content changes** (hash mismatch) — re-run the test to collect new coverage
2. **Test file content changes** — re-run the test to collect new coverage
3. **Test file deleted** — remove mapping
4. **Source file deleted** — remove from all mappings

Between coverage collections, the stale mapping is still used — it's better than no mapping. The next test run refreshes it.

```typescript
export function invalidateStaleMappings(
  mappings: Map<string, CoverageMapping>,
  currentHashes: Map<string, string>,
  previousHashes: Map<string, string>
): { valid: Map<string, CoverageMapping>; stale: string[] } {
  const valid = new Map<string, CoverageMapping>();
  const stale: string[] = [];

  for (const [testFile, mapping] of mappings) {
    // Test file itself changed — mapping is stale
    if (currentHashes.get(testFile) !== previousHashes.get(testFile)) {
      stale.push(testFile);
      continue;
    }

    // Any loaded source file changed — mapping is stale
    const anySourceChanged = mapping.loadedFiles.some(f =>
      currentHashes.get(f) !== previousHashes.get(f)
    );

    if (anySourceChanged) {
      stale.push(testFile);
      continue;
    }

    valid.set(testFile, mapping);
  }

  return { valid, stale };
}
```

---

## Plugin Integration

### Modified `plugin.ts`

```typescript
export function vitestAffected(options: VitestAffectedOptions = {}): Plugin {
  let snapshot: GraphSnapshot | null = null;
  let coverageMap: Map<string, CoverageMapping> | null = null;

  return {
    name: 'vitest:affected',

    async configureVitest({ vitest, project }) {
      // ... Phase 1+2 setup ...

      const rootDir = vitest.config.root;
      const cacheDir = path.join(rootDir, '.vitest-affected');

      // Load cached coverage map
      coverageMap = await loadCoverageMap(cacheDir);

      // Build merged reverse graph
      const staticReverse = snapshot!.reverse;
      const coverageReverse = coverageMap
        ? buildCoverageReverseGraph(coverageMap)
        : new Map();
      const mergedReverse = mergeReverseGraphs(staticReverse, coverageReverse);

      // BFS uses merged graph instead of static-only
      const affectedTests = bfsAffectedTests(changed, mergedReverse, isTestFile);

      // ... rest of Phase 1 logic (threshold, validation, config.include mutation) ...

      // Register coverage collection for this run
      // After tests complete, save new coverage mappings
      const collector = new CoverageCollector(rootDir);

      // Hook into test completion to collect coverage
      // Option 1: via custom reporter
      const coverageReporter: Reporter = {
        onTestModuleEnd(module: TestModule) {
          // Collect coverage data for this test module
          // This requires coverage to be enabled
          if (module.coverageData) {
            collector.recordCoverage(module.moduleId, module.coverageData);
          }
        },

        async onTestRunEnd() {
          // Save updated coverage map
          const newMappings = collector.getMappings();
          // Merge with existing (keep old mappings for tests that didn't run)
          const merged = mergeCoverageMaps(coverageMap ?? new Map(), newMappings);
          await saveCoverageMap(cacheDir, merged);
        }
      };

      // Add our reporter
      vitest.config.reporters = [...(vitest.config.reporters ?? []), coverageReporter];
    }
  };
}
```

### Enabling V8 Coverage Collection

For Phase 3 to work, V8 coverage must be enabled. The plugin can auto-configure this:

```typescript
// In configureVitest, enable coverage if Phase 3 is active
if (options.coverage !== false) {
  // Ensure V8 coverage provider is active
  vitest.config.coverage = {
    ...vitest.config.coverage,
    enabled: true,
    provider: 'v8',
    // We don't need the full coverage report — just the raw data
    // Minimal config to reduce overhead
    reporter: [],  // No coverage reports needed
    all: false,    // Only instrument executed files
  };
}
```

**Performance note:** V8 coverage with `detailed: true` adds ~5-15% overhead per test. For CI this is acceptable. For local development, users can disable coverage collection:

```typescript
vitestAffected({ coverage: false })  // Use static graph only
```

---

## Options Added in Phase 3

```typescript
export interface VitestAffectedOptions {
  // Phase 1 options
  disabled?: boolean;
  ref?: string;
  verbose?: boolean;
  threshold?: number;

  // Phase 2 options
  verify?: boolean;
  cache?: boolean;
  cacheDir?: string;

  // Phase 3 additions
  coverage?: boolean;       // Collect V8 coverage for enhanced selection (default: true)
  coverageIsolate?: boolean; // Require isolate:true for per-test mapping (default: true)
}
```

---

## Implementation Steps

### Step 1: `coverage/collector.ts`

Implement CoverageCollector class. Parse V8 ScriptCoverage data, extract file-level mappings, filter to rootDir files only.

### Step 2: `coverage/mapper.ts`

Convert collected mappings to reverse graph format. Simple iteration: for each test's loaded files, add a reverse edge.

### Step 3: `coverage/merge.ts`

Implement additive merge of static and coverage reverse graphs. Unit test with known graphs to verify union semantics.

### Step 4: Coverage map persistence

Serialize/deserialize coverage-map.json. Implement invalidation logic (hash-based). Add to .vitest-affected/ cache directory.

### Step 5: Integrate collector into plugin

Hook into Vitest's test lifecycle to collect coverage after each test module. Auto-configure V8 coverage provider. Save coverage map on test run completion.

### Step 6: Merge graphs in BFS path

Replace `snapshot.reverse` with `mergedReverse` in the BFS call. The rest of the plugin logic (threshold, validation, config.include mutation) stays unchanged.

### Step 7: Handle `isolate: false` gracefully

If isolate is false, coverage data is per-worker (multiple tests). Fall back to "all tests in worker loaded all files" — less precise but still correct (over-selects, never under-selects).

### Step 8: Tests

- Coverage collector: mock ScriptCoverage data, verify file extraction
- Mapper: known mappings → expected reverse graph
- Merge: static + coverage → union graph (verify no edges lost)
- Invalidation: hash changes → correct stale detection
- Integration: fixture project with dynamic imports, verify coverage catches them
- Performance: coverage overhead measurement on body-compass-app

---

## Merge Algorithm: Why Additive

```
merged_graph = static_graph ∪ coverage_graph
```

**Coverage adds edges the static graph missed:**
- `src/config.ts` loaded by `auth.test.tsx` via `require()` → coverage adds edge
- `src/helpers/mock-data.ts` loaded by `food.test.tsx` via `vi.mock()` factory → coverage adds edge

**Static graph keeps edges coverage missed:**
- `src/types.ts` imported by `food.ts` but never executed in test → static keeps edge
- `src/utils/format.ts` imported but behind an `if` branch not taken → static keeps edge

**Result:** The merged graph has strictly more edges than either graph alone. This means:
- More tests may be selected (over-selection possible)
- Fewer tests will be missed (under-selection reduced)
- Safety invariant strengthened

---

## Similar Tools' Approaches

| Tool | Coverage strategy | Granularity | Storage |
|---|---|---|---|
| pytest-testmon | `sys.settrace()` per test | Per-test function | `.testmondata` SQLite |
| Datadog TIA | dd-trace V8 profiler | Per-test suite | Cloud (Datadog) |
| Wallaby.js | V8 + custom instrumentation | Per-expression | In-memory + project cache |
| **vitest-affected** | V8 via `node:inspector` | Per-test file | `.vitest-affected/coverage-map.json` |

Our approach is closest to Datadog TIA but local-only and open-source.

---

## Known Limitations (Phase 3)

- **Coverage overhead:** ~5-15% per test with V8 detailed coverage. Acceptable for CI, configurable for local dev.
- **`isolate: false` degradation:** Without process isolation, coverage is per-worker, not per-test-file. Falls back to union mapping (over-selects).
- **First-run cold start:** No coverage data exists on first run. First run uses static graph only. Coverage map builds up over subsequent runs.
- **Stale coverage data:** Between collections, coverage mappings may be outdated. Invalidation catches source/test file changes but not transitive dependency changes. Full coverage refresh recommended periodically (e.g., weekly in CI).
- **Dynamic `require()` with variables:** If the required path is fully computed at runtime (not a string literal), even coverage may miss it if the code path isn't exercised. This is a theoretical edge case — in practice, V8 coverage captures all loaded scripts regardless of how they were loaded.
- **Vitest's coverage provider conflict:** If the user has their own coverage configuration, our auto-configuration may conflict. Need to detect and merge gracefully.
