# vitest-affected: Complete Implementation Plan

An open-source Vitest plugin that maintains a persistent dependency graph and uses it to run only the tests affected by your changes. Zero config — add the plugin and go.

**GitHub:** https://github.com/craigvandotcom/vitest-affected
**npm:** `vitest-affected` (unclaimed, verified)

---

## Safety Invariant

vitest-affected must NEVER silently skip tests. If any component fails (graph build, git diff, BFS), the fallback is to run the full test suite and log a warning. False positives (running too many tests) are acceptable; false negatives (missing failures) are not.

---

## Architecture Overview

```
vitest-affected/
├── src/
│   ├── plugin.ts            # Vitest configureVitest + Vite config hooks
│   ├── index.ts             # Public API: exports only vitestAffected()
│   ├── graph/
│   │   ├── builder.ts       # oxc-parser + oxc-resolver → forward + reverse graph
│   │   └── cache.ts         # (Phase 2) Graph persistence + mtime invalidation
│   ├── git.ts               # Git diff integration
│   ├── selector.ts          # Pure BFS: (changedFiles, reverse, isTestFile) → affected tests
│   └── coverage.ts          # (Phase 3) V8 coverage edge extraction + merge
├── test/
│   ├── fixtures/            # Sample projects with known dependency structures
│   │   ├── simple/          # Linear A→B→C chain
│   │   ├── diamond/         # Diamond dependency
│   │   └── circular/        # Circular import handling
│   └── *.test.ts
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── vitest.config.ts
```

### Core Algorithm

1. **Parse** — Extract all import/export specifiers using `oxc-parser`
2. **Resolve** — Turn specifiers into absolute file paths using `oxc-resolver`
3. **Build forward graph** — `file → [files it imports]`
4. **Invert** — `file → [files that import it]` (reverse adjacency list)
5. **Query** — Given `git diff` changed files, BFS the reverse graph → affected test files
6. **Cache** (Phase 2) — Persist graph with mtime invalidation
7. **Coverage** (Phase 3) — Merge V8 runtime coverage with static graph

### Core Dependencies

| Package | Purpose | Why |
|---|---|---|
| `oxc-parser` | Parse imports from TS/JS/TSX/JSX | 8x faster than esbuild, pre-extracted imports |
| `oxc-resolver` | Resolve specifiers to file paths | 28x faster than enhanced-resolve, handles TS aliases |
| `picomatch` | Glob matching for force-rerun triggers | Lightweight, zero-dep |
| `tinyglobby` | File globbing with absolute paths | Fast, minimal |

```json
{
  "dependencies": {
    "oxc-parser": "^0.114.0",
    "oxc-resolver": "^6.0.0",
    "picomatch": "^4.0.2",
    "tinyglobby": "^0.2.10"
  },
  "peerDependencies": {
    "vitest": ">=3.1.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "tsup": "^8.5.0",
    "vitest": "^3.2.0"
  }
}
```

### User Experience

```typescript
// vitest.config.ts — this is ALL the user needs
import { defineConfig } from 'vitest/config'
import { vitestAffected } from 'vitest-affected'

export default defineConfig({
  plugins: [vitestAffected()],
})
```

### Options Interface (cumulative across phases)

```typescript
export interface VitestAffectedOptions {
  disabled?: boolean;      // Phase 1: skip plugin entirely
  ref?: string;            // Phase 1: git ref to diff against
  verbose?: boolean;       // Phase 1: log graph build time, changed files, affected tests
  threshold?: number;      // Phase 1: run full suite if affected ratio > threshold (0-1, default 0.5)
  cache?: boolean;         // Phase 2: persist graph (default: true)
  coverage?: boolean;      // Phase 3: use V8 coverage for enhanced selection (default: true)
}
```

---

# Phase 1: Static Import Graph (MVP)

**Effort:** ~500-1000 lines
**Accuracy:** Covers all static import-chain dependencies
**Mode:** One-shot only (`vitest run`)

---

## Goal

Ship a working Vitest plugin that pre-filters test files using static import analysis. Zero config for users — just add the plugin to `vitest.config.ts` and run `npx vitest run`.

---

