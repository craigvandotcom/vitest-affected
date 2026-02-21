# vitest-smart: Intelligent Test Selection for Vitest

## Vision

An open-source Vitest plugin that maintains a persistent dependency graph of your codebase and uses it to run only the tests affected by your changes. Like Wallaby.js accuracy, but open-source, zero-config, and CI-ready.

**Tagline:** "Run only the tests that matter."

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

**No open-source Vitest plugin for file-level intelligent test selection exists.** (Confirmed: npm search returns zero results for vitest-affected, vitest-related, vitest-tia, vitest-impact.)

### Why `vitest --changed` Falls Short (Verified)

Vitest's `--changed` implementation (`packages/vitest/src/node/git.ts`) has three fundamental problems:

1. **Runtime graph only** — The Vite module graph doesn't exist before tests start. It's populated as Vite transforms modules during the run. So `--changed` cannot pre-filter — it still starts all test workers, then checks.
2. **No persistence** — The graph is in-memory per process. Every run starts from scratch.
3. **Forward-only traversal** — `getTestDependencies()` walks forward (test → imports → their imports) and checks if any changed file appears. This is O(test_count × graph_depth). A pre-built reverse graph inverts this to O(changed_files × graph_depth).
4. **Bug: misses changed test files** — If a test file itself is modified (not a source file it imports), `--changed` does NOT run it (vitest issue #1113).

---

## How It Works

### Core Algorithm

1. **Parse** — Extract all import/export specifiers from every source file using `oxc-parser`
2. **Resolve** — Turn specifiers into absolute file paths using `oxc-resolver`
3. **Build forward graph** — `file → [files it imports]`
4. **Invert** — `file → [files that import it]` (reverse adjacency list)
5. **Query** — Given `git diff` changed files, BFS the reverse graph to find all affected test files
6. **Cache** (Phase 2) — v0 always rebuilds (~166ms for 433 files). Caching with mtime+hash invalidation added in Phase 2 when profiling shows need

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

### BFS vs Jest's Approach

Jest's `resolveInverseModuleMap` scans the *entire* haste-map filesystem at every BFS level — O(V × depth). Our pre-built reverse adjacency list makes BFS O(V + E), strictly better for large codebases. Circular dependencies handled by a `visited` set (same as Jest's `visitedModules`).

---

## Technical Architecture

```
vitest-smart/
├── src/
│   ├── plugin.ts            # Vitest configureVitest hook (entry point)
│   ├── index.ts             # Public API: exports only vitestSmart()
│   ├── graph/
│   │   ├── builder.ts       # oxc-parser + oxc-resolver → forward graph (Map<string, Set<string>>)
│   │   └── inverter.ts      # Forward graph → reverse graph (DONE)
│   ├── git.ts               # Git diff integration (3 commands)
│   └── selector.ts          # Pure BFS: (changedFiles, reverse, isTestFile) → affected tests
├── test/
│   ├── fixtures/            # Sample projects with known dependency structures
│   │   ├── simple/          # Linear A→B→C chain
│   │   ├── diamond/         # Diamond dependency pattern
│   │   └── circular/        # Circular import handling
│   └── *.test.ts
├── package.json
├── tsconfig.json
├── tsup.config.ts           # Build config (dual ESM+CJS output)
└── vitest.config.ts
```

> **EMPIRICALLY VERIFIED (2026-02-21):** Mutating `vitest.config.include` inside the `configureVitest` hook DOES filter which test files run. Tested with absolute paths, glob patterns, and empty arrays on Vitest 3.2.4. This means vitest-smart is a **standard Vitest plugin** — no CLI wrapper needed. Users just add it to `vitest.config.ts` and run `npx vitest` as normal. IDE integrations, CI scripts, and the entire Vitest ecosystem work unchanged.

### Core Dependencies

