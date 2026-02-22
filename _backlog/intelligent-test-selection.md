# vitest-affected: Intelligent Test Selection for Vitest

## Table of Contents

- [Vision](#vision)
- [The Problem](#the-problem)
- [How It Works](#how-it-works)
- [Safety Invariant](#safety-invariant)
- [Architecture](#architecture)
- [Core Dependencies](#core-dependencies)
- [User Experience](#user-experience)
- [Technical Decisions](#technical-decisions)
- [Phase 1: Static Import Graph (MVP)](#phase-1-static-import-graph-mvp)
- [Phase 2: Watch Mode + Caching](#phase-2-watch-mode--caching)
- [Phase 3: Coverage-Enhanced Selection](#phase-3-coverage-enhanced-selection)
- [Phase 4: Symbol-Level Tracking (Future)](#phase-4-symbol-level-tracking-future)
- [Phase 5: Predictive Selection (Aspirational)](#phase-5-predictive-selection-aspirational)
- [Cross-Phase Dependencies](#cross-phase-dependencies)
- [Market Validation & Prior Art](#market-validation--prior-art)
- [Refinement Log](#refinement-log)

---

## Vision

An open-source Vitest plugin that maintains a persistent dependency graph of your codebase and uses it to run only the tests affected by your changes. Like Wallaby.js accuracy, but open-source, zero-config, and CI-ready.

**Tagline:** "Run only the tests that matter."

**npm name:** `vitest-affected` (unclaimed, verified)
**GitHub:** https://github.com/craigvandotcom/vitest-affected

---

## The Problem

When you change `src/utils/food.ts`, you want to know which test files to run. Today's options:

| Tool | Limitation |
|---|---|
| `vitest --changed` | Uses runtime Vite module graph — forward-only traversal, no persistence, misses transitive deps |
| `vitest related <files>` | Manual — you have to tell it which files changed |
| Nx/Turborepo `affected` | Package-level, not file-level |
| Wallaby.js | Commercial, closed-source, IDE-coupled |
| Datadog TIA | SaaS, commercial, requires dd-trace |

**No open-source Vitest plugin for file-level intelligent test selection exists.**

### Why `vitest --changed` Falls Short (Verified)

1. **Runtime graph only** — Vite module graph doesn't exist before tests start. Can't pre-filter.
2. **No persistence** — Graph is in-memory per process. Every run starts from scratch.
3. **Forward-only traversal** — O(test_count x graph_depth). Reverse graph is O(changed_files x graph_depth).
4. **Bug: misses changed test files** — If a test file itself is modified, `--changed` does NOT run it (vitest issue #1113).

### Why Not `vitest --changed`? (Speed Comparison)

Vitest's built-in `--changed` flag does follow transitive dependencies via Vite's module graph. The key differences are **speed** and **workflow**:

| | `vitest --changed` | `vitest-affected` |
|---|---|---|
| Graph source | On-demand Vite transforms (slow cold start) | Pre-built static analysis (fast, cacheable) |
| First run | Must transform every reachable module | oxc-parser is 8x faster, results cached |
| CI friendliness | No persistence between runs | Cached graph persists across runs |
| Dynamic deps | Catches all (runtime graph) | Static-only until Phase 3 coverage |

The primary value proposition is **speed**: a cached static graph resolves affected tests in milliseconds, vs Vite's on-demand module transformation which scales with project size. Phase 3 coverage data closes the accuracy gap for dynamic dependencies.

**Note:** `--changed` uses Vite's in-memory module graph cache when warm (watch mode). The speed advantage is largest on cold CI runs where Vite must transform on demand. Benchmark against `vitest --changed` on a real 500+ file project before launch to quantify the actual speedup.

---

## How It Works

### Core Algorithm

1. **Parse** — Extract all import/export specifiers using `oxc-parser`
2. **Resolve** — Turn specifiers into absolute file paths using `oxc-resolver`
3. **Build forward graph** — `file → [files it imports]`
4. **Invert** — `file → [files that import it]` (reverse adjacency list)
5. **Query** — Given `git diff` changed files, BFS the reverse graph → affected test files
6. **Cache** (Phase 2) — Persist graph with mtime invalidation
7. **Coverage** (Phase 3) — Merge V8 runtime coverage with static graph

### Example

```
src/utils/food.ts          (CHANGED)
  ← src/features/foods/hooks/use-foods.ts
    ← src/features/foods/components/food-list.tsx
      ← __tests__/features/foods/food-list.test.tsx    ← RUN THIS
    ← __tests__/features/foods/use-foods.test.tsx      ← RUN THIS
  ← __tests__/utils/food.test.tsx                      ← RUN THIS
```

Change 1 file → run 3 tests instead of 50.

---

## Safety Invariant

vitest-affected must NEVER silently skip tests. If any component fails (graph build, git diff, BFS), the fallback is to run the full test suite and log a warning. False positives (running too many tests) are acceptable; false negatives (missing failures) are not.

**Path correctness:** All file paths used as graph keys or for set membership must be absolute and consistently normalized. Paths come from 4 sources (tinyglobby globs, git diff output, oxc-resolver results, Vitest module IDs) and can differ in case, separators (`\` vs `/`), or symlink resolution. Use `path.resolve()` everywhere; on case-insensitive filesystems, consider `fs.realpathSync()` for cache keys. If normalization fails for any path, fall back to full suite.

---

## Architecture

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

> **EMPIRICALLY VERIFIED (2026-02-21):** Mutating `vitest.config.include` inside the `configureVitest` hook DOES filter which test files run. Tested on Vitest 3.2.4. This means vitest-affected is a standard Vitest plugin — no CLI wrapper needed.

---

## Core Dependencies

| Package | Purpose | Why |
|---|---|---|
| `oxc-parser` | Parse imports from TS/JS/TSX/JSX | 8x faster than esbuild, pre-extracted imports via `result.module` |
| `oxc-resolver` | Resolve specifiers to file paths | 28x faster than enhanced-resolve, handles TS aliases |
| `tinyglobby` | File globbing with absolute paths | Fast, minimal |

```json
{
  "dependencies": {
    "oxc-parser": "^0.114.0",
    "oxc-resolver": "^6.0.0",
    "tinyglobby": "^0.2.10"
  },
  "peerDependencies": {
    "vitest": ">=3.2.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "tsup": "^8.5.0",
    "vitest": "^3.2.0"
  }
}
```

Total install footprint: ~4 MB (oxc-parser ~2MB + oxc-resolver ~2MB + tinyglobby minimal)

**Benchmarked on body-compass-app (433 TS/TSX files):**

```
Phase      | Total    | Per file  | % of total
-----------|----------|-----------|----------
Read       |   14.9ms |   0.034ms | 9%
Hash       |    9.9ms |   0.023ms | 6%
Parse      |   99.7ms |   0.230ms | 60%
Resolve    |   41.2ms |   0.095ms | 25%
-----------|----------|-----------|----------
TOTAL      |  165.8ms |   0.383ms | 100%
```

---

## User Experience

```typescript
// vitest.config.ts — this is ALL the user needs
import { defineConfig } from 'vitest/config'
import { vitestAffected } from 'vitest-affected'

export default defineConfig({
  plugins: [vitestAffected()],
})
```

```bash
npx vitest run
# → [vitest-affected] 3 affected tests
```

### CI Usage

The plugin works without a cache (Phase 1 builds the graph from scratch each run). For best performance in CI, persist the cache directory:

```yaml
# GitHub Actions example
- uses: actions/cache@v4
  with:
    path: .vitest-affected/
    key: vitest-affected-${{ runner.os }}-${{ hashFiles('package-lock.json') }}
    restore-keys: vitest-affected-${{ runner.os }}-
```

Without cache restoration, Phase 1 still provides full benefit (graph build is fast — oxc-parser is ~8x faster than esbuild). Cache primarily helps Phase 2+ skip reparsing unchanged files.

**Important:** `fetch-depth: 0` is required when using `ref` option for cross-branch diffs. The plugin detects shallow clones and throws a clear error.

### Options Interface

Phase 1 options only. Phase 2 adds `cache?: boolean` (default: true). Phase 3 adds `coverage?: boolean` (default: false, opt-in).

```typescript
export interface VitestAffectedOptions {
  disabled?: boolean;      // Skip plugin entirely
  ref?: string;            // Git ref to diff against (e.g., 'main', 'HEAD~3')
  changedFiles?: string[]; // Bypass git diff — provide changed files directly (absolute or relative to rootDir)
  verbose?: boolean;       // Log graph build time, changed files, affected tests
  threshold?: number;      // Run full suite if affected ratio > threshold (0-1, default 1.0 = disabled)
  allowNoTests?: boolean;  // If true, allow selecting 0 tests (default: false — runs full suite instead)
}
```

---

## Technical Decisions

Every decision scored on **Confidence** (how sure we are this is right) and **Impact** (how much it matters if we get it wrong). Scale: 1-5.

### Decision Summary

| # | Decision | Choice | Confidence | Impact |
|---|---|---|---|---|
| 1 | Import Parser | oxc-parser | 5/5 | 5/5 |
| 2 | Module Resolver | oxc-resolver | 5/5 | 4/5 |
| 3 | Graph Storage | JSON (msgpackr upgrade path) | 5/5 | 2/5 |
| 4 | Cache Invalidation | mtime-only (xxHash dropped) | 5/5 | 3/5 |
| 5 | Git Diff Strategy | merge-base + untracked (two-mode) | 4/5 | 3/5 |
| 6 | Integration | Vitest Plugin via configureVitest (REVISED — empirically verified) | 5/5 | 5/5 |
| 7 | Build Tool | tsup (migrate to tsdown later) | 3/5 | 1/5 |
| 8 | Package Name | vitest-affected | 4/5 | 2/5 |
| 9 | CJS Support | ESM-only | 4/5 | 2/5 |
| 10 | Test Detection | Vitest's config patterns via tinyglobby | 5/5 | 3/5 |
| 11 | Monorepo | Single-project first | 4/5 | 2/5 |
| 12 | Dynamic Imports | Include resolvable, flag unresolvable | 4/5 | 3/5 |

### Decision 1: Import Parser — `oxc-parser`

**Confidence: 5/5 | Impact: 5/5**

| Option | TS Native | Speed (700KB) | Install Size | npm Downloads |
|---|---|---|---|---|
| **oxc-parser** | Yes | ~26ms | ~2 MB | Growing fast |
| es-module-lexer + swc pre-transform | No (needs transform) | ~5ms parse + transform overhead | 4KB + 37MB | 26M + 12M |
| @swc/core | Yes | ~84ms | ~37 MB | 12M |
| TypeScript Compiler API | Yes | ~100-200ms | ~20 MB | 55M |
| tree-sitter | Yes | ~30-50ms | Native binary | 496K |

- **Parses TypeScript natively** — no pre-transform step needed
- **3x faster than swc, 5x faster than Biome** on benchmarks
- **Direct ESM info extraction** via `result.module.staticImports` — no AST walk needed
- **2 MB install** vs swc's 37 MB
- **Vite 8 and Rolldown are built on oxc** — this is the future of the JS toolchain

**Why not es-module-lexer?** It **cannot parse TypeScript at all**. You'd need to pre-transform every file with swc/esbuild first, which negates the speed advantage and adds 37MB of dependencies.

### Decision 2: Module Resolver — `oxc-resolver`

**Confidence: 5/5 | Impact: 4/5**

- 28x faster than webpack's enhanced-resolve
- Handles: ESM + CJS resolution, TypeScript path aliases, Yarn PnP
- Has `resolveSync` API for blocking resolution — perfect for graph building

### Decision 3: Graph Storage — JSON

**Confidence: 5/5 | Impact: 2/5**

For a dependency graph of 500-2000 files, JSON is under 1ms to parse/stringify, zero dependencies, and human-readable. What Nx uses for its project graph cache. msgpackr is a drop-in upgrade if needed (4x faster, 50% smaller).

**Why not SQLite?** Native addon dependency = installation failures for users. better-sqlite3 requires node-gyp prebuilds.

### Decision 4: Cache Invalidation — mtime-only

**Confidence: 5/5 | Impact: 3/5**

Check file mtime via `lstat`. If changed, reparse. xxhash-wasm was originally planned as a fallback but was dropped during refinement — the cost of a false reparse on `touch` without edit is ~0.5ms per file. Not worth the dependency.

### Decision 5: Git Diff — Two-mode strategy

**Confidence: 4/5 | Impact: 3/5**

- **Local development (watch mode):** Use mtime+hash strategy. No git needed.
- **CI / explicit `--changed` mode:** `git diff --merge-base main --name-only HEAD` + `git ls-files --others --exclude-standard`

### Decision 6: Integration — Vitest Plugin (REVISED)

**Confidence: 5/5 | Impact: 5/5**

**REVISION:** The original decision was based on web research stating that `configureVitest` cannot filter the test file list. **This was empirically disproven.** Mutating `vitest.config.include` inside `configureVitest` DOES affect which files run. Tested on Vitest 3.2.4.

The plugin approach is strictly better: zero friction, IDE integrations work automatically, no separate binary, CI scripts unchanged.

**Lesson learned:** Always empirically verify architectural constraints.

### Decision 7: Build Tool — tsup

**Confidence: 3/5 | Impact: 1/5**

tsup for reliability now. tsdown is 49% faster and is the successor, but requires Node 20.19+. Migration is trivial (`tsdown migrate`).

### Decisions 8-12 (Brief)

- **Package name:** `vitest-affected` — memorable, follows `vitest-{descriptor}` convention
- **CJS support:** ESM-only. Vitest users are already ESM-native.
- **Test detection:** Use Vitest's own config patterns via tinyglobby (not `project.globTestFiles()` — that populates internal cache)
- **Monorepo:** Single-project first. Nx/Turborepo already handle package-level.
- **Dynamic imports:** Include string-literal dynamic imports, flag computed ones

---

# Phase 1: Static Import Graph (MVP)

**Effort:** ~500-1000 lines
**Accuracy:** Covers all static import-chain dependencies
**Mode:** One-shot only (`vitest run`)

## Goal

Ship a working Vitest plugin that pre-filters test files using static import analysis. Zero config for users — just add the plugin to `vitest.config.ts` and run `npx vitest run`.

## Implementation Steps (test-first order)

### Step 0: Project Scaffolding + Stub Cleanup

The existing code stubs are from pre-refinement and contradict the plan. **This is an atomic prerequisite — complete ALL sub-steps and verify the build passes before starting Step 1.**

Execute in this order:

1. **Rewrite `src/index.ts`** → single export `vitestAffected` (MUST be first — current exports reference symbols deleted in later steps)
2. **Delete** `src/graph/cache.ts` (caching deferred to Phase 2)
3. **Delete** `src/graph/inverter.ts` (inlined into builder.ts)
4. **Rewrite `src/graph/builder.ts`** → export `buildFullGraph(rootDir)` returning `{ forward, reverse }` (see Step 2 for full spec). Delete `DependencyGraph` interface.
5. **Rewrite `src/selector.ts`** → pure `bfsAffectedTests` function (remove `SelectionResult`, `getAffectedTests`)
6. **Rewrite `src/plugin.ts`** → remove `verify` option and `onFilterWatchedSpecification` references; orchestration (build → BFS) lives here. Destructure `{ vitest, project }` (not just `vitest`) — `project.config.include` patterns needed for test file identification via `tinyglobby`.
7. **Rewrite `src/git.ts`** → return `{ changed: string[]; deleted: string[] }` (not flat `string[]`). Stub comments say `ACMR` — plan requires `ACMRD` (includes deletions). Follow the pseudocode, not stub comments.
8. **Update `package.json`** → peer dep `>=3.2.0` (required for `onAfterSetServer` in Phase 2b/3), remove `xxhash-wasm`, add `tinyglobby` to deps (picomatch deferred to Phase 2), add `tsup` to devDeps, update `scripts.build` from `"tsc"` to `"tsup"`, remove or update `scripts.dev` to `"tsup --watch"`
9. **Run `npm install`** — install new deps before creating config files
10. **Create** root `vitest.config.ts` and `tsup.config.ts` — tsup config: `{ entry: ['src/index.ts'], format: ['esm', 'cjs'], dts: true, clean: true }`
11. **Create/update `.gitignore`** — add `dist/`, `.vitest-affected/`, `coverage/`, `node_modules/`
12. **Build gate:** Run `npm run build` and verify zero errors before proceeding to Step 1.

### Step 1: Fixture Tests

Create small projects with known dependency structures FIRST. These define the contract.

Fixtures:
- `simple/` — Linear A→B→C chain
- `diamond/` — A→B→C, A→D→C (diamond dependency)
- `circular/` — A→B→A (circular import handling)

Write failing tests that assert expected graph shapes and affected test sets.

**Integration tests (in addition to unit tests):** Add a minimal set of tests that spawn `vitest run` against fixtures via `execa` and assert:
- The plugin actually filters which tests execute (parse `--reporter=json` output)
- `config.include` mutation with absolute paths works (catches Vitest version regressions)
- `configureVitest` async completion is honored
- Run on linux + windows in CI to validate path normalization

### Step 2: `graph/builder.ts`

Exports `buildFullGraph(rootDir)` returning `{ forward: Map<string, Set<string>>, reverse: Map<string, Set<string>> }`.

The `invertGraph` function is internal to this file (inlined from the former `inverter.ts`).

**Glob:** All code files (including test files) using `**/*.{ts,tsx,js,jsx,mts,mjs,cts,cjs}` (exclude `node_modules/`, `dist/`, `.vitest-affected/`, `test/fixtures/`, `coverage/`, `.next/`). The glob MUST return absolute paths (`tinyglobby` with `absolute: true`).

**Parse each file** with `oxc-parser`, resolve specifiers with `oxc-resolver`, build forward graph `Map<string, Set<string>>`.

**Non-source file handling:** When a parsed file imports a non-source file (e.g., `import data from './data.json'`), the resolved path is added as a forward-graph key with an empty dependency set — this ensures the inverter creates a reverse edge so BFS can trace dependents of that `.json`/`.css` file.

**Skip `node_modules` paths** returned by the resolver — only include files under `rootDir`. Use `tinyglobby` for globbing.

**Parse error handling:** If `oxc-parser` returns errors for a file, log a warning and add the file to the graph with an empty dependency set (graceful degradation). Do not crash the graph build for a single malformed file.

**tsconfig discovery:** Search for `tsconfig.json` starting from `rootDir`. If not found, create the resolver without tsconfig config (path aliases will fail, but basic resolution works). Log a warning if tsconfig is missing.

**Required exports (consumed by Phase 2):** Implement and export these functions as part of Step 2, not as a later addition:
- `resolveFileImports(file: string, source: string, rootDir: string, resolver: ResolverFactory)` → parses import specifiers from source AND resolves them to absolute paths using the provided resolver. Returns `string[]` of resolved absolute import paths. Extract single-file parse+resolve from the `buildFullGraph` loop.
- `createResolver(rootDir: string)` → creates and returns a configured `ResolverFactory` instance. Both `buildFullGraph` and Phase 2's `updateGraphForFiles` share the same resolver config.

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

## Plugin Pseudocode

```typescript
/// <reference types="vitest/config" />
import type { Plugin } from 'vite';

// Basename check for known config files. Vitest's forceRerunTriggers uses glob patterns
// designed for watch mode (e.g., **/package.json/**) which may not match one-shot paths.
// setupFiles are handled separately by Vitest in watch mode, so we check them explicitly.
const CONFIG_BASENAMES = new Set([
  'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb',
  'tsconfig.json',
  'vitest.config.ts', 'vitest.config.js', 'vitest.config.mts',
  'vitest.workspace.ts', 'vitest.workspace.js',
  'vite.config.ts', 'vite.config.js', 'vite.config.mts',
]);

export function vitestAffected(options: VitestAffectedOptions = {}): Plugin {
  return {
    name: 'vitest:affected',

    // NOTE: configureVitest is typed as returning void, but Vite's HookHandler
    // supports async hooks via callHookWithContext. Verify this works in the
    // integration test — if not, wrap body in a .then() chain or use top-level await.
    async configureVitest({ vitest, project }) {
      // Environment variable override for CI flexibility
      if (process.env.VITEST_AFFECTED_DISABLED === '1') {
        options = { ...options, disabled: true };
      }
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

        let changed: string[], deleted: string[];
        if (options.changedFiles) {
          // Bypass git — use provided file list (useful for non-git CI or testing)
          const resolved = options.changedFiles.map(f => path.resolve(rootDir, f));
          changed = resolved.filter(f => existsSync(f));
          deleted = resolved.filter(f => !existsSync(f));
        } else {
          ({ changed, deleted } = await getChangedFiles(rootDir, options.ref));
        }

        if (changed.length === 0 && deleted.length === 0) {
          if (verbose) console.log('[vitest-affected] No git changes detected — running full suite');
          return;
        }

        // Phase 1 (no cache): deleted files aren't in the freshly-built graph,
        // so we can't trace their dependents. ANY deleted file triggers full suite.
        // Phase 2 improvement: use cached graph's reverse edges for smart tracing.
        const deletedInGraph = deleted.filter(f => forward.has(f));
        if (deletedInGraph.length > 0) {
          if (verbose) console.warn(`[vitest-affected] ${deletedInGraph.length} graph file(s) deleted — running full suite`);
          else console.warn('[vitest-affected] Deleted file(s) in dependency graph — running full suite');
          return;
        }

        // Force full run if config/infra/setup files changed.
        const setupFileSet = new Set(project.config.setupFiles ?? []);
        const hasForceRerun = changed.some(f =>
          CONFIG_BASENAMES.has(path.basename(f)) || setupFileSet.has(f)
        );
        if (hasForceRerun) {
          console.log('[vitest-affected] Config file changed — running full suite');
          return;
        }

        // DO NOT call project.globTestFiles() here — it populates Vitest's internal
        // testFilesList cache. Instead, glob test files directly with tinyglobby.
        const testFiles = await glob(project.config.include, {
          cwd: rootDir,
          absolute: true,
          ignore: [...(project.config.exclude ?? []), '**/node_modules/**'],
        });
        const testFileSet = new Set(testFiles);
        const isTestFile = (f: string) => testFileSet.has(f);
        const affectedTests = bfsAffectedTests(changed, reverse, isTestFile);

        const ratio = testFileSet.size > 0 ? affectedTests.length / testFileSet.size : 0;
        if (ratio > (options.threshold ?? 1.0)) {
          if (verbose) console.log(`[vitest-affected] ${(ratio * 100).toFixed(0)}% of tests affected — running full suite`);
          return;
        }

        if (verbose) {
          for (const f of changed) {
            if (!forward.has(f)) {
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
          // NOTE: config.include is typed as glob patterns but accepts absolute paths.
          // Empirically verified on Vitest 3.2.4. Add integration test to catch regressions.
          project.config.include = validTests;
          console.log(`[vitest-affected] ${validTests.length} affected tests`);
          if (verbose) validTests.forEach(t => console.log(`  → ${path.relative(rootDir, t)}`));
        } else if (options.allowNoTests) {
          console.log('[vitest-affected] No affected tests — skipping all (allowNoTests=true)');
          project.config.include = [];
          vitest.config.passWithNoTests = true;
        } else {
          console.log('[vitest-affected] No affected tests — running full suite (set allowNoTests to skip)');
        }
      } catch (err) {
        console.warn('[vitest-affected] Error — running full suite:', err);
      }
    }
  };
}
```

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
  extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.json'],
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
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
const execFile = promisify(execFileCb);

async function exec(cmd: string, args: string[], opts: { cwd: string }): Promise<{ stdout: string }> {
  try {
    const { stdout } = await execFile(cmd, args, { ...opts, encoding: 'utf-8' });
    return { stdout: stdout ?? '' };
  } catch (err: any) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${err.stderr ?? err.message}`);
  }
}

async function getChangedFiles(rootDir: string, ref?: string): Promise<{ changed: string[]; deleted: string[] }> {
  const { stdout: inWorkTree } = await exec('git', ['rev-parse', '--is-inside-work-tree'], { cwd: rootDir })
    .catch(() => ({ stdout: 'false' }));
  if (inWorkTree.trim() !== 'true') {
    console.warn('[vitest-affected] Not inside a git work tree — running full suite');
    return { changed: [], deleted: [] };
  }

  if (ref) {
    const { stdout: isShallow } = await exec('git', ['rev-parse', '--is-shallow-repository'], { cwd: rootDir });
    if (isShallow.trim() === 'true') {
      throw new Error('[vitest-affected] Shallow clone. Set fetch-depth: 0 in CI.');
    }
  }

  const { stdout: gitRootRaw } = await exec('git', ['rev-parse', '--show-toplevel'], { cwd: rootDir });
  const gitRoot = gitRootRaw.trim();

  const run = async (args: string[]) => {
    const { stdout } = await exec('git', args, { cwd: gitRoot });
    return stdout.split('\n').filter(Boolean);
  };

  const [committed, staged, unstaged] = await Promise.all([
    ref ? run(['diff', '--name-only', '--diff-filter=ACMRD', `${ref}...HEAD`]) : [],
    run(['diff', '--cached', '--name-only', '--diff-filter=ACMRD']),
    run(['ls-files', '--others', '--modified', '--exclude-standard', '--full-name']),
  ]);

  const allFiles = [...new Set([...committed, ...staged, ...unstaged])]
    .map(f => path.resolve(gitRoot, f));

  const { existsSync } = await import('node:fs');
  return {
    changed: allFiles.filter(f => existsSync(f)),
    deleted: allFiles.filter(f => !existsSync(f)),
  };
}
```

## Known Limitations (Phase 1)

- `fs.readFile` dependencies, shared global state, config file impacts, computed dynamic imports
- `vi.mock()` with factory functions: mock factories that import helpers create invisible dependencies
- **Watch mode:** Not supported. `configureVitest` runs once at startup — test set becomes stale. Deferred to Phase 2.
- **Vitest workspaces:** Not supported. Plugin detects workspace mode and falls back to full suite.
- **File renames:** Appear as deletion + addition, triggering conservative full-suite fallback.
- **Temporal mismatch:** Graph reflects current disk state, diff reflects historical changes. Rare false-negative vector eliminated by Phase 3 coverage data.
- **Nested tsconfigs:** Only root-level config filenames trigger full rerun.
- **Monorepo root mismatch:** Plugin uses `vitest.config.root` for graph building and `git rev-parse --show-toplevel` for changed files. In monorepos where vitest root is a subdirectory of the git root, the `startsWith(rootDir)` filter silently drops changed files outside vitest root — causing full-suite run (safe but wasteful).
- **`config.include` absolute paths:** Assigning absolute file paths to `config.include` (typed as glob patterns) works empirically on Vitest 3.2.4 but is undocumented behavior. Add integration test to catch regressions.
- **`configureVitest` async return:** The hook is typed as `() => void` but Vite's HookHandler supports async. Verify in integration test.

## Testing Strategy

- **Fixture tests:** Small projects with known dependency structures (simple, diamond, circular)
- **Graph correctness:** Assert expected graph shapes against known import chains
- **Edge cases:** Circular imports, re-exports, dynamic imports, type-only imports, `.json`/`.css` imports
- **Benchmarks:** Parse + resolve times on real-world project sizes
- **Integration:** `npm link` against body-compass-app for live validation

---

# Phase 2: Watch Mode + Caching

**Depends on:** Phase 1 (Static Import Graph)
**Effort:** Days-weeks
**New file:** `src/graph/cache.ts`
**New deps:** None (mtime-only invalidation)

**Deliverable split:** Phase 2a (caching, one-shot) ships first. Phase 2b (watch mode) layers on top.

## Goal

Persist the dependency graph across runs for fast startup (Phase 2a), then make vitest-affected work in watch mode (Phase 2b).

**Deferred to Phase 3+:**
- **Verify mode** — diagnostic for static-analysis misses, but the fix (coverage data) doesn't exist until Phase 3.
- **Rename detection** — Phase 1's full-suite fallback on renames is correct and safe.

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

export interface GraphSnapshot {
  forward: Map<string, Set<string>>;
  reverse: Map<string, Set<string>>;
  fileMtimes: Map<string, number>;
  builtAt: number;
}

function loadOrBuildGraph(rootDir: string, verbose: boolean): Promise<GraphSnapshot>;
function saveGraph(snapshot: GraphSnapshot, cacheDir: string): Promise<void>;
function saveGraphSync(snapshot: GraphSnapshot, cacheDir: string): void;
```

**Phase 2b adds `updateGraphForFiles`** (not needed for one-shot caching):

```typescript
function updateGraphForFiles(
  snapshot: GraphSnapshot,
  changedFiles: string[],
  deletedFiles: string[],
  rootDir: string,
  resolver: ResolverFactory
): GraphSnapshot;  // NOTE: synchronous — all I/O uses readFileSync + parseSync + resolver.sync()
```

**Deletion logic for `updateGraphForFiles`:** For each file in `deletedFiles`: capture `reverse.get(file)` FIRST (these dependents become BFS seeds), then remove from `forward` map, remove from all `reverse` value sets, remove from `fileMtimes`. For each file in `changedFiles`: call `resolveFileImports` to get new imports, replace old forward edges, update reverse edges (remove stale, add new), update mtime. Return updated snapshot.

#### Invalidation: mtime-only

Check file mtime via `lstat`. If mtime changed, reparse. If unchanged, skip. mtime-only is sufficient on modern filesystems (ext4, APFS, NTFS have sub-second granularity). The unlikely edge case of content change within the same mtime tick fails safe (causes one stale BFS result that over-selects, never under-selects).

#### Phase 1 Integration

`buildFullGraph(rootDir)` returns `{ forward, reverse }` without mtimes. `loadOrBuildGraph` wraps this: on cache miss, calls `buildFullGraph`, then stats all files to collect mtimes. The file list comes from `forward.keys()`.

### Implementation Steps (2a)

1. **Export `resolveFileImports` and `createResolver` from `builder.ts`** (if not already done in Phase 1).
2. **Implement `cache.ts`** — `loadOrBuildGraph`, `saveGraph`, `saveGraphSync`. Atomic writes via write-then-rename.
3. **Update `plugin.ts`** — Replace `buildFullGraph(rootDir)` with `loadOrBuildGraph(rootDir, verbose)`.
4. **Tests** — Cache round-trip, corrupt cache recovery, mtime invalidation, `saveGraphSync` atomicity.

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

### Architecture: Lazy Graph Update + Set Lookup

Vitest's `VitestWatcher` already hooks chokidar, tracks changed files, and debounces at ~100ms before calling `onFilterWatchedSpecification` per spec. Do NOT duplicate this event machinery. Instead:

1. **Watcher event fires** → record changed file path in a `dirtyFiles: Set<string>`
2. **Vitest debounce expires** → calls `onFilterWatchedSpecification` per spec
3. **First filter call per batch** → detect dirty set is non-empty, update graph synchronously, compute BFS, cache result in `currentAffectedSet`, clear dirty set
4. **Subsequent filter calls** → `Set.has()` lookup

Graph updates are fully synchronous: `readFileSync` + `parseSync` (oxc-parser) + `resolver.sync()` (oxc-resolver). Single-file update is ~0.5ms — well within Vitest's debounce window.

### Watcher Registration

```typescript
// Capture ORIGINAL include patterns BEFORE Phase 1 mutates project.config.include.
const originalInclude = [...project.config.include];
const originalExclude = [...(project.config.exclude ?? [])];

const dirtyFiles = new Set<string>();
let currentAffectedSet: Set<string> | null = null;
let testFilesDirty = false;

let testFileSet = new Set(await glob(originalInclude, {
  cwd: rootDir, absolute: true, ignore: [...originalExclude, '**/node_modules/**'],
}));

function updateGraphAndBFS(): void {
  if (dirtyFiles.size === 0) return;

  const changed = [...dirtyFiles];
  dirtyFiles.clear();

  const bfsSeeds: string[] = [];
  for (const file of changed) {
    const source = readFileSyncSafe(file);
    if (source === null) {
      // File deleted — capture reverse edges BEFORE removal
      const dependents = snapshot.reverse.get(file);
      if (dependents) bfsSeeds.push(...dependents);
      snapshot = updateGraphForFiles(snapshot, [], [file], rootDir, resolver);
      testFileSet.delete(file);
      continue;
    }
    snapshot = updateGraphForFiles(snapshot, [file], [], rootDir, resolver);
    bfsSeeds.push(file);
  }

  if (testFilesDirty) {
    testFileSet = new Set(globSync(originalInclude, {
      cwd: rootDir, absolute: true, ignore: [...originalExclude, '**/node_modules/**'],
    }));
    testFilesDirty = false;
  }

  const isTestFile = (f: string) => testFileSet.has(f);
  const affected = bfsAffectedTests(bfsSeeds, snapshot.reverse, isTestFile);
  currentAffectedSet = new Set(affected);
}
```

### Plugin Structure (Watch Mode)

```typescript
async configureVitest({ vitest, project }) {
  // ... load graph ...

  if (vitest.config.watch) {
    vitest.onFilterWatchedSpecification((spec) => {
      updateGraphAndBFS();  // No-op if dirtyFiles is empty
      if (!currentAffectedSet) return true;  // null = run everything (safe)
      return currentAffectedSet.has(spec.moduleId);
    });

    // Defer watcher access — vitest.vite may not be initialized at configureVitest time.
    if (typeof vitest.onAfterSetServer === 'function') {
      vitest.onAfterSetServer(() => {
        const watcher = vitest.vite?.watcher;
        if (watcher) {
          for (const event of ['change', 'add', 'unlink'] as const) {
            watcher.on(event, (filePath: string) => {
              const absPath = path.resolve(rootDir, filePath);
              dirtyFiles.add(absPath);
              currentAffectedSet = null;  // Invalidate
              if (event === 'add' || event === 'unlink') testFilesDirty = true;
            });
          }
        } else {
          console.warn('[vitest-affected] No file watcher — watch filtering disabled');
        }
      });
    } else {
      console.warn('[vitest-affected] onAfterSetServer not available — watch filtering disabled');
    }

    // Graceful shutdown: persist graph on exit (sync to avoid teardownTimeout race)
    if (typeof vitest.onClose === 'function') {
      vitest.onClose(() => {
        saveGraphSync(snapshot, cacheDir);
      });
    }
  }

  // One-shot logic runs UNCONDITIONALLY (handles initial run in both modes)
  const { changed, deleted } = await getChangedFiles(rootDir, options.ref);
  // ... Phase 1 BFS, threshold, config.include mutation ...
}
```

### Implementation Steps (2b)

5. **Implement `updateGraphForFiles` in `cache.ts`** — Synchronous incremental graph update.
6. **Smart deletion handling** — With cached graph, BFS from deleted files' former dependents instead of full-suite fallback.
7. **Remove watch mode guard from `plugin.ts`** — Replace with `onFilterWatchedSpecification` + lazy graph update.
8. **Add watcher registration** — Single `onAfterSetServer` callback.
9. **Add `updateGraphAndBFS` function** — Synchronous graph update + BFS on first filter call per batch.
10. **Add graceful shutdown** — `vitest.onClose()` → `saveGraphSync`.
11. **Tests** — Mock watcher events + filter calls, graph update correctness, deleted-file propagation, cache persistence on close.

## Known Limitations (Phase 2)

- **`onFilterWatchedSpecification` AND semantics:** If another plugin registers a filter, results are AND-ed.
- **`vitest.vite?.watcher` availability:** May be undefined in `browser` mode. Watch filtering silently disables.
- **`vitest.vite` at `configureVitest` time:** Not available. Watcher registration deferred to `onAfterSetServer()`.
- **Synchronous graph update cost:** Single-file ~0.5ms. Batch of 20 = ~10ms. Well within debounce.
- **`globSync` in filter callback:** Re-globs test files synchronously. ~5-10ms, runs once per batch, not per spec.
- **Mtime-only invalidation:** `touch` without edit causes unnecessary reparse (~0.5ms per file).
- **`onAfterSetServer` is `@internal`:** Runtime check with fallback.
- **Cache version migration:** Unknown `version` triggers full rebuild.

---

# Phase 3: Coverage-Enhanced Selection

**Depends on:** Phase 2 (Watch Mode + Caching)
**Effort:** Days (reduced from weeks after refinement)
**New file:** `src/coverage.ts`
**New deps:** None (uses Node.js built-in APIs + Vitest's existing coverage output)
**Status: Optional / data-driven.** Ship Phases 1+2 first. Measure real-world false-negative rates. Phase 3 catches rare edge cases at the cost of depending on 2 undocumented Vitest internals (`onAfterSetServer`, `vitest.reporters`). Build only if static-analysis miss rate justifies the fragility.

## Goal

Augment the static import graph with runtime coverage data. After test runs, read which source files each test worker actually loaded at runtime. Union these edges into the static graph to catch dependencies invisible to static analysis.

## Why Coverage Data Matters

Phase 1's static graph misses:

| Invisible dependency | Why static misses it | Coverage catches it |
|---|---|---|
| `import(variable)` | Computed specifier | Runtime reveals actual path |
| `require('./config')[env]` | Dynamic property access | Traces actual file |
| `vi.mock('./foo', () => import('./bar'))` | Mock factory is opaque | Factory executes, bar.ts in coverage |
| `fs.readFileSync('./data.json')` | Not an import | File appears in V8 coverage |

**Safety invariant preserved:** Coverage only ADDS edges (union). False negatives can only decrease.

## Integration Strategy: Post-Run File Reader

**Not** a custom coverage provider. Vitest writes per-worker V8 coverage to `<reportsDirectory>/.tmp/coverage-<N>.json` when `coverage.enabled = true`. Phase 3 reads these files after the test run completes.

### Why Not Custom Provider?

- `coverage.provider: 'custom'` replaces the entire V8/Istanbul pipeline — can't "wrap" it
- Requires a `customProviderModule` file path, not runtime registration
- Breaks users' existing `provider: 'v8'` or `provider: 'istanbul'` configs

### How It Works

1. User enables V8 coverage in their config (or we auto-enable via Vite `config` hook)
2. Vitest runs tests, collecting V8 coverage per worker as normal
3. Coverage files are written to `<reportsDirectory>/.tmp/`
4. After run completes, our reporter's `onTestRunEnd` reads these files (sync, for atomicity)
5. Extract file-level mappings: which source files each worker loaded
6. Union into the static graph and persist

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

## Persistence: Fold Into `graph.json`

```json
{
  "version": 2,
  "builtAt": 1708000000000,
  "files": { ... },
  "coverageEdges": {
    "src/utils/food.ts": ["tests/food.test.tsx", "tests/utils.test.ts"]
  },
  "coverageCollectedAt": 1708000000000
}
```

**Version migration:** Reading v1 cache → treat as valid with empty coverage edges. Bump to v2 on next write.

## Plugin Integration

### Reporter Registration

**Verified against Vitest 3.2.4:** `configureVitest` hooks fire at line 9322, then `this.reporters = createReporters(...)` overwrites at line 9341. Must register reporter **after** initialization via `vitest.onAfterSetServer()`.

```typescript
// In plugin.ts — Phase 3 additions (inside same onAfterSetServer callback as Phase 2b)
if (options.coverage) {
  const reporters = (vitest as any).reporters;
  if (Array.isArray(reporters)) {
    reporters.push({
      onTestRunEnd() {
        const newEdges = readCoverageEdges(coverageTmpDir, rootDir, coverageTestFileSet);
        mergeIntoGraph(snapshot.reverse, newEdges);
        saveGraphSync(snapshot, cacheDir);
      }
    });
  } else {
    console.warn('[vitest-affected] Cannot register coverage reporter — vitest.reporters not accessible');
  }
}
```

### Auto-Enabling Coverage

Must happen in the **Vite `config` hook** (before Vitest's `initCoverageProvider()`):

```typescript
config(config) {
  if (!options.coverage) return;
  const test = config.test ?? {};
  const cov = test.coverage ?? {};
  if (cov.enabled === undefined) {
    test.coverage = {
      ...cov,
      enabled: true,
      provider: 'v8',
      reporter: ['json'],
      all: false,
    };
    config.test = test;
  }
}
```

### Implementation Steps

1. **Implement `coverage.ts`** — `readCoverageEdges`, `mergeIntoGraph`, `normalizeUrl`. Sync I/O.
2. **Update cache format** — Bump version to 2. Add `coverageEdges` + `coverageCollectedAt`. Handle v1→v2 migration.
3. **Update `plugin.ts`** — Auto-enable coverage in Vite `config` hook. Register reporter via `onAfterSetServer`. Merge cached edges.
4. **Tests** — Coverage file parsing, URL normalization, edge extraction, merge correctness, v1→v2 migration.

## Merge Algorithm

```
merged_graph = static_graph ∪ coverage_graph
```

Coverage adds edges static missed. Static keeps edges coverage missed. Result: more tests selected (possible), fewer missed (reduced).

## Known Limitations (Phase 3)

- **Coverage must be enabled:** Falls back to static-only if user disables.
- **First-run cold start:** No coverage data on first run. Static graph only.
- **Coverage edges are one run behind:** Run N data benefits run N+1.
- **Coverage file race:** `onTestRunEnd` fires between `generateCoverage()` and `reportCoverage()`. Sync I/O + ENOENT guards handle this.
- **URL normalization:** Unknown URL schemes silently skipped. Add verbose logging.
- **Per-worker union with `isolate: false`:** Over-selects but never under-selects.
- **`onAfterSetServer` is undocumented:** Exists in Vitest 3.2.4 runtime but absent from type definitions. May break on minor releases.
- **Shard mode:** `vitest --shard=N/M` changes tmp dir to `.tmp-N-M`. Read `vitest.config.shard` at impl time.
- **Version downgrade:** Phase 2 code reading v2 cache triggers full rebuild (safe).

---

## Phase 4: Symbol-Level Tracking (Future)

- Use oxc-parser's full AST to track which specific exports each test uses
- If only `functionA` changed, skip tests that only import `functionB`
- Wallaby-level precision, open-source

---

## Phase 5: Predictive Selection (Aspirational)

- ML model trained on historical test results (a la Meta's approach)
- Predicts which tests are most likely to fail for a given diff
- Requires CI integration and training data pipeline

---

## Cross-Phase Dependencies

| Phase 1 produces | Phase 2 consumes |
|---|---|
| `buildFullGraph(rootDir)` → `{ forward, reverse }` | `loadOrBuildGraph` wraps this, adds mtime layer |
| `resolveFileImports(file, source, rootDir, resolver)` | `updateGraphForFiles` calls this for incremental updates |
| `createResolver(rootDir)` | Shared resolver instance across graph ops |
| `bfsAffectedTests(changed, reverse, isTestFile)` | Reused in watch mode `updateGraphAndBFS` |

| Phase 2 produces | Phase 3 consumes |
|---|---|
| `GraphSnapshot` with `forward`, `reverse`, `fileMtimes`, `builtAt` | Extended with `coverageEdges?`, `coverageCollectedAt?` |
| `loadOrBuildGraph` / `saveGraph` | Handles v1→v2 migration, serializes coverage edges |
| `cache.ts` disk format (version 1) | Bumped to version 2 with coverage fields |
| `tinyglobby` glob → `testFileSet` | Reused for coverage test-vs-source classification |
| `saveGraph` / `saveGraphSync` | Phase 3 uses `saveGraphSync` for coverage reporter |

---

## Market Validation & Prior Art

### Competitive Gap Confirmed

| Tool | Test Selection? | Open Source? | Vitest? | File-Level? |
|---|---|---|---|---|
| Vitest `--changed` | Import graph only | Yes | Yes | Yes (buggy) |
| Wallaby.js | Static + dynamic | No ($100-160/yr) | Yes | Yes |
| Datadog TIA | Coverage-based | No (SaaS) | Yes (via dd-trace) | Yes (suite-level) |
| Codecov ATS | Coverage-based | Partial | No (Python only) | Yes |
| Nx affected | Dependency graph | Yes | Partial | No (package-level) |
| Bun test | None | Yes | No | No |
| **vitest-affected** | **Import graph + cache** | **Yes** | **Yes** | **Yes** |

**We are the only open-source, file-level, Vitest-native test impact analysis tool.**

### Community Demand

| Vitest Issue | Request | Status |
|---|---|---|
| [#6735](https://github.com/vitest-dev/vitest/issues/6735) | "Make `--changed` use coverage or static analysis" — directly requests TIA | Open |
| [#280](https://github.com/vitest-dev/vitest/issues/280) | "Run related tests from source file list" — led to `vitest related` | Partial |
| [#1113](https://github.com/vitest-dev/vitest/issues/1113) | "`--changed` ignores test files" | Open (known bug) |
| [#5237](https://github.com/vitest-dev/vitest/issues/5237) | "`--coverage` + `--changed` don't work together" | Open |

Bun test has similar demand: [oven-sh/bun#22717](https://github.com/oven-sh/bun/issues/22717), [#7546](https://github.com/oven-sh/bun/issues/7546), [#4825](https://github.com/oven-sh/bun/issues/4825)

### Industry Research

- **Meta:** Predictive test selection catches >95% of failures running only 1/3 of tests
- **Google TAP:** Proximity in the dependency graph is the strongest signal for test failure
- **Martin Fowler:** Recommends storing test-to-file mappings as text files in the same repo — exactly our JSON-in-.vitest-affected approach
- **Symflower (2024):** Even basic TIA yields 29% average reduction in test execution time
- **Spotify:** ML-based TIA reduced test time by 67% while maintaining 99.2% bug detection

### Algorithms

- **Jest `resolveInverseModuleMap`** — BFS scanning entire haste-map per level: O(V x depth). Our reverse adjacency list: O(V + E).
- **Martin Fowler's TIA taxonomy** — coverage-based vs graph-based vs predictive
- **Meta Predictive Test Selection** — ML approach, 2x CI cost reduction

### Why Previous JS TIA Attempts Failed

1. **Dynamic language complexity** — JavaScript's dynamic imports, eval, lazy loading
2. **Ecosystem fragmentation** — too many bundlers, test frameworks, module systems
3. **Build tool opacity** — TS → bundler → runtime creates layers of indirection
4. **Coverage overhead** — per-test collection is expensive in JavaScript

Our advantage: Start with static import graph analysis (cheap, fast, no overhead) and layer coverage on top later. Benefit from oxc ecosystem which didn't exist when earlier attempts were made.

---

## Refinement Log

### Phase 1: Round 1 (Medium: Builder/Breaker/Trimmer — 3x Opus)

- **Changes:** 10 auto-applied (1 Critical plan bloat, 2 Critical docs, 4 High correctness, 3 High structure)
- **Key fixes:** Removed ~150 lines of research/history artifacts. Removed rename detection from Phase 1. Scoped force-rerun to rootDir files only. Added existsSync filter on BFS results. Inlined inverter.ts into builder.ts. Moved index.ts rewrite into Step 0.
- **Trajectory:** Critical/High found → continue

### Phase 1: Round 2 (Medium: Builder/Breaker/Trimmer — 3x Opus)

- **Changes:** 6 applied (1 Critical, 3 High, 2 Medium)
- **Key fixes:** Fixed Step 0 return type contradiction. Added existsSync filter logging. Separated unstaged deletions from staged. Documented nested tsconfig limitation.
- **Trajectory:** No Critical remaining → finalize

### Full Plan: Round 1 (Heavy: 6-agent panel)

- **Changes:** 11 applied (2 Critical, 6 High, 3 Medium)
- **Key fixes:** Added "Why Not --changed?" speed comparison. Made Step 0 atomic with build gate. Changed threshold default from 0.5 to 1.0. Added CI cache documentation. Fixed Phase 2b watcher to use onAfterSetServer. Added smart deletion handling for Phase 2a.
- **Trajectory:** Critical/High found → continue

### Full Plan: Round 2 (Heavy: 6-agent panel)

- **Changes:** 8 applied (2 Critical, 6 High)
- **Key fixes:** Replaced forceRerunTriggers logic with basename check. Changed config.include mutation to project.config. Added exec helper spec for git.ts. Renamed parseImports → resolveFileImports.
- **Trajectory:** Critical/High found → continue

### Full Plan: Round 3 (Heavy: 6-agent panel)

- **Changes:** 7 applied (3 Critical, 4 High) + 5 cascading fixes
- **Key fixes:** Replaced `project.globTestSpecifications()` with `project.globTestFiles()`. Fixed zero-tests branch. Reverted forceRerunTriggers to basename check + setupFiles. Removed SOURCE_EXT filter on deleted files.
- **Trajectory:** Critical/High found → continue

### Full Plan: Round 4 (Heavy: 6-agent panel)

- **Changes:** 4 applied (1 Critical, 3 High)
- **Key fixes:** Replaced `project.globTestFiles()` with direct `tinyglobby` glob to avoid populating Vitest's internal cache before `config.include` mutation. Changed `setupFiles` to read from `project.config`. Removed `picomatch` from Phase 1 deps.
- **Trajectory:** 1 Critical found (clean fix). 3/6 agents say ready. → finalize

### Phase 2+3: Round 1 (Medium: Builder/Breaker/Trimmer)

- **Changes:** 11 applied (4 Critical, 6 High, 1 Medium)
- **Key fixes:** Collapsed Phase 2b watcher machinery — removed custom event coalescing, async queue, and 50ms timer that raced with Vitest's debounce. Replaced with lazy graph update + Set.has() lookup. Fixed `vitest.server` → `vitest.vite`. Added `vitest.onClose()` for shutdown. Formalized resolveFileImports/createResolver as Phase 1 deliverables. Marked Phase 3 as optional/data-driven.
- **Trajectory:** 4 Critical found → continue

### Phase 2+3: Round 2 (Medium: Builder/Breaker/Trimmer)

- **Changes:** 7 applied (1 Critical, 6 High)
- **Key fixes:** Fixed `updateGraphForFiles` async→sync signature mismatch. Cached test file set with incremental updates. Captured original include patterns before Phase 1 config mutation. Added `saveGraphSync` to cache.ts API. Merged Phase 2b and Phase 3 `onAfterSetServer` into single callback. Deferred `updateGraphForFiles` to Phase 2b scope.
- **Trajectory:** 1 Critical (Round 1 regression, fixed). All remaining Medium. → finalize