## Implementation Steps (test-first order)

### Step 0: Project Scaffolding + Stub Cleanup

The existing code stubs are from pre-refinement and contradict the plan. Before feature work:

- **Delete:** `src/graph/cache.ts` (caching deferred to Phase 2)
- **Delete:** `src/graph/inverter.ts` (inlined into builder.ts)
- **Rewrite:** `src/graph/builder.ts` → export `buildFullGraph(rootDir)` returning `{ forward, reverse }` (see Step 2 for full spec). Delete `DependencyGraph` interface.
- **Rewrite:** `src/selector.ts` → pure `bfsAffectedTests` function (remove `SelectionResult`, `getAffectedTests`)
- **Rewrite:** `src/index.ts` → single export `vitestAffected` (do this EARLY — current exports reference symbols that will be renamed/deleted in later steps, causing build failures if deferred)
- **Rewrite:** `src/plugin.ts` → remove `verify` option and `onFilterWatchedSpecification` references; orchestration (build → BFS) lives here. Destructure `{ vitest, project }` (not just `vitest`) — `project.globTestSpecifications()` is needed.
- **Rewrite:** `src/git.ts` → return `{ changed: string[]; deleted: string[] }` (not flat `string[]`). Stub comments say `ACMR` — plan requires `ACMRD` (includes deletions). Follow the pseudocode, not stub comments.
- **Update:** `package.json` → peer dep `>=3.1.0`, remove `xxhash-wasm`, add `picomatch` to deps, add `tsup` to devDeps, update build script to `tsup`
- **Create:** root `vitest.config.ts` and `tsup.config.ts` — tsup config: `{ entry: ['src/index.ts'], format: ['esm', 'cjs'], dts: true, clean: true }`

### Step 1: Fixture Tests

Create small projects with known dependency structures FIRST. These define the contract.

Fixtures:
- `simple/` — Linear A→B→C chain
- `diamond/` — A→B→C, A→D→C (diamond dependency)
- `circular/` — A→B→A (circular import handling)

Write failing tests that assert expected graph shapes and affected test sets.

### Step 2: `graph/builder.ts`

Exports `buildFullGraph(rootDir)` returning `{ forward: Map<string, Set<string>>, reverse: Map<string, Set<string>> }`.

The `invertGraph` function is internal to this file (inlined from the former `inverter.ts`).

**Glob:** All code files (including test files) using `**/*.{ts,tsx,js,jsx,mts,mjs,cts,cjs}` (exclude `node_modules/`, `dist/`, `.vitest-affected/`, `test/fixtures/`, `coverage/`, `.next/`). The glob MUST return absolute paths (`tinyglobby` with `absolute: true`).

**Parse each file** with `oxc-parser`, resolve specifiers with `oxc-resolver`, build forward graph `Map<string, Set<string>>`.

**Non-source file handling:** When a parsed file imports a non-source file (e.g., `import data from './data.json'`), the resolved path is added as a forward-graph key with an empty dependency set — this ensures the inverter creates a reverse edge so BFS can trace dependents of that `.json`/`.css` file.

**Skip `node_modules` paths** returned by the resolver — only include files under `rootDir`. Use `tinyglobby` for globbing.

**Parse error handling:** If `oxc-parser` returns errors for a file, log a warning and add the file to the graph with an empty dependency set (graceful degradation). Do not crash the graph build for a single malformed file.

**tsconfig discovery:** Search for `tsconfig.json` starting from `rootDir`. If not found, create the resolver without tsconfig config (path aliases will fail, but basic resolution works). Log a warning if tsconfig is missing.

**Phase 2 exports required:** `parseImports(file, source, rootDir, resolver)` — extract single-file parse+resolve from the `buildFullGraph` loop. Also export `createResolver(rootDir)` so both `buildFullGraph` and `updateGraphForFiles` share the same resolver instance.

### Step 3: Orchestration in `plugin.ts`

Build graph (which includes inversion) → BFS is 2 lines of glue, inlined in the plugin's `configureVitest` hook. No separate orchestrator file in Phase 1. Extract to `graph/loader.ts` when Phase 2 caching materializes.

### Step 4: `git.ts`