| Package | Purpose | Why this one |
|---|---|---|
| `oxc-parser` | Parse imports from TS/JS/TSX/JSX files | Handles TypeScript natively, 8x faster than esbuild.transformSync. `result.module` gives pre-extracted imports with zero AST walking. Full AST ready for Phase 3. Used by Rolldown/Vite 8. |
| `oxc-resolver` | Resolve specifiers to file paths | 28x faster than enhanced-resolve, handles TS aliases, tsconfig paths, project references. Same OXC ecosystem as parser. |

**Why not esbuild + es-module-lexer?** esbuild is already in every Vitest project's tree (free), but the two-step pipeline (transform → lex) is 8x slower (813ms vs 100ms for 433 files). Both stacks are fast enough for real use, but oxc-parser also provides the full AST needed for Phase 3 — esbuild doesn't expose AST.

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

Import stats: 1499 total, 106 type-only, 879 local, 488 external, 2 errors
Resolution: 99.9% success with tsconfig configured
```

### Verified API Patterns (Tested Against Real Code)

#### oxc-parser — Import Extraction

```typescript
import { parseSync } from 'oxc-parser';

const { module: mod, errors } = parseSync(filePath, sourceCode);
// filePath extension drives language detection (.ts, .tsx, .jsx, .js)

const specifiers: string[] = [];

// Static imports — imp.moduleRequest.value = specifier string
for (const imp of mod.staticImports) {
  // Check if ALL entries are type-only (no runtime dependency)
  if (imp.entries.every(e => e.isType)) continue;
  specifiers.push(imp.moduleRequest.value);
}

// Dynamic imports — no .value field, must slice source code
// Only string literals are useful (computed expressions can't be resolved statically)
for (const imp of mod.dynamicImports) {
  const raw = sourceCode.slice(imp.moduleRequest.start, imp.moduleRequest.end);
  // Check if it's a string literal (starts with ' or ")
  if (raw.startsWith("'") || raw.startsWith('"')) {
    specifiers.push(raw.slice(1, -1));  // Strip quotes
  }
}

// Re-exports — these are in staticExports, NOT staticImports
// export { foo } from './bar'  →  entries[].moduleRequest.value
// export * from './baz'        →  entries[].moduleRequest.value
// NOTE: filter type-only re-exports (export type { Foo } from './bar') same as imports
for (const exp of mod.staticExports) {
  for (const entry of exp.entries) {
    if (entry.moduleRequest && !entry.isType) {
      specifiers.push(entry.moduleRequest.value);
    }
  }
}
```

**Key API differences from es-module-lexer (research was wrong about field names):**
- Specifier: `imp.moduleRequest.value` (NOT `imp.n`)
- Type-only: `imp.entries[].isType` (NOT `imp.t`)
- Re-exports: in `staticExports`, NOT `staticImports`
- Dynamic imports: no `.value` — slice source code with `.start`/`.end`

#### oxc-resolver — Path Resolution

```typescript
import { ResolverFactory } from 'oxc-resolver';
import path from 'node:path';

const resolver = new ResolverFactory({
  extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
  conditionNames: ['node', 'import'],
  tsconfig: {
    configFile: path.join(projectRoot, 'tsconfig.json'),
    references: 'auto',  // follow project references
  },
  builtinModules: true,
});

// CRITICAL: context is DIRECTORY, not file path
const result = resolver.sync(path.dirname(importingFile), specifier);

// Builtins return { error: "Builtin module node:path" } — NOT a .builtin field
if (result.error) return null;   // Builtin, external package, or unresolvable
return result.path;              // Absolute resolved path
```

**Gotchas (verified):**
- `resolver.sync()` takes the *directory* of the importing file, NOT the file itself
- Builtins return `{ error: "Builtin module ..." }` regardless of `builtinModules` flag
- npm packages resolve to absolute paths into `node_modules/` — filter these for the graph
- `result.path` is always absolute
- `result.moduleType` and `result.packageJsonPath` also available on success
- **tsconfig MUST be configured** — without it, `@/` path aliases fail (739/741 errors in testing)

### Integration Architecture: Vitest Plugin via `configureVitest`

> **VERIFIED EMPIRICALLY (2026-02-21):** The `configureVitest` hook CAN filter the test file list by mutating `vitest.config.include`. Earlier web research incorrectly stated this was impossible. Tested on Vitest 3.2.4 with absolute paths, globs, and empty arrays — all work as expected. This overrides Decision 6 in `v0-decisions.md`.

```typescript
/// <reference types="vitest/config" />
import type { Plugin } from 'vite';

