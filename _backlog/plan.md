# vitest-affected: Complete Implementation Plan

An open-source Vitest plugin that maintains a persistent dependency graph and uses it to run only the tests affected by your changes. Zero config — add the plugin and go.

**GitHub:** https://github.com/craigvandotcom/vitest-affected
**npm:** `vitest-affected` (unclaimed, verified)

### Why Not `vitest --changed`?

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

## Safety Invariant

vitest-affected must NEVER silently skip tests. If any component fails (graph build, git diff, BFS), the fallback is to run the full test suite and log a warning. False positives (running too many tests) are acceptable; false negatives (missing failures) are not.

**Path correctness:** All file paths used as graph keys or for set membership must be absolute and consistently normalized. Paths come from 4 sources (tinyglobby globs, git diff output, oxc-resolver results, Vitest module IDs) and can differ in case, separators (`\` vs `/`), or symlink resolution. Use `path.resolve()` everywhere; on case-insensitive filesystems, consider `fs.realpathSync()` for cache keys. If normalization fails for any path, fall back to full suite.

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

### User Experience

```typescript
// vitest.config.ts — this is ALL the user needs
import { defineConfig } from 'vitest/config'
import { vitestAffected } from 'vitest-affected'

export default defineConfig({
  plugins: [vitestAffected()],
})
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

Phase 1 options only. Phase 2 adds `cache?: boolean` (default: true). Phase 3 adds `coverage?: boolean | 'autoEnable'` (default: true = read-only, 'autoEnable' = force-enable). See each phase for details.

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

**Phase 2 exports required:** `resolveFileImports(file, source, rootDir, resolver)` → parses import specifiers from source AND resolves them to absolute paths using the provided resolver. Returns `string[]` of resolved absolute import paths. Extract single-file parse+resolve from the `buildFullGraph` loop. Also export `createResolver(rootDir)` so both `buildFullGraph` and `updateGraphForFiles` share the same resolver instance.

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
        // so we can't trace their dependents. ANY deleted file triggers full suite —
        // including .json/.css that may have been in the graph as non-source imports.
        // Phase 2 improvement: use cached graph's reverse edges for smart tracing.
        // Only trigger full suite if deleted files were in the dependency graph.
        // Files outside the graph (README, .gitkeep, etc.) are safe to ignore.
        const deletedInGraph = deleted.filter(f => forward.has(f));
        if (deletedInGraph.length > 0) {
          if (verbose) console.warn(`[vitest-affected] ${deletedInGraph.length} graph file(s) deleted — running full suite`);
          else console.warn('[vitest-affected] Deleted file(s) in dependency graph — running full suite');
          return;
        }

        // Force full run if config/infra/setup files changed.
        // Don't use vitest.config.forceRerunTriggers — its glob patterns (e.g.,
        // **/package.json/**) are designed for watch mode and may not match
        // absolute paths correctly in one-shot mode. setupFiles are technically
        // in forceRerunTriggers too, but we check them explicitly for reliability.
        const setupFileSet = new Set(project.config.setupFiles ?? []);
        const hasForceRerun = changed.some(f =>
          CONFIG_BASENAMES.has(path.basename(f)) || setupFileSet.has(f)
        );
        if (hasForceRerun) {
          console.log('[vitest-affected] Config file changed — running full suite');
          return;
        }

        // DO NOT call project.globTestFiles() here — it populates Vitest's internal
        // testFilesList cache. When Vitest later calls globTestFiles() during start(),
        // it returns the cached FULL list, ignoring the mutated config.include.
        // Instead, glob test files directly with tinyglobby (already a dependency).
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
          // Empirically verified on Vitest 3.2.4. If a future Vitest version re-globs
          // these paths, this will break — add integration test to catch regressions.
          // WARNING: Absolute paths in config.include poison matchesTestGlob() for
          // other plugins/internals. Phase 2b uses onFilterWatchedSpecification which
          // bypasses this, but Phase 1 in watch mode (which falls back to full suite
          // anyway) may cause issues if other plugins check matchesTestGlob.
          // Mutate project config (not global). We built testFileSet via
          // tinyglobby above (NOT project.globTestFiles()) to avoid populating
          // Vitest's internal cache before this mutation takes effect.
          project.config.include = validTests;
          console.log(`[vitest-affected] ${validTests.length} affected tests`);
          if (verbose) validTests.forEach(t => console.log(`  → ${path.relative(rootDir, t)}`));
        } else if (options.allowNoTests) {
          console.log('[vitest-affected] No affected tests — skipping all (allowNoTests=true)');
          project.config.include = [];
          vitest.config.passWithNoTests = true; // Prevent Vitest "No test files found" exit code 1
        } else {
          // Safety default: don't skip all tests when graph may be incomplete
          console.log('[vitest-affected] No affected tests — running full suite (set allowNoTests to skip)');
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
    // Include stderr in error message for diagnostics (e.g., "not a git repository")
    throw new Error(`${cmd} ${args.join(' ')} failed: ${err.stderr ?? err.message}`);
  }
}