Get changed files from git (3 commands: committed, staged, unstaged). Filter deleted files by existence check.

### Step 5: `selector.ts`

Pure BFS function with no IO or orchestration:

```typescript
export function bfsAffectedTests(
  changedFiles: string[],
  reverse: Map<string, Set<string>>,
  isTestFile: (path: string) => boolean
): string[] {
  const visited = new Set<string>();
  const queue = [...changedFiles];
  let i = 0;
  const affectedTests: string[] = [];

  while (i < queue.length) {
    const file = queue[i++]!;
    if (visited.has(file)) continue;
    visited.add(file);
    if (isTestFile(file)) affectedTests.push(file);
    const dependents = reverse.get(file);
    if (dependents) {
      for (const dep of dependents) {
        if (!visited.has(dep)) queue.push(dep);
      }
    }
  }

  return affectedTests.sort();
}
```

### Step 6: `plugin.ts`

Wire everything together in `configureVitest` hook. One-shot mode only in Phase 1: mutate `config.include` with affected test paths. Includes workspace guard and force-rerun check for config files. Graceful fallback: on error, don't modify config (runs full suite).

### Step 7: `index.ts`

Export only the plugin function: `export { vitestAffected } from './plugin'`. Internal functions stay unexported — no public API surface to maintain until there are real consumers.

---

## Plugin Pseudocode

```typescript
/// <reference types="vitest/config" />
import type { Plugin } from 'vite';

const FORCE_RERUN_FILES = [
  'vitest.config.ts', 'vitest.config.js', 'vitest.config.mts',
  'tsconfig.json', 'package.json',
];

export function vitestAffected(options: VitestAffectedOptions = {}): Plugin {
  return {
    name: 'vitest:affected',

    async configureVitest({ vitest, project }) {
      if (options.disabled) return;

      // Guard: watch mode not supported in Phase 1
      if (vitest.config.watch) {
        console.warn('[vitest-affected] Watch mode not supported in Phase 1 — running full suite');
        return;
      }

      // Guard: workspace mode not supported in Phase 1
      if (vitest.projects && vitest.projects.length > 1) {
        console.warn('[vitest-affected] Vitest workspaces not yet supported — running full suite');
        return;
      }

      try {
        if (!vitest.config || !Array.isArray(vitest.config.include) || typeof vitest.config.root !== 'string') {
          console.warn('[vitest-affected] Unexpected Vitest config shape — running full suite');
          return;
        }

        const rootDir = vitest.config.root;
        const verbose = options.verbose ?? false;

        const t0 = performance.now();
        const { forward, reverse } = await buildFullGraph(rootDir);
        if (verbose) console.log(`[vitest-affected] Graph: ${forward.size} files in ${(performance.now() - t0).toFixed(1)}ms`);

        const { changed, deleted } = await getChangedFiles(rootDir, options.ref);

        if (changed.length === 0 && deleted.length === 0) {
          if (verbose) console.log('[vitest-affected] No git changes detected — running full suite');
          return;
        }

        const SOURCE_EXT = /\.(ts|tsx|js|jsx|mts|mjs|cts|cjs)$/;
        const deletedSourceFiles = deleted.filter(f => SOURCE_EXT.test(f));
        if (deletedSourceFiles.length > 0) {
          if (verbose) console.warn(`[vitest-affected] ${deletedSourceFiles.length} source file(s) deleted — running full suite`);
          else console.warn('[vitest-affected] Deleted source file(s) detected — running full suite');
          return;
        }

        // Force full run if config/infra/setup files changed
        const setupFiles = [vitest.config.setupFiles, vitest.config.globalSetup]
          .flat().filter(Boolean) as string[];
        const allTriggers = [...FORCE_RERUN_FILES, ...setupFiles, ...(vitest.config.forceRerunTriggers ?? [])];
        const localChanged = changed.filter(f => f.startsWith(rootDir + path.sep) || f === rootDir);
        const hasForceRerun = localChanged.some(f => {
          const relPath = path.relative(rootDir, f);
          return allTriggers.some(trigger =>
            (!trigger.includes('/') && !trigger.includes('*'))
              ? path.basename(f) === trigger
              : picomatch.isMatch(relPath, trigger, { dot: true })
          );
        });
        if (hasForceRerun) {
          console.log('[vitest-affected] Config file changed — running full suite');
          return;
        }

        const specs = await project.globTestSpecifications();
        const testFileSet = new Set(specs.map(s => s.moduleId));
        const isTestFile = (f: string) => testFileSet.has(f);
        const affectedTests = bfsAffectedTests(changed, reverse, isTestFile);

        const ratio = testFileSet.size > 0 ? affectedTests.length / testFileSet.size : 0;
        if (ratio > (options.threshold ?? 0.5)) {
          if (verbose) console.log(`[vitest-affected] ${(ratio * 100).toFixed(0)}% of tests affected — running full suite`);
          return;
        }

        if (verbose) {
          for (const f of changed) {
            if (!forward.has(f) && SOURCE_EXT.test(f)) {
              console.warn(`[vitest-affected] Changed file not in graph (outside rootDir?): ${path.relative(rootDir, f)}`);
            }
          }
        }

        const { existsSync } = await import('node:fs');
        const validTests = affectedTests.filter(t => {
          if (existsSync(t)) return true;
          console.warn(`[vitest-affected] Affected test no longer on disk: ${path.relative(rootDir, t)}`);
          return false;
        });

        if (validTests.length > 0) {
          vitest.config.include = validTests;
          console.log(`[vitest-affected] ${validTests.length} affected tests`);
          if (verbose) validTests.forEach(t => console.log(`  → ${path.relative(rootDir, t)}`));
        } else {
          console.log('[vitest-affected] No affected tests — skipping all tests');
          vitest.config.include = [];
        }
      } catch (err) {
        console.warn('[vitest-affected] Error — running full suite:', err);
      }
    }
  };
}
```