export interface VitestSmartOptions {
  disabled?: boolean;
  ref?: string;  // git ref to diff against (default: auto-detect)
}

// Files that affect all tests but are invisible to static import analysis.
// If any of these change, skip smart selection and run the full suite.
const FORCE_RERUN_FILES = [
  'vitest.config.ts', 'vitest.config.js', 'vitest.config.mts',
  'tsconfig.json', 'package.json',
];

export function vitestSmart(options: VitestSmartOptions = {}): Plugin {
  return {
    name: 'vitest:smart',

    async configureVitest({ vitest }) {
      if (options.disabled) return;

      // Guard: workspace mode not supported in v0
      if (vitest.projects && vitest.projects.length > 1) {
        console.warn('[vitest-smart] Vitest workspaces not yet supported — running full suite');
        return;
      }

      try {
        const rootDir = vitest.config.root;

        // Build graph inline (v0: always rebuild, ~166ms for 433 files)
        // Extract to loader.ts when Phase 2 caching is added
        const forward = await buildFullGraph(rootDir);
        const reverse = invertGraph(forward);

        const { changed, deleted } = await getChangedFiles(rootDir, options.ref);

        // Deleted files that are graph nodes → run full suite (safety invariant)
        // Only graph members can cause false negatives; deleted docs/logs are harmless
        const deletedGraphNodes = deleted.filter(f => forward.has(f) || reverse.has(f));
        if (deletedGraphNodes.length > 0) {
          console.warn(`[vitest-smart] ${deletedGraphNodes.length} graph node(s) deleted — running full suite`);
          return;
        }

        // Force full run if config/infra files changed
        const hasForceRerun = changed.some(f =>
          FORCE_RERUN_FILES.some(trigger => f.endsWith('/' + trigger))
        );
        if (hasForceRerun) {
          console.log('[vitest-smart] Config file changed — running full suite');
          return;
        }

        // Test file detection via picomatch against Vitest's config.include patterns
        const picomatch = await import('picomatch');  // declared as dependency (3KB, zero cost)
        const isTestFile = picomatch.default(vitest.config.include, { cwd: rootDir });
        const affectedTests = bfsAffectedTests(changed, reverse, isTestFile);

        if (affectedTests.length > 0) {
          vitest.config.include = affectedTests;
          console.log(`[vitest-smart] ${affectedTests.length} affected tests`);
        } else {
          console.log('[vitest-smart] No affected tests — skipping all tests');
          vitest.config.include = [];
        }
      } catch (err) {
        // GRACEFUL FALLBACK: if anything fails, run all tests
        console.warn('[vitest-smart] Error — running full suite:', err);
      }
    }
  };
}
```

**v0 supports one-shot mode only (`vitest run`).** Mutates `vitest.config.include` to absolute paths of affected tests. Watch mode support deferred to Phase 2 — requires live graph updates on file change events (see Phase 2 section).

**User experience — zero friction:**
```typescript
// vitest.config.ts — this is ALL the user needs to add
import { defineConfig } from 'vitest/config'
import { vitestSmart } from 'vitest-smart'

export default defineConfig({
  plugins: [vitestSmart()],
})
```

Then just run `npx vitest` as normal. IDE integrations, CI scripts, reporters — everything works unchanged.

### Git Diff Integration

Three commands needed for full coverage (same approach as Vitest's own implementation):

```typescript
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

