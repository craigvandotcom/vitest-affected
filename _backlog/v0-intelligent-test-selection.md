# vitest-smart: Intelligent Test Selection for Vitest

## Vision

An open-source Vitest plugin that maintains a persistent dependency graph of your codebase and uses it to run only the tests affected by your changes. Like Wallaby.js accuracy, but open-source, zero-config, and CI-ready.

**Tagline:** "Run 80% fewer tests. Catch 99% of failures."

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
6. **Cache** — Persist graph to disk, use file content hashes for incremental updates

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
│   ├── graph/
│   │   ├── builder.ts       # oxc-parser + oxc-resolver → forward graph
│   │   ├── inverter.ts      # Forward graph → reverse graph (DONE)
│   │   └── cache.ts         # Persist to .vitest-smart/, hash-based invalidation
│   ├── git.ts               # Git diff integration (3 commands)
│   ├── selector.ts          # BFS reverse graph → affected test file list
│   └── index.ts             # Public API
├── test/
│   ├── fixtures/            # Sample projects with known dependency structures
│   │   ├── simple/          # Linear A→B→C chain
│   │   ├── diamond/         # Diamond dependency pattern
│   │   └── circular/        # Circular import handling
│   └── *.test.ts
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

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
for (const exp of mod.staticExports) {
  for (const entry of exp.entries) {
    if (entry.moduleRequest) {
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

### Vitest Plugin Architecture

Two separate mechanisms needed for filtering tests:

```typescript
/// <reference types="vitest/config" />
import type { Plugin } from 'vite';

export interface VitestSmartOptions {
  disabled?: boolean;
  ref?: string;  // git ref to diff against (default: auto-detect)
}

export function vitestSmart(options: VitestSmartOptions = {}): Plugin {
  return {
    name: 'vitest:smart',

    async configureVitest({ vitest, project }) {
      if (options.disabled) return;

      const graph = await loadOrBuildGraph(vitest.config.root);
      const changedFiles = await getChangedFiles(vitest.config.root, options.ref);
      const affectedTests = bfsAffectedTests(changedFiles, graph.reverse);

      // ONE-SHOT MODE (vitest run): mutate config.include before start() globs
      // configureVitest runs during _setServer(), before start() — mutations here
      // affect which files globTestSpecifications() finds
      if (affectedTests.size > 0) {
        vitest.config.include = [...affectedTests];
      }

      // WATCH MODE: filter which specs to rerun on file change
      vitest.onFilterWatchedSpecification((spec) => {
        return affectedTests.has(spec.moduleId);
      });
    }
  };
}
```

**Key timing:** `configureVitest` runs during `_setServer()`, called before `start()`. Mutating `vitest.config.include` here affects the initial `globTestSpecifications()` call. `onFilterWatchedSpecification` is watch-mode only.

### Git Diff Integration

Three commands needed for full coverage (same approach as Vitest's own implementation):

```typescript
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

async function getChangedFiles(rootDir: string, ref?: string): Promise<string[]> {
  const run = async (args: string[]) => {
    const { stdout } = await exec('git', args, { cwd: rootDir });
    return stdout.split('\n').filter(Boolean);
  };

  const [committed, staged, unstaged] = await Promise.all([
    ref ? run(['diff', '--name-only', '--diff-filter=ACMR', `${ref}...HEAD`]) : [],
    run(['diff', '--cached', '--name-only', '--diff-filter=ACMR']),
    run(['ls-files', '--others', '--modified', '--exclude-standard']),
  ]);

  const { stdout: gitRoot } = await exec('git', ['rev-parse', '--show-toplevel'], { cwd: rootDir });

  return [...new Set([...committed, ...staged, ...unstaged])]
    .map(f => path.resolve(gitRoot.trim(), f));  // Resolve to absolute paths
}
```

**Gotchas:**
- `--name-only` output is relative to git root, not cwd — always resolve with `git rev-parse --show-toplevel`
- `--diff-filter=ACMR` excludes deletions (no graph entry to look up)
- `ref...HEAD` (three dots) = merge-base comparison (what diverged since branching) — correct for CI
- Newly created files only appear in `git ls-files --others` — need all three commands
- No external dependencies needed — `child_process.execFile` is sufficient (avoids `execa` dep)

---

## Phased Roadmap

### Phase 1: Static Import Graph (MVP)

**Effort:** ~500-1000 lines
**Accuracy:** ~80% (catches all static import-chain dependencies)

**Implementation Steps:**

1. **`graph/builder.ts`** — Glob all source files, parse each with `oxc-parser`, resolve specifiers with `oxc-resolver`, build forward graph `Map<string, Set<string>>`
2. **`graph/inverter.ts`** — Invert forward graph to reverse graph (DONE — already implemented)
3. **`graph/cache.ts`** — Persist graph + file hashes to `.vitest-smart/graph.json`. On rebuild, only re-parse files whose content hash changed.
4. **`git.ts`** — Get changed files from git (3 commands: committed, staged, unstaged)
5. **`selector.ts`** — BFS the reverse graph from changed files, collect affected test files (match `*.test.*` / `*.spec.*`)
6. **`plugin.ts`** — Wire everything together in `configureVitest` hook
7. **`index.ts`** — Export plugin function + standalone API
8. **Fixture tests** — Small projects with known dependency structures to verify graph correctness

**Type-only imports:** oxc-parser provides `imp.t` boolean — we skip these since they create no runtime dependency. This improves accuracy over naive parsing.

**Dynamic imports:** Captured by `module.dynamicImports` — included in graph when specifier is a string literal. Computed specifiers (`import(variable)`) are ignored (Phase 2 handles via coverage).

**Misses:** `fs.readFile` dependencies, shared global state, config file impacts, computed dynamic imports.

### Phase 2: Coverage-Enhanced Selection

**Effort:** Weeks
**Accuracy:** ~95%

- During test runs, collect V8 coverage per test suite
- Record which source files each test suite actually executes
- Merge coverage map with static graph (union = most complete picture)
- Dynamic imports and runtime deps now captured

### Phase 3: Symbol-Level Tracking

**Effort:** Longer-term
**Accuracy:** ~99%

- Use oxc-parser's full AST (already available — no new parser needed)
- Track which specific exports each test uses
- If only `functionA` changed in a file, skip tests that only import `functionB`
- This is Wallaby-level precision, open-source

### Phase 4 (Aspirational): Predictive Selection

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
- The cached graph ships as `.vitest-smart/` in the repo (gitignored in consumer projects)
- CI rebuilds from scratch on first run, uses cache on subsequent runs
- Cache key: hash of all source file content hashes

---

## Package Changes Needed

```json
{
  "dependencies": {
    "oxc-parser": "^0.114.0",
    "oxc-resolver": "^6.0.0"
  }
}
```

Remove `es-module-lexer` — replaced by `oxc-parser`.

Add new source file: `src/git.ts` — git diff integration.

---

## Portfolio Positioning

**What makes this stand out:**
- Solves a real, unsolved problem in the OSS ecosystem (verified: zero npm competitors)
- Built on the OXC Rust toolchain (oxc-parser + oxc-resolver) — fastest available
- Small surface area — plugin, not a full test runner
- Clear, measurable value proposition
- Type-only import filtering improves accuracy over naive approaches
- Natural growth path from static graph → coverage → symbol-level → ML
- Phase 3 needs zero parser change — oxc-parser's full AST is already available

**npm name:** `vitest-smart` (unclaimed, verified)