---

## Verified API Patterns

### oxc-parser — Import Extraction

```typescript
import { parseSync } from 'oxc-parser';

const { module: mod, errors } = parseSync(filePath, sourceCode);
const specifiers: string[] = [];

const BINARY_ASSET_EXT = /\.(svg|png|jpg|jpeg|gif|webp|woff2?|eot|ttf|ico)$/i;

for (const imp of mod.staticImports) {
  if (imp.entries.length > 0 && imp.entries.every(e => e.isType)) continue;
  if (BINARY_ASSET_EXT.test(imp.moduleRequest.value)) continue;
  specifiers.push(imp.moduleRequest.value);
}

for (const imp of mod.dynamicImports) {
  const raw = sourceCode.slice(imp.moduleRequest.start, imp.moduleRequest.end);
  if (raw.startsWith("'") || raw.startsWith('"')) {
    specifiers.push(raw.slice(1, -1));
  }
}

for (const exp of mod.staticExports) {
  for (const entry of exp.entries) {
    if (entry.moduleRequest && !entry.isType) {
      specifiers.push(entry.moduleRequest.value);
    }
  }
}
```

### oxc-resolver — Path Resolution

```typescript
import { ResolverFactory } from 'oxc-resolver';

const resolver = new ResolverFactory({
  extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
  conditionNames: ['node', 'import'],
  tsconfig: { configFile: path.join(projectRoot, 'tsconfig.json'), references: 'auto' },
  builtinModules: true,
});

// CRITICAL: context is DIRECTORY, not file path
const result = resolver.sync(path.dirname(importingFile), specifier);
if (result.error) return null;
return result.path;
```

### Git Diff Integration