async function getChangedFiles(rootDir: string, ref?: string): Promise<{ changed: string[]; deleted: string[] }> {
  const run = async (args: string[]) => {
    const { stdout } = await exec('git', args, { cwd: rootDir });
    return stdout.split('\n').filter(Boolean);
  };

  const [committed, staged, unstaged] = await Promise.all([
    ref ? run(['diff', '--name-only', '--diff-filter=ACMR', `${ref}...HEAD`]) : [],
    run(['diff', '--cached', '--name-only', '--diff-filter=ACMR']),
    // --others: new untracked files, --modified: changed but unstaged
    // NOTE: --modified can include deleted files, so we filter by existence below
    run(['ls-files', '--others', '--modified', '--exclude-standard']),
  ]);

  const { stdout: gitRoot } = await exec('git', ['rev-parse', '--show-toplevel'], { cwd: rootDir });

  const allFiles = [...new Set([...committed, ...staged, ...unstaged])]
    .map(f => path.resolve(gitRoot.trim(), f));

  const { existsSync } = await import('node:fs');
  const existing = allFiles.filter(f => existsSync(f));
  const deleted = allFiles.filter(f => !existsSync(f));

  // Return both — plugin checks deleted against graph to decide fallback
  return { changed: existing, deleted };
}
```

**Gotchas:**
- `--name-only` output is relative to git root, not cwd — always resolve with `git rev-parse --show-toplevel`
- `--diff-filter=ACMR` excludes deletions (no graph entry to look up)
- `ref...HEAD` (three dots) = merge-base comparison (what diverged since branching) — correct for CI
- Newly created files only appear in `git ls-files --others` — need all three commands
- No external dependencies needed — `child_process.execFile` is sufficient (avoids `execa` dep)
- **CI shallow clones:** `git diff --merge-base` requires commit history. GitHub Actions defaults to `fetch-depth: 1` which will fail. Document this requirement:

```yaml
# GitHub Actions — required for vitest-smart in CI
- uses: actions/checkout@v4
  with:
    fetch-depth: 0  # Full history needed for merge-base diff