async function getChangedFiles(rootDir: string, ref?: string): Promise<{ changed: string[]; deleted: string[] }> {
  // Early non-git detection — common in some CI/sandbox setups
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

  // Resolve git root FIRST for consistent path resolution
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

---

## Known Limitations (Phase 1)

- `fs.readFile` dependencies, shared global state, config file impacts, computed dynamic imports
- `vi.mock()` with factory functions: mock factories that import helpers create invisible dependencies
- **Watch mode:** Not supported. `configureVitest` runs once at startup — test set becomes stale. Deferred to Phase 2.
- **Vitest workspaces:** Not supported. Plugin detects workspace mode and falls back to full suite.
- **File renames:** Appear as deletion + addition, triggering conservative full-suite fallback.
- **Temporal mismatch:** Graph reflects current disk state, diff reflects historical changes. Rare false-negative vector eliminated by Phase 3 coverage data.
- **Nested tsconfigs:** Only root-level config filenames trigger full rerun.
- **Monorepo root mismatch:** Plugin uses `vitest.config.root` for graph building and `git rev-parse --show-toplevel` for changed files. In monorepos where vitest root is a subdirectory of the git root, the `startsWith(rootDir)` filter silently drops changed files outside vitest root — causing full-suite run (safe but wasteful). Document: plugin works best when vitest root equals git root.
- **`config.include` absolute paths:** Assigning absolute file paths to `config.include` (typed as glob patterns) works empirically on Vitest 3.2.4 but is undocumented behavior. Add integration test to catch regressions on Vitest upgrades.
- **`configureVitest` async return:** The hook is typed as `() => void` but Vite's HookHandler supports async. Verify in integration test.

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
      "size": 1234,
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

Check file mtime via `lstat`. If mtime changed, reparse. If unchanged, skip. Also compare `size` (from `lstat`) to catch edge cases where mtime granularity is coarse on some filesystems.

**Why not content hashing:** Adding xxhash-wasm to catch "touch without edit" — a scenario where the cost of a false reparse is ~0.5ms. Not worth the complexity.

#### Phase 1 Integration

`buildFullGraph(rootDir)` returns `{ forward, reverse }` without mtimes. `loadOrBuildGraph` wraps this: on cache miss, calls `buildFullGraph`, then stats all files to collect mtimes. The file list comes from `forward.keys()` — every parsed file is a key in the forward map (including leaf files with empty dependency sets).

**Required Phase 1 export:** `resolveFileImports(file, source, rootDir, resolver)` and `createResolver(rootDir)`.

### Implementation Steps (2a)

1. **Export `resolveFileImports` and `createResolver` from `builder.ts`**
2. **Implement `cache.ts`** — `loadOrBuildGraph`, `updateGraphForFiles`, `saveGraph`. Atomic writes via write-then-rename.
3. **Update `plugin.ts`** — Replace `buildFullGraph(rootDir)` with `loadOrBuildGraph(rootDir, verbose)`.
4. **Tests** — Cache round-trip, incremental updates, corrupt cache recovery, mtime invalidation.
5. **Smart deletion handling** — With a cached graph, deleted files' reverse edges are known. Instead of full-suite fallback (Phase 1 behavior), BFS from the deleted files' former dependents. Only fall back to full suite if the cached graph itself is missing (cold start). Update `plugin.ts` deleted-file branch to use `snapshot.reverse.get(deletedFile)` when cache is available.

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
      // Avoid Vitest internal testFilesList caching — use tinyglobby like Phase 1
      const testFiles = await glob(project.config.include, {
        cwd: rootDir,
        absolute: true,
        ignore: [...(project.config.exclude ?? []), '**/node_modules/**'],
      });
      testFileSet = new Set(testFiles);
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

    // Defer watcher access — vitest.server may not be initialized at configureVitest time.
    // onAfterSetServer is @internal in Vitest 3.2.4 — runtime check with fallback.
    if (typeof vitest.onAfterSetServer === 'function') {
      vitest.onAfterSetServer(() => {
        const watcher = vitest.server?.watcher;
        if (watcher) {
          for (const event of ['change', 'add', 'unlink'] as const) {
            watcher.on(event, (filePath: string) => {
              // Chokidar may emit relative or absolute paths depending on config.
              // path.resolve handles both: absolute paths pass through unchanged.
              const absPath = path.resolve(rootDir, filePath);
              enqueue(() => handleWatcherEvent(event, absPath).then(scheduleFlush));
            });
          }
        } else {
          console.warn('[vitest-affected] No file watcher — watch filtering disabled');
        }
      });
    } else {
      console.warn('[vitest-affected] onAfterSetServer not available — watch filtering disabled');
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
- **`vitest.server` at `configureVitest` time:** Not available. Watcher registration deferred to `vitest.onAfterSetServer()` callback.
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
const { testFiles } = await project.globTestFiles();
const testFileSet = new Set(testFiles);

// Merge cached coverage edges
const coverageEdges = snapshot.coverageEdges;
if (coverageEdges) {
  mergeIntoGraph(snapshot.reverse, coverageEdges);
}

// Register reporter AFTER reporters are initialized.
// onAfterSetServer is @internal — runtime check with fallback.
if (typeof vitest.onAfterSetServer === 'function') {
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
} else {
  console.warn('[vitest-affected] onAfterSetServer not available — coverage collection disabled');
}
```

### Auto-Enabling Coverage

Must happen in the **Vite `config` hook** (before Vitest's `initCoverageProvider()`):

```typescript
config(config) {
  // Auto-enable is opt-in only — avoids surprising perf/output changes.
  // Default (coverage: true) = read coverage if already enabled and provider is v8.
  if (options.coverage !== 'autoEnable') return;
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
3. **Update `plugin.ts`** — Auto-enable coverage in Vite `config` hook. Register reporter via `onAfterSetServer`. Build `testFileSet` from `project.globTestFiles()`. Merge cached edges.
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
- **`onAfterSetServer` is undocumented:** Exists in Vitest 3.2.4 runtime but absent from type definitions. Not a public API — may break on minor releases. Fallback: if unavailable, use `setTimeout(0)` to defer reporter push, or skip coverage collection with a warning. This is also why peer dep is `>=3.2.0`.
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
| `resolveFileImports(file, source, rootDir, resolver)` | `updateGraphForFiles` calls this for incremental updates |
| `createResolver(rootDir)` | Shared resolver instance across graph ops |
| `bfsAffectedTests(changed, reverse, isTestFile)` | Reused in watch mode flush |

| Phase 2 produces | Phase 3 consumes |
|---|---|
| `GraphSnapshot` with `forward`, `reverse`, `fileMtimes`, `builtAt` | Extended with `coverageEdges?`, `coverageCollectedAt?` |
| `loadOrBuildGraph` / `saveGraph` | Handles v1→v2 migration, serializes coverage edges |
| `cache.ts` disk format (version 1) | Bumped to version 2 with coverage fields |
| `project.globTestFiles()` → `testFileSet` | Reused for coverage test-vs-source classification |

---

## Refinement Log

### Round 1 (Heavy: Architect/Adversary/Devil's Advocate/Implementer/Spec Auditor/Simplifier)

- **Changes:** 11 applied (2 Critical, 6 High, 3 Medium)
- **Key fixes:** Added "Why Not --changed?" section clarifying speed (not accuracy) as primary value prop. Made Step 0 an explicit ordered sequence with build gate. Changed threshold default from 0.5 to 1.0 (disabled). Added CI cache documentation. Fixed Phase 2b watcher to use onAfterSetServer. Added monorepo root, config.include, and async hook limitations. Added smart deletion handling for Phase 2a cached graph. Bumped peer dep to >=3.2.0. Added onAfterSetServer API stability warning.
- **Consensus:** 3/6 agents flagged Step 0 ordering + config.include abs paths + peer dep version. 2/6 on deleted-file conservatism + threshold + watcher timing + monorepo root. Devil's Advocate CRITICAL on value prop mischaracterization — verified against Vitest source.
- **Trajectory:** Critical/High found → continue to Round 2

### Round 2 (Heavy: Architect/Adversary/Devil's Advocate/Implementer/Spec Auditor/Simplifier)

- **Changes:** 8 applied (2 Critical, 6 High)
- **Key fixes:** Replaced complex forceRerunTriggers logic with direct use of vitest.config.forceRerunTriggers + absolute path matching. Changed config.include mutation to project.config not vitest.config. Added exec helper spec for git.ts. Renamed parseImports → resolveFileImports to clarify it does both parse and resolve. Added npm install step in Step 0. Added runtime typeof check for onAfterSetServer in both Phase 2b and Phase 3. Added benchmark note for speed claim. Added globTestSpecifications API verification note.
- **Consensus:** 3/6 agents flagged forceRerunTriggers path semantics. 3/6 on config.include mutation target. 2/6 on Step 0 build script gap. Devil's Advocate CRITICAL on speed claim needing benchmarks. Implementer CRITICAL on globTestSpecifications availability.
- **Trajectory:** Critical/High found → continue to Round 3

### Round 3 (Heavy: Architect/Adversary/Devil's Advocate/Implementer/Spec Auditor/Simplifier)

- **Changes:** 7 applied (3 Critical, 4 High) + 5 cascading fixes (globTestFiles references)
- **Key fixes:** Replaced `project.globTestSpecifications()` with `project.globTestFiles()` (confirmed: globTestSpecifications is on Vitest, not TestProject). Fixed zero-tests branch to use `project.config.include` (was `vitest.config.include`). Reverted forceRerunTriggers to basename check + setupFiles (glob patterns designed for watch mode don't match absolute paths in one-shot). Removed SOURCE_EXT filter on deleted files (any deletion → full suite, catches .json/.css). Fixed resolveFileImports name in Phase 2a. Added .gitignore to Step 0. Added stderr capture to exec helper.
- **Consensus:** 5/6 agents flagged zero-tests config mutation. 5/6 on forceRerunTriggers glob issues. 3/6 on globTestSpecifications. 2/6 on deleted non-source files.
- **Trajectory:** Critical/High found but all are verified fixes of prior-round regressions. Round 4 needed for verification.

### Round 4 (Heavy: Architect/Adversary/Devil's Advocate/Implementer/Spec Auditor/Simplifier)

- **Changes:** 4 applied (1 Critical, 3 High)
- **Key fixes:** Replaced `project.globTestFiles()` with direct `tinyglobby` glob to avoid populating Vitest's internal cache before `config.include` mutation. Changed `setupFiles` to read from `project.config` not `vitest.config`. Corrected comment about setupFiles in forceRerunTriggers. Removed `picomatch` from Phase 1 deps (deferred to Phase 2).
- **Consensus:** 2/6 on globTestFiles caching (CRITICAL). 2/6 on setupFiles source. 3/6 agents (Implementer, Spec Auditor, Simplifier) declared plan ready to implement with only Medium issues remaining.
- **Trajectory:** 1 Critical found (globTestFiles caching) but it's a clean, verified fix. 3/6 agents say ready. → finalize