```typescript
async function getChangedFiles(rootDir: string, ref?: string): Promise<{ changed: string[]; deleted: string[] }> {
  if (ref) {
    const { stdout: isShallow } = await exec('git', ['rev-parse', '--is-shallow-repository'], { cwd: rootDir });
    if (isShallow.trim() === 'true') {
      throw new Error('[vitest-affected] Shallow clone. Set fetch-depth: 0 in CI.');
    }
  }

  const run = async (args: string[]) => {
    const { stdout } = await exec('git', args, { cwd: rootDir });
    return stdout.split('\n').filter(Boolean);
  };

  const [committed, staged, unstaged] = await Promise.all([
    ref ? run(['diff', '--name-only', '--diff-filter=ACMRD', `${ref}...HEAD`]) : [],
    run(['diff', '--cached', '--name-only', '--diff-filter=ACMRD']),
    run(['ls-files', '--others', '--modified', '--exclude-standard', '--full-name']),
  ]);

  const { stdout: gitRoot } = await exec('git', ['rev-parse', '--show-toplevel'], { cwd: rootDir });
  const allFiles = [...new Set([...committed, ...staged, ...unstaged])]
    .map(f => path.resolve(gitRoot.trim(), f));

  const { existsSync } = await import('node:fs');
  return {
    changed: allFiles.filter(f => existsSync(f)),
    deleted: allFiles.filter(f => !existsSync(f)),
  };
}
```

---

## Known Limitations (Phase 1)

- `fs.readFile` dependencies, shared global state, config file impacts, computed dynamic imports
- `vi.mock()` with factory functions: mock factories that import helpers create invisible dependencies
- **Watch mode:** Not supported. `configureVitest` runs once at startup — test set becomes stale. Deferred to Phase 2.
- **Vitest workspaces:** Not supported. Plugin detects workspace mode and falls back to full suite.
- **File renames:** Appear as deletion + addition, triggering conservative full-suite fallback.
- **Temporal mismatch:** Graph reflects current disk state, diff reflects historical changes. Rare false-negative vector eliminated by Phase 3 coverage data.
- **Nested tsconfigs:** Only root-level config filenames trigger full rerun.

---

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
- **Verify mode** — diagnostic for static-analysis misses, but the fix (coverage data) doesn't exist until Phase 3.
- **Rename detection** — Phase 1's full-suite fallback on renames is correct and safe.

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

interface GraphSnapshot {
  forward: Map<string, Set<string>>;
  reverse: Map<string, Set<string>>;
  fileMtimes: Map<string, number>;
  builtAt: number;
}

function loadOrBuildGraph(rootDir: string, verbose: boolean): Promise<GraphSnapshot>;

function updateGraphForFiles(
  snapshot: GraphSnapshot,
  changedFiles: string[],
  deletedFiles: string[],
  rootDir: string,
  resolver: ResolverFactory
): Promise<GraphSnapshot>;

function saveGraph(snapshot: GraphSnapshot): Promise<void>;
```

#### Invalidation: mtime-only

Check file mtime via `lstat`. If mtime changed, reparse. If unchanged, skip.

**Why not content hashing:** Adding xxhash-wasm to catch "touch without edit" — a scenario where the cost of a false reparse is ~0.5ms. Not worth the complexity.

#### Phase 1 Integration

`buildFullGraph(rootDir)` returns `{ forward, reverse }` without mtimes. `loadOrBuildGraph` wraps this: on cache miss, calls `buildFullGraph`, then stats all files to collect mtimes.

**Required Phase 1 export:** `parseImports(file, source, rootDir, resolver)` and `createResolver(rootDir)`.

### Implementation Steps (2a)

1. **Export `parseImports` and `createResolver` from `builder.ts`**
2. **Implement `cache.ts`** — `loadOrBuildGraph`, `updateGraphForFiles`, `saveGraph`. Atomic writes via write-then-rename.
3. **Update `plugin.ts`** — Replace `buildFullGraph(rootDir)` with `loadOrBuildGraph(rootDir, verbose)`.
4. **Tests** — Cache round-trip, incremental updates, corrupt cache recovery, mtime invalidation.

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
// On the Vitest instance (NOT TestProject)
// Called ONLY during watch-triggered reruns, NOT on initial run
// Multiple plugins: AND-ed (all must return true to keep a spec)
vitest.onFilterWatchedSpecification((spec: TestSpecification) => {
  return affectedTestSet.has(spec.moduleId);
});
```

### Architecture: Precomputed Affected Set

The filter callback must NOT compute BFS — it's called once per test spec. Instead:

1. **Watcher event fires** → enqueue handler
2. **Handler runs** → update graph incrementally, BFS once, store `currentAffectedSet`
3. **Vitest debounce expires** → calls filter per spec → `Set.has()` lookup

