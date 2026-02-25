# vitest-affected

[![npm version](https://img.shields.io/npm/v/vitest-affected)](https://www.npmjs.com/package/vitest-affected)
[![license](https://img.shields.io/npm/l/vitest-affected)](https://github.com/craigvandotcom/vitest-affected/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](https://www.typescriptlang.org/)

Run only the tests affected by your changes. Zero config, runtime dependency tracking, ~5ms selection overhead.

```
  Full suite:       2,771 tests | 152s
  vitest-affected:     22 tests |  3.1s   (98% reduction)
```

## Why

**Test more often, not just faster.**

If you're running AI coding agents — or multiple agents in parallel — each one needs to verify its changes with tests. On a large codebase, running the full suite after every change is either painfully slow or impossible (machine melts). So you skip tests, and bugs slip through.

`vitest-affected` makes it practical to test after every single change. Each agent runs ~20 tests in seconds instead of 2,771 tests in minutes. You get continuous verification without overloading your machine.

It works by using Vitest's own runtime import data to build an exact reverse dependency map, diffing it against git, and walking the graph to find exactly which tests are impacted. If you change a utility buried three imports deep, only the tests that transitively depend on it will run.

If anything fails — git error, corrupt cache, incomplete graph — it falls back to the full suite with a warning. It never silently skips tests.

## Features

- **Runtime dependency tracking** — uses Vitest's `importDurations` for exact, real-world dependency data
- **Transitive dependency tracking** — BFS reverse-walk catches changes buried deep in the import chain
- **~5ms selection overhead** — delta-parse only changed files, load cached reverse map, BFS select
- **Persistent cache** — reverse dependency map saved to `.vitest-affected/graph.json`, survives CI runs
- **Self-healing** — cache updates after every run via runtime reporter; stale edges automatically pruned
- **Config-change detection** — `package.json`, `tsconfig.json`, `vitest.config.*`, lockfile changes trigger full suite
- **Safe by default** — any failure falls back to full suite, deleted files handled as BFS seeds
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
First run (no cache):
  → Full suite runs
  → Runtime reporter captures importDurations from each test
  → Reverse dependency map saved to .vitest-affected/graph.json

Subsequent runs (cache hit):
  git diff → changed files                          ~2ms
  load cached reverse map                            ~1ms
  delta-parse changed files for new imports (oxc)    ~5ms
  BFS on reverse map → affected test files           ~1ms
  mutate config.include → Vitest runs only those     ───→ 3 tests instead of 300
  → Runtime reporter updates cache for next run
```

1. **First run** — no cache exists, so the full suite runs. A runtime reporter captures every module each test imports via `importDurations`, building an exact reverse dependency map. This is saved to disk.
2. **Subsequent runs** — the cached reverse map is loaded (~1ms). Git diff identifies changed files. A fast delta-parse with [oxc-parser](https://oxc.rs) checks changed files for new imports not yet in the cache (~5ms for 1-5 files). BFS walks the reverse map to find affected tests.
3. **After every run** — the runtime reporter updates the cache with fresh dependency data. Stale edges (removed imports) are automatically pruned via per-test overwrite.

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

Enabled by default. The reverse dependency map is saved to `.vitest-affected/graph.json` in v2 format after each run. The cache is:

- **Self-healing** — updated after every run via runtime `importDurations`
- **Merge-based** — selective runs only update entries for tests that ran, preserving data for others
- **Stale-aware** — removed imports are pruned via per-test overwrite (no monotonic growth)
- **v1-compatible** — old v1 caches with `runtimeEdges` are automatically migrated

Add `.vitest-affected/` to your `.gitignore`. For CI, cache this directory between runs for instant test selection.

## Watch Mode

In `vitest --watch`, the plugin delegates to Vitest's native file-watching and HMR-based module graph. The runtime reporter continues updating the cache, so the next `vitest run` has the latest dependency data.

## Observability

Enable `statsFile` to collect a JSON-line log of every run:

```jsonl
{"timestamp":"...","action":"selective","changedFiles":46,"deletedFiles":25,"affectedTests":4,"totalTests":162,"graphSize":492,"cacheHit":true,"durationMs":8}
{"timestamp":"...","action":"full-suite","reason":"config-change","changedFiles":1,"deletedFiles":0,"graphSize":492,"durationMs":2}
```

Each line records what the plugin decided, why, and how many tests were affected.

## Requirements

- **Vitest** >= 3.2.0
- **Node.js** >= 18
- A **git** repository

## Limitations

- **First run requires full suite** — the runtime dependency map is built from actual test execution, so the first run (or after cache deletion) runs everything
- **Non-JS/TS files** — CSS, JSON, and asset imports are excluded from the dependency graph
- **Single-project only** — workspaces with multiple Vitest projects fall back to full suite (multi-project support planned)

## Agent Workflows

`vitest-affected` is designed for workflows where tests run frequently and automatically — CI pipelines, pre-commit hooks, and especially AI coding agents.

**The problem:** AI agents (Claude Code, Cursor, Copilot Workspace, etc.) work best when they verify each change with tests. But on a large codebase, running the full suite after every edit makes agents slow and resource-heavy — or worse, agents skip testing entirely.

**The fix:** Add `vitest-affected` to your config and tell your agents to run `npx vitest run` after every change. Each run takes seconds, not minutes. Agents test continuously without overloading your machine, even with multiple agents working in parallel.

```ts
// vitest.config.ts — set once, every agent benefits
plugins: [vitestAffected({ verbose: true, statsFile: '.vitest-affected/stats.jsonl' })],
```

The `statsFile` option logs every decision the plugin makes, giving you full visibility into what agents are testing and why.

## Compared To

| Approach | Scope | Accuracy |
|----------|-------|----------|
| Vitest `--changed` | Shallow deps, no persistence | Misses transitive deps ([#4933](https://github.com/vitest-dev/vitest/issues/4933)) |
| Jest `--onlyChanged` | Direct file changes only | Misses transitive deps |
| Nx affected | Workspace-level project granularity | No file-level selection |
| **vitest-affected** | File-level, full transitive graph, persistent | Exact runtime-verified selection |

## License

MIT
