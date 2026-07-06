# vitest-affected

[![npm version](https://img.shields.io/npm/v/vitest-affected)](https://www.npmjs.com/package/vitest-affected)
[![CI](https://github.com/craigvandotcom/vitest-affected/actions/workflows/ci.yml/badge.svg)](https://github.com/craigvandotcom/vitest-affected/actions/workflows/ci.yml)
[![measured miss record — live evidence](https://raw.githubusercontent.com/craigvandotcom/vitest-affected/main/_evidence/hero.svg)](https://github.com/craigvandotcom/vitest-affected/blob/main/_plans/research/2026-07-05-a4-walk/analysis.md)
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
- **Silent-starvation heartbeats** — a completed run that collects zero dependency edges, or a selective run that ran a test it didn't select, is flagged loudly (the failure mode that silently no-op'd the plugin for weeks is now observable)
- **Shadow mode** — run the full pipeline without mutating `include`, so a single CI run yields ground truth *and* the would-be selection — the basis for [CI divergence monitoring](#ci-divergence-monitoring)
- **Explain trail** — ask *why* any test is (or isn't) selected, via the `explain` option or the `vitest-affected-explain` CLI
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

  // Extra path prefixes or regexes to ignore from changed-file analysis,
  // on top of built-in defaults
  ignoreChangedFiles: ['legacy/', /^scripts\/.*\.sh$/],

  // Override the default code-extension allowlist
  // Default: .ts, .tsx, .js, .jsx, .mts, .cts, .mjs, .cjs, .json
  includeChangedExtensions: ['.ts', '.tsx', '.svelte'],

  // When true, do not filter caller-provided `changedFiles`
  // Default: false (filter still applies — callers shouldn't reimplement policy)
  respectProvidedChangedFiles: false,

  // Paths that force a full-suite run when changed — an escape hatch for
  // dependencies the import graph can't see (fixtures read via fs, assets
  // imported through Vite `assetsInclude`, generated data). String = exact path
  // or directory prefix; RegExp = tested against the repo-relative path. Checked
  // BEFORE the relevance filter, so triggers on non-code files (.md, .yaml) fire.
  // Default: none (opt-in). Conservative: over-runs rather than risk an under-run.
  fullSuiteTriggers: ['__tests__/fixtures', /\.md$/],

  // Shadow-verification: run the full pipeline but NEVER mutate include, so a
  // single `vitest run` runs everything AND logs the would-be selection.
  // Default: false. (VITEST_AFFECTED_SHADOW=1 activates it regardless.)
  shadow: false,

  // Attach a per-test provenance trail (seed → edge chain) to the selective
  // stats line. Off by default (chains can be large on deep graphs).
  explain: false,

  // Cache-staleness reconciliation. When the graph was last fully rebuilt more
  // than `staleCacheDays` ago, OR more than `maxSelectiveRuns` selective runs
  // have accumulated since, the plugin warns and emits a `cache-stale`
  // diagnostic recommending a full run. It never force-runs. Defaults: 14 / 50.
  staleCacheDays: 14,
  maxSelectiveRuns: 50,

  // Disable the plugin entirely
  disabled: false,
});
```

### Environment variables

Three env vars override config without editing it — useful in CI:

| Variable | Effect |
|----------|--------|
| `VITEST_AFFECTED_DISABLED=1` | Fully inert — no selection, no shadow, no stats line. The rollback kill switch; wins over everything. |
| `VITEST_AFFECTED_SHADOW=1` | Force shadow mode (run everything, log the would-be selection). `DISABLED` still wins. |
| `VITEST_AFFECTED_STATS_FILE=<path>` | Force stats output to `<path>`, overriding the config `statsFile` — so a CI step can point stats at a run-scoped file. |

### Default ignored paths

The plugin filters obviously-irrelevant changed files before graph analysis to remove noise (parse warnings, "not in graph" warnings) for files that can never participate in the dependency graph. Built-in defaults:

- **Path prefixes**: `.claude/`, `.git/`, `.next/`, `.vitest-affected/`, `playwright-report/`, `test-results/`
- **Basenames**: `.gitleaksignore`, `.prettierignore`, `next-env.d.ts`
- **Extensions**: anything outside the code-extension allowlist (markdown, images, CSS, etc.)

Config-file basenames (`package.json`, `tsconfig.json`, `vitest.config.*`, lockfiles) always pass through and trigger a full-suite run, regardless of any ignore rule.

> **Fixtures & assets:** the dependency graph only follows `import` edges. A test that reads a fixture via `fs.readFile`, or an asset pulled in through Vite `assetsInclude` (e.g. `.md`), has **no** edge pointing back from that file to its dependents — so changing it would select too few tests (an under-run). Declare such paths in [`fullSuiteTriggers`](#options) to force a full-suite run when they change.

## Coupling channels

How does a change to file A end up selecting test T? Through a **coupling channel** — some link that makes T depend on A. This table is the honest accounting of every channel and how vitest-affected treats it. Verdicts:

- **TRACKED** — selection follows this channel exactly; no action needed.
- **FALLBACK-COVERED** — not followed by the import graph, but covered once its runtime edge is recorded, or via an opt-in escape hatch.
- **BY-DESIGN** — deliberately not an edge; selecting through it would be wrong.
- **DOCUMENTED-LIMITATION** — a real gap with no automatic coverage; use the noted recipe.

| Channel | Verdict | How |
|---------|---------|-----|
| Static `import` / `import type` | **TRACKED** | Recorded as a runtime edge on every run; delta-parsed for brand-new imports in changed files. |
| Dynamic `import()` | **TRACKED** | Runtime edge when executed; delta-parse also extracts static-specifier dynamic imports (template-literal/`${}` specifiers are skipped as non-resolvable). |
| Re-exports (`export … from`) | **TRACKED** | Ordinary import edges to the re-exporting module and onward. |
| Runtime import edges | **TRACKED** | The primary mechanism — `importDurations` records exactly what each test loaded, so the reverse map is real-world-accurate, not inferred. |
| CSS / asset modules (imported) | **FALLBACK-COVERED** | Not in the extension allowlist, but once the runtime reporter records the edge, **graph membership** keeps the file in the graph and it seeds BFS regardless of extension. A never-yet-imported asset isn't covered until its first full run. |
| `resolve.alias` — string `find` | **TRACKED** | String aliases from the resolved Vite/Vitest config feed the delta-parser's resolver, so brand-new imports through Vite-only aliases resolve. |
| `resolve.alias` — RegExp `find` | **DOCUMENTED-LIMITATION** | User RegExp aliases are skipped with a startup warning (a lossy conversion would silently reopen the hole). Runtime edges still cover them once the cache is warm; delta-parse of a brand-new aliased import is the only uncovered window. |
| Worker via `new Worker(new URL('./x.ts', …))` | **TRACKED** | Extracted during delta-parse (targeted source scan). This is the *only* coverage path — `importDurations` never sees worker-loaded modules (they run outside vite-node's tracked VM). The `SharedWorker` form is covered too. |
| Worker via public-path string (`new Worker('/workers/x.js')`) | **DOCUMENTED-LIMITATION** | A string path served from `public/` isn't resolvable to a source file — declare it via `fullSuiteTriggers`. |
| `vi.mock(factory)` with no static import of the dep | **BY-DESIGN** | The real dependency is never loaded, so it correctly has **no** edge — a change to it can't affect a test that mocks it away. |
| `vi.mock` using `vi.importActual` | **TRACKED** | `importActual` loads the real module, so its runtime edge is recorded normally. |
| `setupFiles` / `globalSetup` | **TRACKED** (full-suite) | A change to either forces a full-suite run (they feed every test); evaluated on the raw changed set before filtering. |
| Config files (`package.json`, `tsconfig.json`, `vitest.config.*`, lockfiles) | **TRACKED** (full-suite) | Always force a full-suite run regardless of any ignore rule. |
| `.env` / `.env.local` | **DOCUMENTED-LIMITATION** | Not a built-in trigger — and usually gitignored, so git-diff can't see them at all. Use the [env-file recipe](#env-file-drift) if your tests read `process.env`. |
| `.snap` snapshot files | **BY-DESIGN** | Snapshot updates are co-committed with the `.test.ts` that owns them; that test file is itself a changed, relevant, self-selecting file — so the snapshot is covered through its owning test with no extra rule. |
| Fixtures read via `fs` / generated data | **FALLBACK-COVERED** | No import edge points back; declare the path in `fullSuiteTriggers` (opt-in, conservative — over-runs rather than under-runs). See the [audit recipe](#auditing-fixture-coverage). |

### Env-file drift

By default, vitest-affected does **not** treat changes to `.env`-style files as a full-suite trigger, and in most repos it *can't* — `.env` files are conventionally gitignored, and vitest-affected's git-diff-based change detection (`git ls-files --others --modified --exclude-standard` for the untracked/unstaged case) is blind to untracked files that match a `.gitignore` rule. If your `.env` isn't tracked in git, editing it produces no signal vitest-affected can see at all — no config option changes that.

If your tests read `process.env` and you want an env-file edit to force a full run, use the `fullSuiteTriggers` escape hatch **and** feed the change through a channel vitest-affected can observe — either by tracking the file in git, or by computing `changedFiles` yourself (e.g. from a CI step that diffs deployed env values) and passing it via `options.changedFiles`:

```ts
vitestAffected({
  fullSuiteTriggers: [/^\.env/],
  // if you compute changed files yourself instead of relying on git:
  // changedFiles: myComputedChangedFiles,
})
```

We evaluated always-adding `.env*` to the built-in config-file list (which always forces a full suite) and rejected it: for the common gitignored-`.env` case the rule would be dead code (the change is invisible before the rule ever runs), and corpus evidence showed zero observed test misses from env drift. An always-on rule that mostly can't fire isn't worth the false sense of coverage — the opt-in recipe above is the honest default.

### Auditing fixture coverage

To find `fullSuiteTriggers` holes in an existing suite — tests that read a file via `fs` with no import edge and no trigger protecting it:

1. **Grep** every `fs` read (`readFileSync`, `readFile`, `fs.promises.readFile`, path constants) across your test files and setup helpers.
2. **Resolve** each read path to a concrete on-disk target.
3. **Classify** each target: already covered by an existing `fullSuiteTriggers` entry, or a hole.
4. **Fix per case:** relocate test-owned data assets under a fixtures dir already covered by a trigger; add a narrow trigger entry (single file or low-churn directory) for canonical, non-test-owned source-of-truth files (a real migration, a prompt doc, a mirrored constant). **Do not** trigger on core application source — that defeats affected-mode; convert those reads to `?raw` imports (which *are* graph edges) instead, or accept a CI full-suite gate as the backstop.
5. **Re-audit** whenever a new "read source as text" test pattern appears.

## Caching

Enabled by default. The reverse dependency map is saved to `.vitest-affected/graph.json` in **v3 format** after each run. The cache is:

- **Self-healing** — updated after every run via runtime `importDurations`
- **Merge-based** — selective runs only update entries for tests that ran, preserving data for others
- **Stale-aware** — removed imports are pruned via per-test overwrite (no monotonic growth)
- **Portable** — v3 stores paths **relative to the project root**, so the cache survives being restored at a different checkout location (CI cache restore, moved worktrees). In-memory paths stay absolute; relativization happens only on disk.
- **Path-canonical** — every path boundary (cache keys, git output, `rootDir`, glob results, caller-provided `changedFiles`) is canonicalized through `realpathSync` + forward-slash normalization, so two aliases of the same file (macOS `/var` → `/private/var` temp symlinks, a symlinked checkout, Windows separators) converge to one graph key instead of silently missing.
- **Auto-migrating** — v2 and v1 caches migrate transparently on read; an unknown version degrades to a safe cache miss (full suite, then re-written as v3). Stale entries written through a different path alias self-heal on the next full run. No manual migration.

### Cache staleness

Selective runs only refresh edges for the tests that actually ran, so a long streak of selective-only runs can let the graph drift. The v3 cache tracks when it was last fully rebuilt (`lastFullRebuild`) and how many selective runs have accumulated since (`runCount`). Past `staleCacheDays` (default 14) or `maxSelectiveRuns` (default 50), the plugin warns loudly and emits a `cache-stale` diagnostic line recommending a full run. It **never force-runs** the full suite (that would surprise you mid-flow) — running the full suite once (e.g. `rm -rf .vitest-affected` or a run with no changes) re-observes every edge and resets the baseline.

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

### Stats line taxonomy

Stats lines come in two classes — filter by `action`:

- **DECISION lines** — exactly one per run, describing the selection decision. `action` is `selective` or `full-suite` (or under shadow mode, `shadow-selective` / `shadow-full-suite`). They carry the decision fields: `reason` (on full-suite and shadow lines), `changedFiles`, `deletedFiles`, `ignoredFiles`, `affectedTests`, `totalTests`, `graphSize`, `cacheHit`, `durationMs`, and — under shadow — `selectedFiles`.
- **DIAGNOSTIC lines** — zero or more per run, always `action: "heartbeat"`, carrying only `timestamp`, `action`, `reason`, and reason-specific fields. The heartbeat reasons:
  - `zero-edges` — a completed run collected **zero** dependency edges (the silent-starvation net).
  - `selection-mismatch` — a test ran that wasn't in the selected set (`strayCount`); the `include` mutation lost effect.
  - `cache-stale` — the graph aged past its thresholds (`staleCacheDays`, `cacheAgeDays`, `selectiveRunCount`); emitted pre-run, recommendation only.

### Shadow mode

Shadow mode runs the **full** selection pipeline but never mutates `project.config.include`, so a single `vitest run` executes the whole suite (ground truth) *and* logs the selection it *would* have made. Enable it with `shadow: true` or `VITEST_AFFECTED_SHADOW=1`.

Under shadow, decision lines are remapped into a shadow namespace with the original `reason` retained:

```jsonl
{"timestamp":"...","action":"shadow-selective","reason":null,"selectedFiles":["/abs/path/a.test.ts"],"affectedTests":1,"totalTests":162,...}
{"timestamp":"...","action":"shadow-full-suite","reason":"cache-miss","selectedFiles":null,...}
```

`shadow-selective` carries the would-be selection in `selectedFiles`; `shadow-full-suite` carries `selectedFiles: null` (meaning "would have run everything"). This is the mechanism behind [CI divergence monitoring](#ci-divergence-monitoring).

### Explain: why is this test selected?

Two ways to see the provenance of a selection — the seed (the changed/deleted file) and the full edge chain (`seed → … → test`) that caused it:

- **`explain: true`** attaches an `explain` field to the `selective` decision line: `{ [testPath]: { seed, chain } }` for every selected test. Off by default because chains can be large on deep graphs.
- **`npx vitest-affected-explain <testfile>`** answers the question ad hoc against the current cache + git state — including *why-not* (which chain is missing) for a test that isn't selected:

```bash
$ npx vitest-affected-explain test/checkout.test.ts
SELECTED — seed src/cart.ts → src/checkout.ts → test/checkout.test.ts
```

## CI divergence monitoring

Before you trust affected-mode enough to drop a full-suite gate, prove it empirically. Run the plugin in **shadow mode** on every full CI run and compare what it *would* have selected against what actually failed.

**How it works**

1. **Shadow on full runs.** On the job that runs the entire suite, set `VITEST_AFFECTED_SHADOW=1` and `VITEST_AFFECTED_STATS_FILE=<run-scoped path>`. Shadow computes the selection but never mutates Vitest's `include`, so the full suite still runs — the full-suite guarantee holds by construction. The plugin appends exactly one decision line: `shadow-selective` (with `selectedFiles`) or `shadow-full-suite` (`selectedFiles: null` — it would have run everything, e.g. cache-miss, config change, no changes).
2. **Emit machine-readable results.** Have the test runner write a JSON report (`--reporter=json --outputFile.json=<path>`), which flushes even when tests fail.
3. **Compare.** After the run, read the decision line and the failing test files. A failing file **not** in the shadow-selected set is a **divergence**: affected-mode would have missed a real failure. `shadow-full-suite` decisions can't diverge (they run everything) but their `reason` is logged as fallback-frequency evidence. Normalize both the shadow `selectedFiles` and the vitest result names through realpath → repo-relative before comparing, so canonical and raw absolute paths match despite `/var` → `/private/var` aliasing.
4. **Alert + record.** Publish the comparison to the CI job summary and archive it as an artifact. On divergence > 0, alert loudly (chat notification + tracked bug) with the missed files and the changed files.
5. **Fail closed.** The plugin emits a decision line on every non-disabled exit, so a missing or empty stats file means the wiring itself is broken (commonly: the plugin silently fell back to a no-op because it couldn't be resolved) — treat that as a hard CI failure, not a pass.

Each clean full run is one more data point; a sustained zero-divergence streak is the evidence that earns retiring the full-suite gate.

## Requirements

- **Vitest** >= 3.2.0, < 5.0.0 (Vitest 5 not yet validated — tracked for 1.1)
- **Node.js** >= 18
- A **git** repository

## Limitations

- **First run requires full suite** — the runtime dependency map is built from actual test execution, so the first run (or after cache deletion) runs everything
- **Non-code files reached outside `import`** — a file a test consumes *without* an `import` edge (a fixture read via `fs.readFile`, generated data, an asset served from `public/`) has no edge pointing back to its dependents, so changing it alone would select too few tests. Declare such paths in [`fullSuiteTriggers`](#options). Note: `.json` **is** tracked (it's in the default extension allowlist), and CSS/asset modules that Vite actually imports **are** covered — once the runtime reporter records their edge, [graph membership](#coupling-channels) keeps them in the graph regardless of extension. The gap is specifically the non-`import` channel above.
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