All watcher handlers are serialized through an async queue to prevent concurrent graph mutation.

### Unified Watcher Handler

```typescript
async function handleWatcherEvent(
  kind: 'change' | 'add' | 'unlink',
  absPath: string
): Promise<void> {
  if (!snapshot || !testFileSet) return;

  if (kind === 'unlink') {
    const dependents = snapshot.reverse.get(absPath);
    const seeds = dependents ? [...dependents] : [];
    snapshot = await updateGraphForFiles(snapshot, [], [absPath], rootDir, resolver);
    testFileSet.delete(absPath);
    pendingAffectedFiles.push(...seeds);
  } else {
    snapshot = await updateGraphForFiles(snapshot, [absPath], [], rootDir, resolver);
    if (kind === 'add') {
      const newSpecs = await project.globTestSpecifications();
      testFileSet = new Set(newSpecs.map(s => s.moduleId));
    }
    pendingAffectedFiles.push(absPath);
  }
}
```

### Event Coalescing

```typescript
let pendingAffectedFiles: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    const isTestFile = (f: string) => testFileSet!.has(f);
    const affected = bfsAffectedTests(pendingAffectedFiles, snapshot!.reverse, isTestFile);
    currentAffectedSet = new Set(affected);
    pendingAffectedFiles = [];
    await saveGraph(snapshot!, cacheDir);
  }, 50);  // 50ms coalesce window — well within Vitest's ~100ms debounce
}
```

### Plugin Structure (Watch Mode)

```typescript
async configureVitest({ vitest, project }) {
  // ... load graph ...

  if (vitest.config.watch) {
    vitest.onFilterWatchedSpecification((spec) => {
      if (!currentAffectedSet) return true;  // null = run everything (safe)
      return currentAffectedSet.has(spec.moduleId);
    });

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
  const { changed, deleted } = await getChangedFiles(rootDir, options.ref);
  // ... Phase 1 BFS, threshold, config.include mutation ...
}
```

### Implementation Steps (2b)

5. **Remove watch mode guard from `plugin.ts`** — Replace with `onFilterWatchedSpecification`.
6. **Add unified watcher handler** — Single `handleWatcherEvent(kind, absPath)` function.
7. **Add event coalescing** — Accumulate changed files, flush after 50ms.
8. **Serialize handlers via async queue** — `enqueue()` wrapper.
9. **Tests** — Mock watcher events + filter calls, concurrent handler serialization, rename event batching.

---

## Known Limitations (Phase 2)

- **`onFilterWatchedSpecification` AND semantics:** If another plugin registers a filter, results are AND-ed.
- **`vitest.server?.watcher` availability:** May be undefined in `browser` mode. Watch filtering silently disables.
- **`vitest.server` at `configureVitest` time:** May not be fully initialized. May need deferred registration.
- **Async handler / filter timing:** Single-file parse+save is ~5ms (within ~100ms debounce). Stale set reads cause over-runs (safe).
- **Event coalescing window:** 50ms. If Vitest debounce fires first, full suite runs (safe).
- **Mtime-only invalidation:** `touch` without edit causes unnecessary reparse (~0.5ms per file).
- **Watcher path format:** `path.resolve(rootDir, filePath)` handles both relative and absolute.
- **Cache version migration:** Unknown `version` triggers full rebuild.

---

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

**Not** a custom coverage provider. Vitest writes per-worker V8 coverage to `<reportsDirectory>/.tmp/coverage-<N>.json` when `coverage.enabled = true`. Default `reportsDirectory` is `./coverage`, so the standard path is `<root>/coverage/.tmp/`. Phase 3 reads these files after the test run completes.

### Why Not Custom Provider?

- `coverage.provider: 'custom'` replaces the entire V8/Istanbul pipeline — can't "wrap" it
- Requires a `customProviderModule` file path (separate disk file), not runtime registration
- Breaks users' existing `provider: 'v8'` or `provider: 'istanbul'` configs

### How It Works

