# vitest-affected

[![npm version](https://img.shields.io/npm/v/vitest-affected)](https://www.npmjs.com/package/vitest-affected)
[![license](https://img.shields.io/npm/l/vitest-affected)](https://github.com/craigvandotcom/vitest-affected/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](https://www.typescriptlang.org/)

Run only the tests affected by your changes. Zero config, full dependency graph analysis, sub-200ms overhead.

```
  Full suite:       162 tests | 45.2s
  vitest-affected:    4 tests |  1.2s   (46 files changed → 97.5% reduction)
```

## Why

Most test runners re-run everything or rely on simple file-name matching. `vitest-affected` builds a real import dependency graph of your project, diffs it against git, and walks the graph in reverse to find exactly which tests are impacted. If you change a utility buried three imports deep, only the tests that transitively depend on it will run.

If anything fails — git error, parse failure, incomplete graph — it falls back to the full suite with a warning. It never silently skips tests.

## Features

- **Full import graph** — static imports, dynamic imports, re-exports via [oxc-parser](https://oxc.rs)
- **Transitive dependency tracking** — BFS reverse-walk catches changes buried deep in the import chain
- **Sub-200ms overhead** — 166ms to build a graph of 433 files (0.38ms/file)
- **Disk caching** — graph persisted to `.vitest-affected/graph.json`, only changed files re-parsed on subsequent runs
- **Watch mode** — runtime imports captured and merged into the static graph each cycle
- **Config-change detection** — `package.json`, `tsconfig.json`, `vitest.config.*`, lockfile changes trigger full suite
- **Safe by default** — any failure falls back to full suite, deleted files handled intelligently
- **Observability** — optional JSON-line stats log for every run

## Install

```bash
npm install -D vitest-affected
```

## Setup

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import { vitestAffected } from 'vitest-affected';

export default defineConfig({
  plugins: [vitestAffected()],
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
```

That's it. On your next `vitest run`, only affected tests execute.

## How It Works

```
git diff → changed files
                ↓
        oxc-parser + oxc-resolver → dependency graph (forward + reverse)
                ↓
        BFS on reverse graph → affected test files
                ↓
        mutate config.include → Vitest runs only those tests
```

1. **Detect changed files** via `git diff` — unstaged, staged, and committed changes vs your base ref (3 parallel git commands)
2. **Build the dependency graph** — oxc-parser extracts imports, oxc-resolver resolves specifiers to absolute paths with full tsconfig support
3. **Reverse-walk with BFS** — from each changed file, traverse all dependents to find affected test files
4. **Filter test list** — mutate Vitest's `config.include` to only the affected tests

## Performance

Benchmarked on a real project (433 TypeScript/TSX files):

```
Phase      |  Total   | Per file
-----------|----------|----------
Read       |  14.9ms  | 0.034ms
Hash       |   9.9ms  | 0.023ms
Parse      |  99.7ms  | 0.230ms
Resolve    |  41.2ms  | 0.095ms
-----------|----------|----------
TOTAL      | 165.8ms  | 0.383ms
```

With caching enabled (default), only files whose mtime changed are re-parsed. Subsequent runs pay only the delta cost.

## Options

```ts
vitestAffected({
  // Compare against a specific git ref (default: auto-detect HEAD)
  ref: 'main',

  // Bypass git diff — provide changed file paths directly
  changedFiles: ['/absolute/path/to/changed-file.ts'],

  // Fall back to full suite if affected ratio exceeds this (0-1, default: none)
  threshold: 0.8,

  // Print diagnostic info about graph building and test selection
  verbose: true,

  // When true, allow 0 affected tests (skip entire suite). Default: false (runs full suite)
  allowNoTests: false,

  // Enable dependency graph caching to disk (default: true)
  cache: true,

  // Append JSON-line stats after each run for observability
  statsFile: '.vitest-affected/stats.jsonl',

  // Disable the plugin entirely
  disabled: false,
});
```

Set `VITEST_AFFECTED_DISABLED=1` to disable without changing config.

## Caching

Enabled by default. The dependency graph is saved to `.vitest-affected/graph.json` after the first run. Subsequent runs reuse the cached graph — only files whose mtime has changed are re-parsed.

Add `.vitest-affected/` to your `.gitignore`.

## Watch Mode

In `vitest --watch`, the plugin captures actual runtime imports via Vitest's reporter and merges them into the static graph. This means the next watch cycle has more accurate dependency information, covering cases where static analysis can't resolve dynamic imports.

## Observability

Enable `statsFile` to collect a JSON-line log of every run:

```jsonl
{"timestamp":"...","action":"selective","changedFiles":46,"deletedFiles":25,"affectedTests":4,"totalTests":162,"graphSize":492,"durationMs":229}
{"timestamp":"...","action":"full-suite","reason":"config-change","changedFiles":1,"deletedFiles":0,"graphSize":492,"durationMs":45}
```

Each line records what the plugin decided, why, and how many tests were affected.

## Requirements

- **Vitest** >= 3.2.0
- **Node.js** >= 18
- A **git** repository

## Limitations

- **Template literal dynamic imports** — `` import(`./locale/${lang}.ts`) `` can't be statically resolved
- **Non-JS/TS files** — CSS, JSON, and asset imports are excluded from the graph

## Compared To

| Approach | Scope | Accuracy |
|----------|-------|----------|
| Jest `--onlyChanged` | Direct file changes only | Misses transitive deps |
| Nx affected | Workspace-level project granularity | No file-level selection |
| **vitest-affected** | File-level, full transitive graph | Exact test selection |

## License

MIT
