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

### Step 3: Orchestration in `plugin.ts`

Build graph (which includes inversion) → BFS is 2 lines of glue, inlined in the plugin's `configureVitest` hook. No separate orchestrator file in Phase 1. Extract to `graph/loader.ts` when Phase 2 caching materializes.

### Step 4: `git.ts`

Get changed files from git (3 commands: committed, staged, unstaged). Filter deleted files by existence check.

### Step 5: `selector.ts`

Pure BFS function with no IO or orchestration:

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

### Step 6: `plugin.ts`

Wire everything together in `configureVitest` hook. One-shot mode only in Phase 1: mutate `config.include` with affected test paths. Includes workspace guard and force-rerun check for config files. Graceful fallback: on error, don't modify config (runs full suite).

### Step 7: `index.ts`

Export only the plugin function: `export { vitestAffected } from './plugin'`. Internal functions stay unexported — no public API surface to maintain until there are real consumers.

---

## Plugin Pseudocode

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
        // Runtime guard: detect Vitest API shape changes across major versions
        if (!vitest.config || !Array.isArray(vitest.config.include) || typeof vitest.config.root !== 'string') {
          console.warn('[vitest-affected] Unexpected Vitest config shape — running full suite');
          return;
        }

        const rootDir = vitest.config.root;
        const verbose = options.verbose ?? false;

        // Build graph (~166ms for 433 files)
        const t0 = performance.now();
        const { forward, reverse } = await buildFullGraph(rootDir);
        if (verbose) console.log(`[vitest-affected] Graph: ${forward.size} files in ${(performance.now() - t0).toFixed(1)}ms`);

        const { changed, deleted } = await getChangedFiles(rootDir, options.ref);

        // No changes → run full suite (normal Vitest behavior)
        if (changed.length === 0 && deleted.length === 0) {
          if (verbose) console.log('[vitest-affected] No git changes detected — running full suite');
          return;
        }

        // Deleted source files → run full suite (safety invariant)
        // Only staged/committed deletions trigger this — unstaged working-tree deletions
        // should not force a full run.
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
        const allTriggers = [
          ...FORCE_RERUN_FILES,
          ...setupFiles,
          ...(vitest.config.forceRerunTriggers ?? []),
        ];
        // Only check files under rootDir — monorepo siblings are irrelevant
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

        // Test file detection via Vitest's canonical spec discovery
        const specs = await project.globTestSpecifications();
        const testFileSet = new Set(specs.map(s => s.moduleId));
        const isTestFile = (f: string) => testFileSet.has(f);
        const affectedTests = bfsAffectedTests(changed, reverse, isTestFile);

        // Threshold check
        const ratio = testFileSet.size > 0 ? affectedTests.length / testFileSet.size : 0;
        if (ratio > (options.threshold ?? 0.5)) {
          if (verbose) console.log(`[vitest-affected] ${(ratio * 100).toFixed(0)}% of tests affected — running full suite`);
          return;
        }

        // Warn about changed files with no graph presence
        if (verbose) {
          for (const f of changed) {
            if (!forward.has(f) && SOURCE_EXT.test(f)) {
              console.warn(`[vitest-affected] Changed file not in graph (outside rootDir?): ${path.relative(rootDir, f)}`);
            }
          }
        }

        // Filter out test files that no longer exist on disk
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

---

## Verified API Patterns

### oxc-parser — Import Extraction

```typescript
import { parseSync } from 'oxc-parser';

const { module: mod, errors } = parseSync(filePath, sourceCode);

const specifiers: string[] = [];

// Binary assets that cannot meaningfully affect test behavior — skip
const BINARY_ASSET_EXT = /\.(svg|png|jpg|jpeg|gif|webp|woff2?|eot|ttf|ico)$/i;

// Static imports
for (const imp of mod.staticImports) {
  if (imp.entries.length > 0 && imp.entries.every(e => e.isType)) continue;
  if (BINARY_ASSET_EXT.test(imp.moduleRequest.value)) continue;
  specifiers.push(imp.moduleRequest.value);
}

// Dynamic imports — only string literals
for (const imp of mod.dynamicImports) {
  const raw = sourceCode.slice(imp.moduleRequest.start, imp.moduleRequest.end);
  if (raw.startsWith("'") || raw.startsWith('"')) {
    specifiers.push(raw.slice(1, -1));
  }
}

// Re-exports (in staticExports, NOT staticImports)
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
  tsconfig: {
    configFile: path.join(projectRoot, 'tsconfig.json'),
    references: 'auto',
  },
  builtinModules: true,
});

// CRITICAL: context is DIRECTORY, not file path
const result = resolver.sync(path.dirname(importingFile), specifier);

if (result.error) return null;  // Builtin, external, or unresolvable
return result.path;             // Absolute resolved path
```

### Git Diff Integration

```typescript
async function getChangedFiles(rootDir: string, ref?: string): Promise<{ changed: string[]; deleted: string[] }> {
  if (ref) {
    const { stdout: isShallow } = await exec('git', ['rev-parse', '--is-shallow-repository'], { cwd: rootDir });
    if (isShallow.trim() === 'true') {
      throw new Error(
        '[vitest-affected] Shallow git clone detected. Smart selection requires commit history.\n' +
        'Fix: Set fetch-depth: 0 (or >=50) in your CI checkout step.'
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

## Core Dependencies

| Package | Purpose | Why |
|---|---|---|
| `oxc-parser` | Parse imports from TS/JS/TSX/JSX | 8x faster than esbuild, `result.module` gives pre-extracted imports, full AST for Phase 3 |
| `oxc-resolver` | Resolve specifiers to file paths | 28x faster than enhanced-resolve, handles TS aliases, tsconfig paths |
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

---

## Safety Invariant

vitest-affected must NEVER silently skip tests. If any component fails (graph build, git diff, BFS), the fallback is to run the full test suite and log a warning. False positives (running too many tests) are acceptable; false negatives (missing failures) are not.

---

## Known Limitations (Phase 1)

- `fs.readFile` dependencies, shared global state, config file impacts, computed dynamic imports
- `vi.mock()` with factory functions: mock factories that import helpers create invisible dependencies
- **Watch mode:** Not supported. `configureVitest` runs once at startup — test set becomes stale. Deferred to Phase 2.
- **Vitest workspaces:** Not supported. Plugin detects workspace mode and falls back to full suite.
- **File renames:** Appear as deletion + addition, triggering conservative full-suite fallback. Rename detection deferred to Phase 2.
- **Temporal mismatch:** Graph reflects current disk state, diff reflects historical changes. Rare false-negative vector eliminated by Phase 3 coverage data.
- **Nested tsconfigs:** Only root-level config filenames trigger full rerun. Nested tsconfigs via project references do not — add `**/tsconfig*.json` patterns in Phase 2.

---

## User Experience

```typescript
// vitest.config.ts — this is ALL the user needs to add
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

---

## Testing Strategy

- **Fixture tests:** Small projects with known dependency structures (simple, diamond, circular)
- **Graph correctness:** Assert expected graph shapes against known import chains
- **Edge cases:** Circular imports, re-exports, dynamic imports, type-only imports, `.json`/`.css` imports
- **Benchmarks:** Parse + resolve times on real-world project sizes
- **Integration:** `npm link` against body-compass-app for live validation

---

## Development Against Body Compass

```bash
# In vitest-affected/
npm link

# In body-compass-app/
npm link vitest-affected
```

Live-reload during development. Edit plugin, run tests in body-compass-app, see results.