1. User enables V8 coverage in their config (or we auto-enable via Vite `config` hook)
2. Vitest runs tests, collecting V8 coverage per worker as normal
3. Coverage files are written to `<reportsDirectory>/.tmp/`
4. After run completes, our reporter's `onTestRunEnd` reads these files (sync, for atomicity)
5. Extract file-level mappings: which source files each worker loaded
6. Union into the static graph and persist

### Coverage File Format

Each file is named `coverage-<N>.json` (auto-incrementing integer) and contains:

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

We only need `url` — which files were loaded.

**URL normalization:** Coverage URLs may be `file:///abs/path` or Vite-transformed (`/@fs/abs/path?v=hash`). Normalize by stripping query params and handling `/@fs/` prefix.

---

## Architecture: `src/coverage.ts`

```typescript
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function readCoverageEdges(
  coverageTmpDir: string,
  rootDir: string,
  testFileSet: Set<string>
): Map<string, Set<string>> {
  const reverse = new Map<string, Set<string>>();

  let files: string[];
  try { files = readdirSync(coverageTmpDir); }
  catch { return reverse; }

  for (const f of files) {
    if (!f.startsWith('coverage-') || !f.endsWith('.json')) continue;

    let raw: string;
    try { raw = readFileSync(path.join(coverageTmpDir, f), 'utf-8'); }
    catch { continue; } // ENOENT — file cleaned mid-read

    let parsed: any;
    try { parsed = JSON.parse(raw); }
    catch { continue; } // Malformed JSON — partial write
    const scriptCoverages = parsed.result ?? [];

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
        sourceFilesInWorker.push(filePath);
      }
    }

    for (const testFile of testFilesInWorker) {
      for (const sourceFile of sourceFilesInWorker) {
        if (!reverse.has(sourceFile)) reverse.set(sourceFile, new Set());
        reverse.get(sourceFile)!.add(testFile);
      }
    }
  }
  return reverse;
}

function normalizeUrl(url: string | undefined): string | null {
  if (!url) return null;
  const bare = url.split('?')[0];
  if (bare.startsWith('file://')) return fileURLToPath(bare);
  if (bare.includes('/@fs/')) return bare.slice(bare.indexOf('/@fs/') + 4);
  return null;
}

export function mergeIntoGraph(
  staticReverse: Map<string, Set<string>>,
  coverageReverse: Map<string, Set<string>>
): void {
  for (const [file, tests] of coverageReverse) {
    if (!staticReverse.has(file)) {
      staticReverse.set(file, new Set(tests));
    } else {
      for (const t of tests) staticReverse.get(file)!.add(t);
    }
  }
}
```

### Per-Worker Union

- **`isolate: true`:** 1 test file per worker → 1:1 mapping (precise)
- **`isolate: false`:** N test files per worker → N:M mapping (over-selects, safe)

---

## Persistence: Fold Into `graph.json`

Coverage edges stored in Phase 2's cache file:

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

**Simple relative paths.** ~200KB for 500 tests x 200 sources. Add compression if >1MB.

**Version bump:** `version: 1` (Phase 2) → `version: 2` (Phase 3).

**Version migration:** Reading v1 cache → treat as valid with empty coverage edges. Bump to v2 on next write.

### Invalidation

- **Test file content changes** (mtime mismatch) → stale, refreshed next run
- **Source file deleted** → remove from all coverage edges

---

## Plugin Integration

### Reporter Registration

**Verified against Vitest 3.2.4:** `configureVitest` hooks fire at line 9322, then `this.reporters = createReporters(...)` overwrites at line 9341. Must register reporter **after** initialization via `vitest.onAfterSetServer()`.

```typescript
// In plugin.ts — Phase 3 additions to configureVitest

const reportsDir = vitest.config.coverage?.reportsDirectory ?? 'coverage';
const coverageTmpDir = path.resolve(rootDir, reportsDir, '.tmp');

// Build testFileSet from ALL project test files (not just ran-this-run)
const specs = await project.globTestSpecifications();
const testFileSet = new Set(specs.map(s => s.moduleId));

// Merge cached coverage edges
const coverageEdges = snapshot.coverageEdges;
if (coverageEdges) {
  mergeIntoGraph(snapshot.reverse, coverageEdges);
}

// Register reporter AFTER reporters are initialized
vitest.onAfterSetServer(() => {
  vitest.reporters.push({
    onTestRunEnd(testModules: ReadonlyArray<TestModule>,
      unhandledErrors: ReadonlyArray<SerializedError>,
      reason: TestRunEndReason) {
      const newEdges = readCoverageEdges(coverageTmpDir, rootDir, testFileSet);
      mergeIntoGraph(snapshot.reverse, newEdges);
      saveGraph(snapshot, cacheDir);
    }
  });
});
```

