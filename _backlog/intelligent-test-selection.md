# vitest-affected: Intelligent Test Selection for Vitest

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
vitest-affected/
├── src/
│   ├── plugin.ts            # Vitest configureVitest hook (entry point)
│   ├── index.ts             # Public API: exports only vitestAffected()
│   ├── graph/
│   │   └── builder.ts       # oxc-parser + oxc-resolver → forward + reverse graph
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

> **EMPIRICALLY VERIFIED (2026-02-21):** Mutating `vitest.config.include` inside the `configureVitest` hook DOES filter which test files run. Tested with absolute paths, glob patterns, and empty arrays on Vitest 3.2.4. This means vitest-affected is a **standard Vitest plugin** — no CLI wrapper needed. Users just add it to `vitest.config.ts` and run `npx vitest` as normal. IDE integrations, CI scripts, and the entire Vitest ecosystem work unchanged.

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

// Binary assets that cannot meaningfully affect test behavior — skip before resolver
// NOTE: .css/.json are NOT skipped — they are recorded as leaf nodes (no outgoing edges)
// so BFS can trace dependents when these files change
const BINARY_ASSET_EXT = /\.(svg|png|jpg|jpeg|gif|webp|woff2?|eot|ttf|ico)$/i;

// Static imports — imp.moduleRequest.value = specifier string
for (const imp of mod.staticImports) {
  // Check if ALL entries are type-only (no runtime dependency)
  // IMPORTANT: side-effect imports have zero entries; do not treat them as type-only
  if (imp.entries.length > 0 && imp.entries.every(e => e.isType)) continue;
  if (BINARY_ASSET_EXT.test(imp.moduleRequest.value)) continue;  // skip binary assets
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

export interface VitestAffectedOptions {
  disabled?: boolean;
  ref?: string;  // git ref to diff against (default: none = staged/unstaged/untracked only)
  verbose?: boolean;  // log graph build time, changed files, and affected tests
  threshold?: number;  // run full suite if affected ratio exceeds this (0-1, default 0.5)
}

// Files that affect all tests but are invisible to static import analysis.
// If any of these change, skip smart selection and run the full suite.
const FORCE_RERUN_FILES = [
  'vitest.config.ts', 'vitest.config.js', 'vitest.config.mts',
  'tsconfig.json', 'package.json',
];

export function vitestAffected(options: VitestAffectedOptions = {}): Plugin {
  return {
    name: 'vitest:affected',

    async configureVitest({ vitest, project }) {
      if (options.disabled) return;

      // Guard: watch mode not supported in v0 (selection is computed once, becomes stale)
      if (vitest.config.watch) {
        console.warn('[vitest-affected] Watch mode not supported in v0 — running full suite');
        return;
      }

      // Guard: workspace mode not supported in v0
      if (vitest.projects && vitest.projects.length > 1) {
        console.warn('[vitest-affected] Vitest workspaces not yet supported — running full suite');
        return;
      }

      try {
        // Runtime guard: detect Vitest API shape changes across major versions
        if (!vitest.config || !Array.isArray(vitest.config.include) || typeof vitest.config.root !== 'string') {
          console.warn('[vitest-affected] Unexpected Vitest config shape — running full suite');
          return;
        }

        const rootDir = vitest.config.root;

        // Build graph inline (v0: always rebuild, ~166ms for 433 files)
        // Extract to loader.ts when Phase 2 caching is added
        const verbose = options.verbose ?? false;
        const t0 = performance.now();
        const { forward, reverse } = await buildFullGraph(rootDir);
        if (verbose) console.log(`[vitest-affected] Graph: ${forward.size} files in ${(performance.now() - t0).toFixed(1)}ms`);

        const { changed, deleted } = await getChangedFiles(rootDir, options.ref);

        // If nothing changed, do not filter (normal Vitest behavior = run full suite)
        if (changed.length === 0 && deleted.length === 0) {
          if (verbose) console.log('[vitest-affected] No git changes detected — running full suite');
          return;
        }

        // Deleted source files → run full suite (safety invariant)
        // Only staged/committed deletions trigger this — unstaged working-tree deletions
        // (user ran `rm` without `git rm`) should not force a full run. The `deleted` array
        // from git.ts already only contains files that don't exist on disk. We distinguish
        // staged deletions by checking if they appear in the committed or staged diffs.
        const SOURCE_EXT = /\.(ts|tsx|js|jsx|mts|mjs|cts|cjs)$/;
        const deletedSourceFiles = deleted.filter(f => SOURCE_EXT.test(f));
        if (deletedSourceFiles.length > 0) {
          if (verbose) console.warn(`[vitest-affected] ${deletedSourceFiles.length} source file(s) deleted — running full suite`);
          else console.warn('[vitest-affected] Deleted source file(s) detected — running full suite');
          return;
        }

        // Force full run if config/infra/setup files changed
        // Auto-detect Vitest's own setup files and forceRerunTriggers
        const setupFiles = [vitest.config.setupFiles, vitest.config.globalSetup]
          .flat().filter(Boolean) as string[];
        const allTriggers = [
          ...FORCE_RERUN_FILES,
          ...setupFiles,
          ...(vitest.config.forceRerunTriggers ?? []),
        ];
        // Only check files under rootDir — monorepo siblings' configs are irrelevant
        const localChanged = changed.filter(f => f.startsWith(rootDir + path.sep) || f === rootDir);
        const hasForceRerun = localChanged.some(f => {
          const relPath = path.relative(rootDir, f);
          return allTriggers.some(trigger =>
            // Simple filename: direct comparison. Glob/path pattern: use picomatch.
            (!trigger.includes('/') && !trigger.includes('*'))
              ? path.basename(f) === trigger
              : picomatch.isMatch(relPath, trigger, { dot: true })
          );
        });
        if (hasForceRerun) {
          console.log('[vitest-affected] Config file changed — running full suite');
          return;
        }

        // Test file detection: use Vitest's canonical spec discovery (most correct)
        // globTestSpecifications respects config.include, config.exclude, and all Vitest rules
        // NOTE: isTestFile is scoped to the user's existing include/exclude config. If a user
        // narrows include to a subdirectory (e.g., CI parallelization), tests outside that scope
        // are intentionally excluded from smart selection — this is correct behavior.
        const specs = await project.globTestSpecifications();
        const testFileSet = new Set(specs.map(s => s.moduleId));
        const isTestFile = (f: string) => testFileSet.has(f);
        const affectedTests = bfsAffectedTests(changed, reverse, isTestFile);

        // Threshold check: if too many tests affected, run full suite (more efficient)
        // Use testFileSet.size from Vitest's spec discovery (single source of truth)
        const ratio = testFileSet.size > 0 ? affectedTests.length / testFileSet.size : 0;
        if (ratio > (options.threshold ?? 0.5)) {
          if (verbose) console.log(`[vitest-affected] ${(ratio * 100).toFixed(0)}% of tests affected — running full suite`);
          return;
        }

        // Warn about changed files with no graph presence (monorepo misconfiguration signal)
        if (verbose) {
          for (const f of changed) {
            if (!forward.has(f) && SOURCE_EXT.test(f)) {
              console.warn(`[vitest-affected] Changed file not in graph (outside rootDir?): ${path.relative(rootDir, f)}`);
            }
          }
        }

        // Filter out test files that no longer exist on disk (race between graph build and execution)
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
        // GRACEFUL FALLBACK: if anything fails, run all tests
        console.warn('[vitest-affected] Error — running full suite:', err);
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
import { vitestAffected } from 'vitest-affected'

export default defineConfig({
  plugins: [vitestAffected()],
})
```

Then run one-shot mode:

```bash
npx vitest run
```

Watch mode (`npx vitest`) is not supported in v0 — the plugin will detect it and fall back to the full suite. IDE integrations, CI scripts, reporters — everything works unchanged.

### Git Diff Integration

Three commands needed for full coverage (same approach as Vitest's own implementation):

```typescript
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

async function getChangedFiles(rootDir: string, ref?: string): Promise<{ changed: string[]; deleted: string[] }> {
  // Detect shallow clone before attempting merge-base diff (CI safety)
  if (ref) {
    const { stdout: isShallow } = await exec('git', ['rev-parse', '--is-shallow-repository'], { cwd: rootDir });
    if (isShallow.trim() === 'true') {
      throw new Error(
        '[vitest-affected] Shallow git clone detected. Smart selection requires commit history.\n' +
        'Fix: Set fetch-depth: 0 (or >=50) in your CI checkout step:\n' +
        '  - uses: actions/checkout@v4\n' +
        '    with:\n' +
        '      fetch-depth: 0'
      );
    }
  }

  const run = async (args: string[]) => {
    const { stdout } = await exec('git', args, { cwd: rootDir });
    return stdout.split('\n').filter(Boolean);
  };

  const [committed, staged, unstaged] = await Promise.all([
    ref ? run(['diff', '--name-only', '--diff-filter=ACMRD', `${ref}...HEAD`]) : [],
    run(['diff', '--cached', '--name-only', '--diff-filter=ACMRD']),
    // --others: new untracked, --modified: changed but unstaged
    // NOTE: --deleted excluded here — unstaged working-tree deletions (user ran `rm` without
    // `git rm`) should not trigger the deleted-file full-suite fallback. Only staged/committed
    // deletions (captured by --cached and ref diff with ACMRD filter) trigger that safety check.
    run(['ls-files', '--others', '--modified', '--exclude-standard', '--full-name']),
  ]);

  const { stdout: gitRoot } = await exec('git', ['rev-parse', '--show-toplevel'], { cwd: rootDir });

  const allFiles = [...new Set([...committed, ...staged, ...unstaged])]
    .map(f => path.resolve(gitRoot.trim(), f));

  const { existsSync } = await import('node:fs');
  const existing = allFiles.filter(f => existsSync(f));
  const deleted = allFiles.filter(f => !existsSync(f));

  return { changed: existing, deleted };
}
```

**Gotchas:**
- `--name-only` output is relative to git root, not cwd — always resolve with `git rev-parse --show-toplevel`
- `--diff-filter=ACMRD` includes deletions — needed for the deleted-file safety invariant (full suite fallback)
- `ref...HEAD` (three dots) = merge-base comparison (what diverged since branching) — correct for CI
- Newly created files only appear in `git ls-files --others` — need all three commands
- No external dependencies needed — `child_process.execFile` is sufficient (avoids `execa` dep)
- **CI shallow clones:** `git diff --merge-base` requires commit history. GitHub Actions defaults to `fetch-depth: 1` which will fail. Document this requirement:

```yaml
# GitHub Actions — required for vitest-affected in CI
- uses: actions/checkout@v4
  with:
    fetch-depth: 0  # Full history needed for merge-base diff
```

If `fetch-depth: 0` is too slow for large repos, `fetch-depth: 50` is usually sufficient. vitest-affected should detect shallow clones and warn with a helpful message.

---

## Phased Roadmap

### Phase 1: Static Import Graph (MVP)

**Effort:** ~500-1000 lines
**Accuracy:** Covers all static import-chain dependencies (exact accuracy TBD via fixture tests and real-world validation against body-compass-app)

**Implementation Steps (test-first order):**

0. **Project scaffolding + stub cleanup** — The existing code stubs are from pre-refinement and contradict the plan. Before feature work:
   - **Delete:** `src/graph/cache.ts` (caching deferred to Phase 2)
   - **Delete:** `src/graph/inverter.ts` (inlined into builder.ts)
   - **Rewrite:** `src/graph/builder.ts` → export `buildFullGraph(rootDir)` returning `{ forward, reverse }` (see Step 2 for full spec). Delete `DependencyGraph` interface.
   - **Rewrite:** `src/selector.ts` → pure `bfsAffectedTests` function (remove `SelectionResult`, `getAffectedTests`)
   - **Rewrite:** `src/index.ts` → single export `vitestAffected` (do this EARLY — current exports reference symbols that will be renamed/deleted in later steps, causing build failures if deferred)
   - **Rewrite:** `src/plugin.ts` → remove `verify` option and `onFilterWatchedSpecification` references; orchestration (build → BFS) lives here. Destructure `{ vitest, project }` (not just `vitest`) — `project.globTestSpecifications()` is needed.
   - **Rewrite:** `src/git.ts` → return `{ changed: string[]; deleted: string[] }` (not flat `string[]`). Stub comments say `ACMR` — plan requires `ACMRD` (includes deletions). Follow the pseudocode, not stub comments.
   - **Update:** `package.json` → peer dep `>=3.1.0`, remove `xxhash-wasm`, add `picomatch` to deps, add `tsup` to devDeps, update build script to `tsup`
   - **Create:** root `vitest.config.ts` and `tsup.config.ts` — tsup config: `{ entry: ['src/index.ts'], format: ['esm', 'cjs'], dts: true, clean: true }`
1. **Fixture tests** — Create small projects with known dependency structures FIRST. These define the contract. Include: `simple/` (linear A→B→C), `diamond/` (A→B→C, A→D→C), `circular/` (A→B→A). Write failing tests that assert expected graph shapes and affected test sets.
2. **`graph/builder.ts`** — Exports `buildFullGraph(rootDir)` returning `{ forward: Map<string, Set<string>>, reverse: Map<string, Set<string>> }`. The `invertGraph` function is internal to this file (inlined from the former `inverter.ts`). Glob all code files (including test files) using `**/*.{ts,tsx,js,jsx,mts,mjs,cts,cjs}` (exclude `node_modules/`, `dist/`, `.vitest-affected/`, `test/fixtures/`, `coverage/`, `.next/`). The glob MUST return absolute paths (`tinyglobby` with `absolute: true`). Parse each with `oxc-parser`, resolve specifiers with `oxc-resolver`, build forward graph `Map<string, Set<string>>`. When a parsed file imports a non-source file (e.g., `import data from './data.json'`), the resolved path is added as a forward-graph key with an empty dependency set — this ensures the inverter creates a reverse edge so BFS can trace dependents of that `.json`/`.css` file. **Skip `node_modules` paths** returned by the resolver — only include files under `rootDir`. Use `tinyglobby` for globbing. **Parse error handling:** If `oxc-parser` returns errors for a file, log a warning and add the file to the graph with an empty dependency set (graceful degradation). Do not crash the graph build for a single malformed file. **tsconfig discovery:** Search for `tsconfig.json` starting from `rootDir`. If not found, create the resolver without tsconfig config (path aliases will fail, but basic resolution works). Log a warning if tsconfig is missing.
3. **Orchestration lives in `plugin.ts`** — Build graph (which includes inversion) → BFS is 2 lines of glue, inlined in the plugin's `configureVitest` hook. No separate orchestrator file in v0. Extract to `graph/loader.ts` when Phase 2 caching materializes.
4. **`git.ts`** — Get changed files from git (3 commands: committed, staged, unstaged). Filter deleted files by existence check (see pseudocode above).
5. **`selector.ts`** — Pure BFS function with no IO or orchestration:

```typescript
// selector.ts — pure algorithm, no side effects
export function bfsAffectedTests(
  changedFiles: string[],
  reverse: Map<string, Set<string>>,
  isTestFile: (path: string) => boolean
): string[] {
  const visited = new Set<string>();
  const queue = [...changedFiles];
  let i = 0;
  const affectedTests: string[] = [];

  // BFS seeds include changedFiles directly, so changed test files
  // are always captured (fixes vitest #1113 — no separate pass needed)
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

6. **`plugin.ts`** — Wire everything together in `configureVitest` hook. One-shot mode only in v0: mutate `config.include` with affected test paths. Includes workspace guard and force-rerun check for config files. Graceful fallback: on error, don't modify config (runs full suite).
7. **`index.ts`** — Export only the plugin function: `export { vitestAffected } from './plugin'`. Internal functions stay unexported — no public API surface to maintain until there are real consumers.

**Safety invariant:** vitest-affected must NEVER silently skip tests. If any component fails (graph build, git diff, BFS), the fallback is to run the full test suite and log a warning. False positives (running too many tests) are acceptable; false negatives (missing failures) are not.

**Force rerun triggers:** Changes to `vitest.config.*`, `tsconfig.json`, or `package.json` trigger a full test run regardless of graph analysis. Hardcoded as a const array in `plugin.ts` — no user-facing config option in v0. **Limitation:** Only root-level config filenames are matched. Nested tsconfigs (e.g., `src/tsconfig.app.json` via project references) do not trigger a full rerun — add `**/tsconfig*.json` patterns in Phase 2 when glob-based trigger matching is more robust.

**Type-only imports:** oxc-parser provides `imp.entries[].isType` — if ALL entries are type-only AND there is at least one entry, we skip the import since it creates no runtime dependency. Side-effect imports (`import './polyfill'`) have zero entries and must NOT be skipped — they are runtime dependencies. Same filtering applies to `staticExports` re-exports (`entry.isType`). This improves accuracy over naive parsing.

**Dynamic imports:** Captured by `module.dynamicImports` — included in graph when specifier is a string literal. Computed specifiers (`import(variable)`) are ignored (Phase 2 handles via coverage).

**Non-code imports (`.css`, `.json`, `.svg`, images, fonts):** These are recorded as dependencies (leaf nodes in the graph) but NOT parsed for outgoing edges. This ensures BFS can trace dependents when a `.json` or `.css` file changes, while avoiding pointless parse attempts. The `ASSET_EXT` regex in the import extraction code skips binary assets (`.png`, `.svg`, fonts, etc.) that cannot meaningfully change test behavior — but `.json` and `.css` are kept because changes to them can affect runtime behavior.

**Known limitations (Phase 1):**
- `fs.readFile` dependencies, shared global state, config file impacts, computed dynamic imports
- `vi.mock()` with factory functions: mock factories that import helpers create invisible dependencies. The graph may over-select (running tests where mock fully replaces the module) or under-select (missing changes to mock factory helpers). Over-selection is acceptable per the safety invariant; under-selection from mock factory deps is a known edge case.
- **Watch mode:** Not supported in v0. `configureVitest` runs once at startup — the affected test set would be stale after subsequent edits. Watch mode requires live graph updates on file change events (deferred to Phase 2).
- **Vitest workspaces:** Not supported in v0. Plugin detects workspace mode and falls back to full suite with a warning.
- **File renames:** Renames appear as a deletion + addition. The deleted old path triggers the deleted-source-file full-suite fallback. This is correct but conservative — rename detection deferred to Phase 2.
- **Temporal mismatch:** The graph reflects the *current* disk state, but the diff reflects *historical* changes. If an import edge was removed in the current change, the graph has no edge, so BFS cannot find affected tests from the old import. In practice this is rare (the test itself usually changes too, triggering a direct match), but it's a theoretical false-negative vector. Phase 3 coverage data eliminates this.

### Phase 2: Watch Mode + Verify + Caching

**Effort:** Days-weeks

- **Watch mode:** Hook into Vite's file watcher events, incrementally update the graph for changed files, recompute affected tests per trigger via `onFilterWatchedSpecification`
- **`verify` mode:** Run affected tests first, then full suite, compare results to measure real accuracy. Requires post-run reporter hook to capture per-run results.
- **Graph caching:** Persist graph to `.vitest-affected/graph.json` with mtime+hash hybrid invalidation (Decision 4). Only add caching if profiling shows startup latency matters on 2000+ file projects.
- **Rename detection:** `git diff --name-status -M` to identify renames and avoid unnecessary full-suite fallbacks (v0 treats renames as delete+add, triggering conservative full suite)
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

### Chosen Stack

| Tool | Role |
|---|---|
| `oxc-parser` | Parse imports from TS/JS/TSX/JSX — `result.module` API, type-only import detection |
| `oxc-resolver` | Resolve specifiers to absolute file paths — tsconfig paths, project references |
| `child_process.execFile` | Git diff — no external dependency needed |

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
# In vitest-affected/
npm link

# In body-compass-app/
npm link vitest-affected
```

Or in body-compass-app's `package.json`:
```json
"vitest-affected": "file:../vitest-affected"
```

Live-reload during development. Edit plugin, run tests in body-compass-app, see results.

### Testing the Plugin Itself
- Fixture-based tests: small sample projects with known dependency structures
- Verify graph correctness against known dependency chains
- Test edge cases: circular imports, re-exports, dynamic imports, type-only imports
- Benchmark parse + resolve times on real-world project sizes

### CI Strategy
- v0: graph rebuilds on every run (~166ms, negligible vs test execution time)
- Phase 2: cached graph in `.vitest-affected/` (gitignored), cache key based on file content hashes
- Requires `fetch-depth: 0` (or ≥50) in GitHub Actions for merge-base diff

---

## Package Changes Needed

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

**Peer dep note:** `configureVitest` hook requires Vitest >=3.1. Vitest 4.0 is current stable (4.0.18, Dec 2025) — test against both 3.2.x and 4.0.x. No `xxhash-wasm` in v0 — caching deferred to Phase 2.

Remove `es-module-lexer` — replaced by `oxc-parser`.

Add new source file: `src/git.ts` (git diff with deleted file detection).

**npm name:** `vitest-affected` (unclaimed, verified)

---

## Refinement Log

### Round 1 (Medium: Builder/Breaker/Trimmer — 3x Opus)

- **Changes:** 10 auto-applied (1 Critical plan bloat, 2 Critical docs, 4 High correctness, 3 High structure)
- **Key fixes:** Removed ~150 lines of research/history artifacts (Refinement Log, Evaluated & Rejected, Portfolio Positioning, Fast Parsers). Removed rename detection from v0 (safety fallback handles it). Scoped force-rerun to rootDir files only. Added existsSync filter on BFS results. Inlined inverter.ts into builder.ts. Moved index.ts rewrite into Step 0. Added tsup.config.ts content. Documented isTestFile scoping and file-rename limitation.
- **Consensus:** Stale stubs noted by 3/3 (plan already handles via Step 0). Rename detection = Phase 2 complexity by 2/3. picomatch concerns by 2/3 (force-rerun scoping fixes the monorepo over-match).
- **Trajectory:** Critical/High issues found → continue to Round 2 for verification

### Round 2 (Medium: Builder/Breaker/Trimmer — 3x Opus)

- **Changes:** 6 applied (1 Critical, 3 High, 2 Medium)
- **Key fixes:** Fixed Step 0 return type contradiction (Critical, 2/3 consensus — Round 1 regression). Added existsSync filter logging (safety invariant). Separated unstaged deletions from staged (no false full-suite triggers). Documented nested tsconfig limitation. Removed duplicate index.ts entry. Extended API guard to validate `root`.
- **Consensus:** Step 0 return type bug flagged by 2/3 (Builder + Trimmer). Trimmer wants deeper document trimming (inline code, duplicated sections) — deferred pending user preference.
- **Trajectory:** No Critical remaining after fix. High issues addressed. Medium-only findings remain → finalize