```

If `fetch-depth: 0` is too slow for large repos, `fetch-depth: 50` is usually sufficient. vitest-smart should detect shallow clones and warn with a helpful message.

---

## Phased Roadmap

### Phase 1: Static Import Graph (MVP)

**Effort:** ~500-1000 lines
**Accuracy:** Covers all static import-chain dependencies (exact accuracy TBD via fixture tests and real-world validation against body-compass-app)

**Implementation Steps (test-first order):**

0. **Project scaffolding + stub cleanup** — The existing code stubs are from pre-refinement and contradict the plan. Before feature work:
   - **Delete:** `src/graph/cache.ts` (caching deferred to Phase 2)
   - **Rewrite:** `src/graph/builder.ts` → export `buildFullGraph(rootDir)` returning `Map<string, Set<string>>` (forward only, not `DependencyGraph` with forward+reverse)
   - **Rewrite:** `src/selector.ts` → pure `bfsAffectedTests` function (remove `SelectionResult`, `getAffectedTests`)
   - **Rewrite:** `src/index.ts` → single export `vitestSmart` (remove all other exports)
   - **Rewrite:** `src/plugin.ts` → remove `verify` option and `onFilterWatchedSpecification` references; orchestration (build → invert → BFS) lives here
   - **Rewrite:** `src/git.ts` → return `{ changed: string[]; deleted: string[] }` (not flat `string[]`)
   - **Update:** `package.json` → peer dep `>=3.1.0`, remove `xxhash-wasm`, add `picomatch` to deps, add `tsup` to devDeps, update build script to `tsup`
   - **Create:** root `vitest.config.ts` and `tsup.config.ts` (dual ESM+CJS output)
1. **Fixture tests** — Create small projects with known dependency structures FIRST. These define the contract. Include: `simple/` (linear A→B→C), `diamond/` (A→B→C, A→D→C), `circular/` (A→B→A). Write failing tests that assert expected graph shapes and affected test sets.
2. **`graph/builder.ts`** — Glob source files using `**/*.{ts,tsx,js,jsx,mts,mjs,cts,cjs}` (exclude `node_modules/`, `dist/`, `.vitest-smart/`, `test/fixtures/`, `coverage/`, `.next/`). Parse each with `oxc-parser`, resolve specifiers with `oxc-resolver`, build forward graph `Map<string, Set<string>>`. When a parsed file imports a non-source file (e.g., `import data from './data.json'`), the resolved path is added as a forward-graph key with an empty dependency set — this ensures the inverter creates a reverse edge so BFS can trace dependents of that `.json`/`.css` file. Exports `buildFullGraph(rootDir)` returning the forward map. **Important:** the glob MUST include test files (they import source files and are BFS targets). Use `tinyglobby` (already in vitest's dep tree) for globbing.
3. **`graph/inverter.ts`** — Invert forward graph to reverse graph (DONE — already implemented)
4. **Orchestration lives in `plugin.ts`** — Build graph → invert → BFS is 3 lines of glue, inlined in the plugin's `configureVitest` hook. No separate orchestrator file in v0. Extract to `graph/loader.ts` when Phase 2 caching materializes.
5. **`git.ts`** — Get changed files from git (3 commands: committed, staged, unstaged). Filter deleted files by existence check (see pseudocode above).
6. **`selector.ts`** — Pure BFS function with no IO or orchestration:

```typescript
// selector.ts — pure algorithm, no side effects
export function bfsAffectedTests(
  changedFiles: string[],
  reverse: Map<string, Set<string>>,
  isTestFile: (path: string) => boolean
): string[] {
  const visited = new Set<string>();
  const queue = [...changedFiles];
  const affectedTests: string[] = [];

  // BFS seeds include changedFiles directly, so changed test files
  // are always captured (fixes vitest #1113 — no separate pass needed)
  while (queue.length > 0) {
    const file = queue.shift()!;
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

  return affectedTests;
}
```

7. **`plugin.ts`** — Wire everything together in `configureVitest` hook. One-shot mode only in v0: mutate `config.include` with affected test paths. Includes workspace guard and force-rerun check for config files. Graceful fallback: on error, don't modify config (runs full suite).
8. **`index.ts`** — Export only the plugin function: `export { vitestSmart } from './plugin'`. Internal functions stay unexported — no public API surface to maintain until there are real consumers.

**Safety invariant:** vitest-smart must NEVER silently skip tests. If any component fails (graph build, git diff, BFS), the fallback is to run the full test suite and log a warning. False positives (running too many tests) are acceptable; false negatives (missing failures) are not.

**Force rerun triggers:** Changes to `vitest.config.*`, `tsconfig.json`, or `package.json` trigger a full test run regardless of graph analysis. Hardcoded as a const array in `plugin.ts` — no user-facing config option in v0.

**Type-only imports:** oxc-parser provides `imp.entries[].isType` — if ALL entries are type-only, we skip the import since it creates no runtime dependency. Same filtering applies to `staticExports` re-exports (`entry.isType`). This improves accuracy over naive parsing.

**Dynamic imports:** Captured by `module.dynamicImports` — included in graph when specifier is a string literal. Computed specifiers (`import(variable)`) are ignored (Phase 2 handles via coverage).

**Known limitations (Phase 1):**
- `fs.readFile` dependencies, shared global state, config file impacts, computed dynamic imports
- `vi.mock()` with factory functions: mock factories that import helpers create invisible dependencies. The graph may over-select (running tests where mock fully replaces the module) or under-select (missing changes to mock factory helpers). Over-selection is acceptable per the safety invariant; under-selection from mock factory deps is a known edge case.
- **Watch mode:** Not supported in v0. `configureVitest` runs once at startup — the affected test set would be stale after subsequent edits. Watch mode requires live graph updates on file change events (deferred to Phase 2).
- **Vitest workspaces:** Not supported in v0. Plugin detects workspace mode and falls back to full suite with a warning.
- **Temporal mismatch:** The graph reflects the *current* disk state, but the diff reflects *historical* changes. If an import edge was removed in the current change, the graph has no edge, so BFS cannot find affected tests from the old import. In practice this is rare (the test itself usually changes too, triggering a direct match), but it's a theoretical false-negative vector. Phase 3 coverage data eliminates this.

### Phase 2: Watch Mode + Verify + Caching

**Effort:** Days-weeks

- **Watch mode:** Hook into Vite's file watcher events, incrementally update the graph for changed files, recompute affected tests per trigger via `onFilterWatchedSpecification`
- **`verify` mode:** Run affected tests first, then full suite, compare results to measure real accuracy. Requires post-run reporter hook to capture per-run results.
- **Graph caching:** Persist graph to `.vitest-smart/graph.json` with mtime+hash hybrid invalidation (Decision 4). Only add caching if profiling shows startup latency matters on 2000+ file projects.
- **`xxhash-wasm`** dependency added here (not in v0) for fast content hashing

### Phase 3: Coverage-Enhanced Selection

**Effort:** Weeks
**Accuracy:** ~95%

- During test runs, collect V8 coverage per test suite
- Record which source files each test suite actually executes
- Merge coverage map with static graph (union = most complete picture)
- Dynamic imports and runtime deps now captured

### Phase 4: Symbol-Level Tracking

**Effort:** Longer-term
**Accuracy:** ~99%

- Use oxc-parser's full AST (already available — no new parser needed)
- Track which specific exports each test uses
- If only `functionA` changed in a file, skip tests that only import `functionB`
- This is Wallaby-level precision, open-source

### Phase 5 (Aspirational): Predictive Selection

- ML model trained on historical test results (a la Meta's approach)
- Predicts which tests are most likely to fail for a given diff
- Requires CI integration and training data pipeline

---

## Prior Art & Research Findings

### Algorithms
- **Jest `resolveInverseModuleMap`** — BFS with 3 sets: `changed`, `relatedPaths`, `visitedModules`. Scans entire haste-map per BFS level (O(V × depth)). Our reverse adjacency list approach is O(V + E). [Deep-dive](https://thesametech.com/under-the-hood-jest-related-tests/)
- **Martin Fowler's TIA taxonomy** — coverage-based vs graph-based vs predictive. [Article](https://martinfowler.com/articles/rise-test-impact-analysis.html)
- **Meta Predictive Test Selection** — ML approach, 2x CI cost reduction. [Paper](https://arxiv.org/abs/1810.05286)

### Evaluated & Rejected

| Tool | Reason for rejection |
|---|---|
| `dependency-cruiser` | No incremental update API — full scan on every call. 10-50x slower than oxc-parser + caching. |
| `skott` | TS-native but no incremental update, no Vitest integration. |
| `madge` | Broken on TS 5.4+. |
| `Knip` | Uses oxc-resolver internally but does not expose graph traversal API. |
| `es-module-lexer` | Cannot parse TypeScript files — requires esbuild pre-transform. oxc-parser is single-step and provides full AST for Phase 3. |

### Chosen Stack

| Tool | Role |
|---|---|
| `oxc-parser` | Parse imports from TS/JS/TSX/JSX — `result.module` API, type-only import detection |
| `oxc-resolver` | Resolve specifiers to absolute file paths — tsconfig paths, project references |
| `child_process.execFile` | Git diff — no external dependency needed |

### Fast Parsers (Reference)
- **oxc-parser** — full Rust parser, 3x faster than SWC, TS-native. [GitHub](https://github.com/oxc-project/oxc)
- **es-module-lexer** — 4KiB WASM, ~5ms/MB, ESM-only (no TS). [GitHub](https://github.com/guybedford/es-module-lexer)
- **oxc-resolver** — Rust, 28x faster than enhanced-resolve. [GitHub](https://github.com/oxc-project/oxc-resolver)
- **tree-sitter** — incremental parsing, symbol-level. [GitHub](https://github.com/tree-sitter/tree-sitter)

### Commercial Competitors
- **Wallaby.js** — static + dynamic analysis, IDE plugin, commercial. [Site](https://wallabyjs.com/)
- **Datadog TIA** — coverage-per-suite, SaaS. [Docs](https://docs.datadoghq.com/tests/test_impact_analysis/setup/javascript/)
- **Launchable/CloudBees** — ML-based predictive, commercial. [Site](https://www.launchableinc.com/predictive-test-selection/)

---

## Vitest Integration Points

### What Vitest already provides
- `vitest --changed` — git-diff-based, uses runtime Vite module graph (forward-only, non-persistent)
- `vitest related <files>` — manual file list, uses same runtime module graph
- `forceRerunTriggers` — glob patterns for "rerun everything" files
- `configureVitest` plugin hook (v3.1+) — our primary extension point

### What Vitest's approach misses
- No persistent graph between runs (Vite module graph is runtime-only)
- No incremental updates (rebuilds from scratch each time)
- No reverse-dependency lookup (forward-only traversal)
- Changed test files not detected (issue #1113)
- Dynamic imports, `require()`, config files invisible to module graph

### Plugin Hook Details (Verified)

```typescript
// vitest/config augments Vite's Plugin interface:
declare module "vite" {
  interface Plugin<A = any> {
    configureVitest?: HookHandler<(context: VitestPluginContext) => void>;
  }
}

interface VitestPluginContext {
  vitest: Vitest;
  project: TestProject;
  injectTestProjects: (config: TestProjectConfiguration | TestProjectConfiguration[]) => Promise<TestProject[]>;
}
```

**Filtering APIs on Vitest instance:**

| Method | Purpose | Mode |
|---|---|---|
| `onFilterWatchedSpecification(fn)` | Filter which specs rerun on file change | Watch only |
| `globTestSpecifications(filters?)` | Get all test specs (respects config.include) | Both |
| `runTestSpecifications(specs)` | Run a specific set of specs | Both |
| `config.include` / `config.exclude` | Mutable string[] — affects globbing | Both |

**TestSpecification properties:**
- `spec.moduleId` — absolute file path (the key for our Set lookups)
- `spec.project` — which TestProject this belongs to
- `spec.pool` — worker pool ('forks', 'threads', etc.)

---

## Development Strategy

### Local Development Against Body Compass
```bash
# In vitest-smart/
npm link

# In body-compass-app/
npm link vitest-smart
```

Or in body-compass-app's `package.json`:
```json
"vitest-smart": "file:../vitest-smart"
```

Live-reload during development. Edit plugin, run tests in body-compass-app, see results.

### Testing the Plugin Itself
- Fixture-based tests: small sample projects with known dependency structures
- Verify graph correctness against known dependency chains
- Test edge cases: circular imports, re-exports, dynamic imports, type-only imports
- Benchmark parse + resolve times on real-world project sizes

### CI Strategy
- v0: graph rebuilds on every run (~166ms, negligible vs test execution time)
- Phase 2: cached graph in `.vitest-smart/` (gitignored), cache key based on file content hashes
- Requires `fetch-depth: 0` (or ≥50) in GitHub Actions for merge-base diff

---

## Package Changes Needed

```json
{
  "dependencies": {
    "oxc-parser": "^0.114.0",
    "oxc-resolver": "^6.0.0",
    "picomatch": "^4.0.0"
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

**Peer dep note:** `configureVitest` hook requires Vitest >=3.1. Vitest 4.0 is current stable (4.0.18, Dec 2025) — test against both 3.2.x and 4.0.x. No `xxhash-wasm` in v0 — caching deferred to Phase 2.

Remove `es-module-lexer` — replaced by `oxc-parser`.

Add new source file: `src/git.ts` (git diff with deleted file detection).

---

## Portfolio Positioning

**What makes this stand out:**
- Solves a real, unsolved problem in the OSS ecosystem (verified: zero npm competitors)
- Built on the OXC Rust toolchain (oxc-parser + oxc-resolver) — fastest available
- Small surface area — plugin, not a full test runner
- Clear, measurable value proposition
- Type-only import filtering improves accuracy over naive approaches
- Natural growth path from static graph → watch+cache → coverage → symbol-level → ML
- Phase 4 needs zero parser change — oxc-parser's full AST is already available

**npm name:** `vitest-smart` (unclaimed, verified)

---

## Refinement Log

### Round 1 (Heavy: Architect/Adversary/Devil's Advocate/Implementer/Spec Auditor/Simplifier)

- **Changes:** 11 applied (3 Critical, 4 High, 4 Medium)
- **Key fixes:** Scoped watch mode out of v0 (broken by design — stale snapshot), added `loadOrBuildGraph` orchestrator spec, simplified to always-rebuild (no caching in v0), replaced selector god-function with pure BFS, deferred verify mode to Phase 2
- **Consensus:** Watch mode stale snapshot flagged by 3/6 agents (strongest signal). Cache schema mismatch flagged by 5/6. Selector API wrong flagged by 4/6. Simplifier + Devil's Advocate agreed: cache + verify are premature for v0.
- **Trajectory:** Critical/High issues found -> continue to Round 2 for verification

### Round 2 (Heavy: Architect/Adversary/Devil's Advocate/Implementer/Spec Auditor/Simplifier)

- **Changes:** 4 applied (1 Critical, 2 High, 1 Medium)
- **Key fixes:** Deleted files now trigger full suite fallback (was silently dropping them), Step 0 expanded with explicit stub cleanup list, matchesTestGlob gets runtime check + glob-based fallback, temporal mismatch documented as known limitation
- **Consensus:** Deleted file false negative flagged by 3/6. Stale code stubs flagged by 6/6 (plan text was correct, code stubs needed cleanup call-out). matchesTestGlob unverified flagged by 2/6.
- **Trajectory:** Critical issue found (deleted files) -> continue to Round 3 for verification

### Round 3 (Heavy: Architect/Adversary/Devil's Advocate/Implementer/Spec Auditor/Simplifier)

- **Changes:** 4 applied (0 Critical, 3 High, 1 Medium)
- **Key fixes:** Removed dead BFS post-loop (4/6 consensus), scoped deleted-file fallback to graph members only (was over-aggressive), inlined loader.ts into plugin.ts (3-line glue doesn't need its own file), simplified test detection to picomatch-only (dropped unverified matchesTestGlob speculation), added builder.ts to Step 0 cleanup, expanded builder glob exclusions
- **Consensus:** Dead BFS code flagged by 4/6 (strongest signal). loader.ts trivial flagged by 3/6. Test detection simplification flagged by 3/6. All Simplifier cuts aligned with practical implementer concerns.
- **Trajectory:** No Critical issues. High issues found -> continue to Round 4 for final verification

### Round 4 (Heavy: Architect/Adversary/Devil's Advocate/Implementer/Spec Auditor/Simplifier)

- **Changes:** 4 minor cleanup (0 Critical, 0 High after analysis)
- **Key fixes:** Declared picomatch as explicit dependency (not transient), added git.ts to Step 0 rewrite list, removed stale loader.ts reference, noted builder must include test files in glob
- **Consensus:** 6/6 agents declared plan implementation-ready. Remaining "High" items were execution gaps (stale code stubs, package.json) not plan design issues. All agents said "ship it."
- **Trajectory:** CONVERGED — finalize