### Auto-Enabling Coverage

Must happen in the **Vite `config` hook** (before Vitest's `initCoverageProvider()`):

```typescript
config(config) {
  if (options.coverage === false) return;
  const test = config.test ?? {};
  const cov = test.coverage ?? {};
  if (cov.enabled === undefined) {
    test.coverage = {
      ...cov,
      enabled: true,
      provider: 'v8',
      reporter: ['json'],  // Minimal — needed for provider to function
      all: false,
    };
    config.test = test;
  }
}
```

### Implementation Steps

1. **Implement `coverage.ts`** — `readCoverageEdges`, `mergeIntoGraph`, `normalizeUrl`. Sync I/O.
2. **Update cache format** — Bump version to 2. Add `coverageEdges` + `coverageCollectedAt`. Handle v1→v2 migration.
3. **Update `plugin.ts`** — Auto-enable coverage in Vite `config` hook. Register reporter via `onAfterSetServer`. Build `testFileSet` from `globTestSpecifications()`. Merge cached edges.
4. **Tests** — Coverage file parsing, URL normalization, edge extraction, merge correctness, v1→v2 migration.

---

## Known Limitations (Phase 3)

- **Coverage must be enabled:** Falls back to static-only if user disables.
- **First-run cold start:** No coverage data on first run. Static graph only.
- **Coverage edges are one run behind:** Run N data benefits run N+1.
- **Coverage file race:** `onTestRunEnd` fires between `generateCoverage()` and `reportCoverage()`. Sync I/O + ENOENT guards handle this.
- **URL normalization:** Unknown URL schemes silently skipped. Add verbose logging.
- **`transformMode` assumption:** SSR + web modes treated uniformly (union). May over-select.
- **Per-worker union with `isolate: false`:** Over-selects but never under-selects.
- **Auto-enable lifecycle:** If Vitest changes when coverage config is consumed, auto-enable may break. Users can always set `coverage.enabled: true` explicitly.
- **Shard mode:** `vitest --shard=N/M` changes tmp dir to `.tmp-N-M`. Read `vitest.config.shard` at impl time.
- **Version downgrade:** Phase 2 code reading v2 cache triggers full rebuild (safe).
- **`TestModule.moduleId`:** May be virtual — silently excluded from coverage (safe).
- **Coverage reporter output:** Verify whether `reporter: []` works; prefer it over `['json']` if so.

---

## Merge Algorithm

```
merged_graph = static_graph ∪ coverage_graph
```

Coverage adds edges static missed. Static keeps edges coverage missed. Result: more tests selected (possible), fewer missed (reduced).

---

## Cross-Phase Dependencies

| Phase 1 produces | Phase 2 consumes |
|---|---|
| `buildFullGraph(rootDir)` → `{ forward, reverse }` | `loadOrBuildGraph` wraps this, adds mtime layer |
| `parseImports(file, source, rootDir, resolver)` | `updateGraphForFiles` calls this for incremental updates |
| `createResolver(rootDir)` | Shared resolver instance across graph ops |
| `bfsAffectedTests(changed, reverse, isTestFile)` | Reused in watch mode flush |

| Phase 2 produces | Phase 3 consumes |
|---|---|
| `GraphSnapshot` with `forward`, `reverse`, `fileMtimes`, `builtAt` | Extended with `coverageEdges?`, `coverageCollectedAt?` |
| `loadOrBuildGraph` / `saveGraph` | Handles v1→v2 migration, serializes coverage edges |
| `cache.ts` disk format (version 1) | Bumped to version 2 with coverage fields |
| `project.globTestSpecifications()` → `testFileSet` | Reused for coverage test-vs-source classification |
