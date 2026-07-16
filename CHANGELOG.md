# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Dependency pinning policy — hybrid tilde on 0.x native/parse deps** — the
  `0.x` runtime deps that execute in consumers' processes are now tilde-pinned to
  their patch line (`oxc-parser` `^0.128.0` → `~0.128.0`, `tinyglobby` `^0.2.16`
  → `~0.2.16`) so a breaking upstream `0.x` minor cannot silently reach consumers
  (published packages ship no lockfile). `oxc-resolver` stays caret (`^11.0.0`) —
  it follows real semver. Tilde on `0.x` means we uptake upstream patch fixes by
  cutting more frequent releases rather than floating minors. Lands with the
  `>=0.10.0` release.

- **Public entry surface shrank** — deleted five never-publicly-consumed
  re-exports from `dist/index.js`: `bfsAffectedTests`,
  `bfsAffectedTestsWithProvenance`, `SelectionTrail`, `explainSelection`,
  `ExplainResult` (every in-repo/test consumer already imports these from their
  source modules `./selector.js` / `./explain-core.js`, never from the index).
  The public entry now exports ONLY `vitestAffected` + `VitestAffectedOptions`.
  The replay-harness symbols `mergeRuntimeEdges` + `ReverseMap` moved to a new
  private entry `dist/internal.js` (NOT in `package.json` exports — the exports
  map stays `["."]`). README documented none of these symbols, so this is NOT a
  breaking change.

### Added

- **`vitest-affected-explain` learns test-file globs from an explicit source** —
  the CLI now accepts repeatable `--include <glob>` flags (and a
  `VITEST_AFFECTED_INCLUDE` env var of comma/space-separated globs; the flag
  wins). This lets it classify custom test layouts (`__tests__/`, `.e2e.ts`, …)
  the way the project's real Vitest `include` does, instead of only the default
  `/\.(test|spec)\.[cm]?[jt]sx?$/` heuristic. When no glob is supplied (or none
  match), it falls back to that default matcher, preserving the standalone stance
  (no Vitest boot required).

### Fixed

- **Parse errors no longer discard partial imports or escalate to a full suite** —
  `resolveFileImports` now returns `{ targets, parseFailed }`: on a mid-edit syntax
  error it keeps the partial specifier list oxc extracted before the broken point
  (partial ≥ nothing — discarding it would strictly under-seed) and warns once per
  file, rather than dropping every target. The changed file itself remains an
  unconditional BFS seed, so its cached dependents still run; a syntax error stays
  within the changed file's blast radius instead of forcing the whole suite.
- **Early-exit stats lines are now root-anchored** — the workspace and
  config-shape full-suite guards emit before the plugin resolves `vitest.config.root`,
  so with `cwd` != config root and a relative/default `statsFile` their decision
  line previously landed under `<cwd>/.vitest-affected/` while every other line
  landed under `<root>/`, silently losing exactly those two events from any
  fallback-segmenting harness. The stats path is now anchored to the config root as
  the first step inside the plugin's safety `try`, before any guard emits.
- **Config full-suite trigger is now root-anchored** — a config basename
  (`package.json`, lockfiles, `vitest.config.*`, …) only forces a full suite
  when it sits at the repo root (or is a shared workspace config above the
  Vitest project root). Previously the basename matched _anywhere_, so in a
  monorepo every `packages/foo/package.json` edit (or deletion) negated test
  selection and forced the whole suite. Both decision sites — the plugin's
  force-rerun check and the relevance filter — now share one exported
  `isRootConfigFile` predicate so they cannot drift.
- **Committed renames now seed a deletion** — git change detection runs with
  `--no-renames`, so a committed rename surfaces the old path as a deletion
  (which seeds BFS from the dependents of the vanished file) instead of being
  collapsed into a single rename entry git otherwise reports. Previously the old
  path never entered the changed set and tests depending on it were silently
  under-selected.
- **Unresolvable `ref` now fails loudly into the full suite** — an `ref` that
  git cannot resolve (bad branch/SHA, missing base in a shallow CI checkout)
  throws and falls back to the full suite with a warning, instead of silently
  degrading to a working-tree-only diff that under-selects against the intended
  base.
- **git stdout capped at a finite 256MB** — the git exec `maxBuffer` is set to a
  finite 256MB so a pathologically large diff overflows into a catchable error
  that trips the full-suite fallback. Previously the default 1MB buffer silently
  emptied the changed set on overflow (and a brief `Infinity` cap risked an
  unbounded allocation) — both under-ran tests without warning.
- **Type-changed (`T`) files now enter the changed set** — git status/diff type
  changes (e.g. a file swapped to/from a symlink) are no longer dropped by the
  status-code filter and now seed selection like any other modification.
- **Watch-mode re-runs no longer misclassified as full rebuilds** — a watch-mode
  re-invocation is correctly recognized as incremental rather than a fresh full
  rebuild, restoring the cache-staleness warning that the misclassification
  suppressed.

### Changed

- **Hero-card accuracy metric now counts missed decisions over verified
  decisions** — the evidence badge reports misses relative to the set of
  verified decisions, a more honest denominator than the prior basis.

## [0.9.0] - 2026-07-06

Release-candidate for 1.0: everything below is the 1.0 feature set, shipped
at 0.9 deliberately — the CI divergence monitor (see README § CI divergence
monitoring) now accumulates live evidence on every full consumer run, and
1.0 graduates once a few months of that stream stay clean. Measured
reliability and 1.0 are the same milestone; the measuring is now continuous. Two tracks of work land here: **Track 1** hardens the
silent-failure surface (heartbeats, path canonicalization, graph-membership
override, `globalSetup` tracking), and **Track 2** adds observability and
coverage reach (shadow mode, explain trail + CLI, cache staleness
reconciliation, `resolve.alias` delta-parse, worker-script seeding, cache v3
portable format, `fullSuiteTriggers`).

### ⚠️ BREAKING

- **Cache v3 on-disk format** — `.vitest-affected/graph.json` now stores paths
  **relative to the (canonical) `rootDir`** instead of absolute paths, making
  the cache portable across checkout locations (CI cache restore, moved
  worktrees). In-memory representation stays absolute; relativization happens
  only at the persistence boundary. **Migration is automatic and requires no
  action:** v2 and v1 caches auto-migrate on read; a v3 cache without the new
  `lastFullRebuild`/`runCount` metadata still loads (meta defaults to zero, so
  staleness is not flagged until the next full run seeds the baseline); unknown
  cache versions degrade to a safe cache miss (full suite, then the cache is
  re-written in v3). The format change is only observable on **write** — nothing
  a consumer imports changes.
- **Canonicalized cache keys** — every path boundary now routes through a new
  `toCanonicalPath()` helper (resolves symlinks via `realpathSync`, normalizes
  separators to `/`). The v2 schema version is unchanged; this is a value-level
  change to what a key *looks like*. **Self-healing, no migration needed:**
  entries written through a different alias of the same file (macOS
  `/var` → `/private/var` temp symlinks, a symlinked project root, Windows
  separators) are canonicalized on read and converge instead of orphaning;
  entries merging to the same canonical key are unioned. Any entry that still
  fails to match simply misses — the cache-miss fallback (full suite) re-records
  it canonically on the next run.

### Migration from 0.x

- **No action required.** Delete `.vitest-affected/` if you want a clean v3
  cache immediately, or just run your suite once — v2/v1 caches auto-migrate and
  stale aliased entries self-heal on the next full run.
- The `vitest` peerDependency remains capped at `>=3.2.0 <5.0.0` (see
  [0.5.0](#050---2026-05-03)). Vitest 5 is not yet validated — tracked for 1.1.

### Added

- **Silent-starvation heartbeats** — three structural safeguards make the worst historical bug class (the silent no-op, e.g. the v0.5.0 Vitest 4 `importDurations` regression that ran the plugin as a no-op for weeks) observable instead of swallowed. All three are loud `console.warn` + a distinct stats line:
  - **Zero-edge heartbeat** (`action: "heartbeat"`, `reason: "zero-edges"`) — a completed, non-interrupted run in which test modules actually ran (`testModules.length > 0`, no unhandled errors) yet the reporter collected **zero** dependency edges across all modules. This is the universal net for any future runtime starvation — API drift, config gating, reporter detachment, or `importDurations` disabled — since the symptom is always the same (no edges). Previously such a run reached no callback at all (`onTestRunEnd` only fired `onEdgesCollected` when `runtimeReverse.size > 0`); that guard now has a parallel zero-edge path. Interrupted runs and `vitest list` (which never calls `onTestRunEnd`) do not trigger it, and neither does a legitimately empty selection (zero modules ran).
  - **`importDurations` config shape-check** (`action: "full-suite"`, `reason: "import-durations-shape"`) — at startup, `experimental.importDurations` is asserted to be a plain object whose `limit` (if present) is a number, before the force-enable write. `importDurations` is explicitly experimental upstream and was recently expanded, so *additive* drift (new/unknown fields) is tolerated; only *structural* drift that would break the force-enable falls back to the full suite. The runtime "presence/shape on first module" concern is subsumed by the zero-edge heartbeat — any shape drift that breaks edge collection surfaces as a zero-edge run.
  - **Selection self-verify** (`action: "heartbeat"`, `reason: "selection-mismatch"`) — after a selective run, the reporter asserts ran-tests ⊆ the selected set; a stray (a test that ran but was not selected) means the `project.config.include` mutation silently lost effect and is flagged loudly. Skipped under shadow mode, where `include` is deliberately not mutated so all tests run (a "stray" is expected, not a bug).
  - **Line taxonomy** — stats lines fall into two classes: exactly one **DECISION** line per `configureVitest` exit (`action: "selective"`/`"full-suite"`, or shadow variants) carrying the full decision fields, and 0..n post-run **DIAGNOSTIC** lines (`action: "heartbeat"`) carrying only fields meaningful post-run — `timestamp`, `action`, `reason`, plus `strayCount` on `selection-mismatch` (decision-line fields like `graphSize`/`affectedTests` are no longer reused on heartbeat lines). Consumers/harnesses filter by `action`. The zero-edge line is always emitted, but its loud `console.warn` is scoped to full-suite-scale starvation (`testModules.length > 5`) so a small third-party-only selective run stays quiet.
  - **Reporter registration** stays on the existing `Object.defineProperty` interception of `vitest.reporters`. The documented `config.reporters.push([['name', {}]])` path takes a built-in name or a module path loaded in isolation — it cannot carry our live closure reporter (which shares `rootDir`, the reverse map, the cache-save callback, `statsFile`, and the selected set with the plugin instance). The heartbeats, not the registration path, are what make silent failure impossible.

- **`resolve.alias` feeds the static delta-parser** — string `find` aliases from the resolved Vite/Vitest config are passed into oxc-resolver, so brand-new imports through Vite-only aliases (stub packages, path shims) resolve during delta-parse instead of silently dropping the edge. User RegExp aliases are skipped with a startup warning (a lossy conversion would silently reopen the hole; runtime edges still cover them once the cache is warm); Vite's built-in `@vite/env` / `@vite/client` RegExp aliases are ignored silently.
- **Explain trail** — per-test selection provenance (seed → edge chain): opt-in `explain` plugin option surfaces it on selective stats lines, and a new `npx vitest-affected-explain <testfile>` CLI answers "why is this test (not) selected right now?" against the cache + git state. New public API: `bfsAffectedTestsWithProvenance`, `explainSelection`.
- **Cache staleness reconciliation** — the v3 cache tracks `lastFullRebuild` + selective `runCount`; past `staleCacheDays` (default 14) or `maxSelectiveRuns` (default 50) the plugin warns loudly and emits a `cache-stale` diagnostic recommending a full run (never force-runs; a full-suite run resets the baseline).
- **Worker script changes now seed selection** — `new Worker(new URL('./x.ts', import.meta.url))` and the `SharedWorker` form are extracted during delta-parse (targeted source scan; template-literal/dynamic specifiers skipped). This is the ONLY coverage path for worker scripts: vitest's `importDurations` never sees worker-loaded modules (they execute outside vite-node's tracked VM), so runtime edges cannot cover them. Documented limitation: string-path workers served from `public/` (e.g. `new Worker('/workers/x.js')`) are not resolvable to source — declare those via `fullSuiteTriggers`.
- **Cache v3: repo-relative paths on disk** — `graph.json` now stores paths relative to the (canonical) `rootDir`, making the cache portable across checkout locations (CI cache restore, moved worktrees). In-memory representation stays absolute; relativization happens only at the persistence boundary. v2 (and v1) caches auto-migrate on read; unknown versions degrade to a safe cache miss. See ⚠️ BREAKING above.
- **Shadow-verification mode** — new `shadow?: boolean` option (or `VITEST_AFFECTED_SHADOW=1`, which activates it regardless of config) runs the full selection pipeline but never mutates `project.config.include`, so a single `vitest run` yields ground truth (all tests) alongside the would-be decision. Stats lines are remapped into a shadow namespace: `shadow-selective` carries `selectedFiles: string[]` (the would-be selection) and `shadow-full-suite` carries `selectedFiles: null` ("all tests"), with the original `reason` retained. `VITEST_AFFECTED_DISABLED=1` still wins (fully inert). `VITEST_AFFECTED_STATS_FILE=<path>` forces stats output to a path, overriding the config `statsFile`. Every exit path now emits exactly one stats line when a stats path is known (the four previously-silent early returns plus the catch-all `reason: "error"`); the disabled early-return remains silent by design.
- **Public export: `mergeRuntimeEdges` + `ReverseMap` type** — the reporter's per-test runtime-edge merge is now an exported pure function `mergeRuntimeEdges(base: ReverseMap, fresh: ReverseMap, scope: Set<string> | 'all'): ReverseMap`. Additive public API (re-exported from the package entry). `scope: 'all'` overwrites every test present in `fresh`; a `Set<testPath>` restricts the overwrite to the listed tests and preserves other tests' edges. It never mutates its inputs and never touches the cache — persistence stays with the caller.
- **`fullSuiteTriggers` option** — declare paths that force a full-suite run when changed, an escape hatch for dependencies the import graph can't see: fixtures read via `fs.readFile`, assets imported through Vite `assetsInclude` (e.g. `.md`), or generated data. Without it, changing such a file selects too few tests (an under-run / false negative) because no import edge points back to its dependents. Each rule is a string (exact path or directory prefix) or a `RegExp`, matched against the repo-relative path — same semantics as `ignoreChangedFiles`. Evaluated on the raw changed set *before* relevance filtering, so triggers on non-code files still fire. Opt-in; conservative by design (over-runs rather than risk an under-run).

### Changed

- **Env-file (`.env`, `.env.local`) drift is a documented `fullSuiteTriggers` recipe, not a built-in trigger** — env-file changes are handled via the opt-in `fullSuiteTriggers` escape hatch, not an always-on `CONFIG_BASENAMES` entry: git-diff change detection can't see gitignored env files (`git ls-files --others --modified --exclude-standard` honours `.gitignore`), so an always-on rule would be dead code for the common case, and corpus evidence showed zero observed misses from env drift. Regression tests pin both the current default (env files filtered out) and the recipe. See the README "Coupling channels" table.

### Fixed

- **Rule matching now sees files above `rootDir`** — `toRepoRelative` returns an honest `../`-prefixed relative path (instead of the raw absolute) for files above `rootDir` but inside the git repo, so `fullSuiteTriggers`/`ignoreChangedFiles` string and prefix rules can match them (e.g. `'../../shared/fixtures/'` in a monorepo package). Previously such files produced an absolute string no string/prefix rule could ever match — the escape hatch was silently blind exactly where the import graph is too. No change for the common `rootDir === gitRoot` topology or for Windows drive paths examined on POSIX.
- **Graph membership overrides the extension allowlist** — a changed or deleted file already present as a key in the loaded reverse dependency graph (e.g. a CSS module whose runtime edge the reporter recorded) now survives relevance filtering and seeds BFS, regardless of extension. Previously `DEFAULT_RELEVANT_EXTENSIONS` dropped such files before selection, silently under-running tests that depend on them. Explicit `ignoreChangedFiles` rules and built-in path ignores still win over membership; files not in the graph keep the conservative extension-based default.
- **Path canonicalization at all path boundaries** — a new `toCanonicalPath()` helper (`src/graph/normalize.ts`) resolves symlinks via `realpathSync` and normalizes separators to forward slashes, and every path boundary now routes through it: the plugin's `rootDir` (`vitest.config.root`, canonicalized once at init), git output (`src/git.ts` — repo toplevel and every changed/deleted path), cache keys and values on load (`src/graph/cache.ts`), caller-provided `changedFiles`, `setupFiles`, test-file glob results, the runtime reporter's module paths (`src/plugin.ts`), resolver output (`src/graph/builder.ts`), and `toRepoRelative` (`src/changed-files.ts`). This fixes the recurring path-identity silent-failure class: two aliases of the same file (macOS `/var` → `/private/var` temp symlink, a symlinked project root, Windows separators) compared unequal as graph keys, so changed files silently missed their graph entries and tests were under-selected. `toCanonicalPath` is memoized per process, falls back to canonicalizing the nearest existing ancestor for paths that don't exist (git-reported deletions) instead of throwing, and leaves non-absolute-on-this-platform inputs (e.g. a Windows drive path examined on POSIX) as forward-slash-normalized only — realpathing those would resolve against `cwd` and fabricate a bogus path. See ⚠️ BREAKING above for the cache-key implications.
- **`globalSetup` changes now force a full-suite run** — `setupFiles` changes already did this, but `globalSetup` (a sibling field on the resolved config, also `string | string[]`) was completely untracked: changing it silently ran a stale selective subset instead of the full suite. Mirrors the `setupFiles` idiom exactly (resolve-relative-to-root → canonicalize → `Set` → match against the raw changed+deleted set), new stats `reason: "global-setup-change"`.

## [0.5.0] - 2026-05-03

### Fixed

- **Vitest 4 compatibility** — Vitest 4 gates `getImportDurations()` on `experimental.importDurations.limit` (default `0`), which silently disabled the runtime reverse-graph reporter. Anyone on `vitest@4` got a no-op plugin with no error. The plugin now force-enables collection in `configureVitest` by setting `limit` to `Number.MAX_SAFE_INTEGER`. Spread to a new object to avoid mutating the default reference shared across workspace projects in v4. Harmless on Vitest 3.2.x where the `limit` field is ignored.

### Changed

- `peerDependencies.vitest` widened from `>=3.2.0` to `>=3.2.0 <5.0.0`
- `oxc-resolver` upgraded from `^6.0.0` to `^11.0.0` — five majors of drift; our usage (one `ResolverFactory` constructor + `.sync()` call) is unaffected by intermediate breaking changes (removed `description_files`/`modules` options in v8, manual `references` list in v11.15)
- `oxc-parser` `^0.114.0` → `^0.128.0`
- `tinyglobby` `^0.2.0` → `^0.2.16`
- `@types/node` `^25.3.0` → `^25.6.0`
- Replaced per-file "Changed file not in dependency graph" verbose warnings with a single summary count

### Added

- **Changed-file filtering** — irrelevant changed files (markdown, `.claude/`, `.next/`, `playwright-report/`, generated typings, etc.) are now filtered before graph analysis, removing parse warnings and "not in graph" noise for files that can never participate in the dependency graph
- New `VitestAffectedOptions` keys:
  - `ignoreChangedFiles?: Array<string | RegExp>` — extra path prefixes/regexes to filter
  - `includeChangedExtensions?: string[]` — override the default code-extension allowlist
  - `respectProvidedChangedFiles?: boolean` — opt out of filtering when caller passes `changedFiles`
- `ignoredFiles` count added to `statsFile` JSON-line output
- Config-file basenames (`package.json`, `tsconfig.json`, `vitest.config.*`, lockfiles) always pass through the filter so the full-suite trigger still fires

## [0.4.1] - 2026-02-25

### Fixed

- Normalize all file paths to forward slashes for Windows compatibility — git output, oxc-resolver output, `changedFiles` option, and glob results now consistently use `/` (Vite convention), fixing silent BFS failures on Windows
- `isUnderRootDir` in cache.ts used `path.sep` but stored paths use `/` — every cache load was a miss on Windows
- `CONFIG_BASENAMES` missing `.cts`/`.cjs` variants — changing `vitest.config.cts` or `vite.config.cjs` would not trigger full-suite safety fallback
- `setupFiles` comparison against changed files now resolves to absolute paths — relative setupFile paths from Vitest no longer silently bypass the full-suite trigger
- `writeStatsLine` now logs errors in verbose mode instead of silently swallowing all failures

## [0.4.0] - 2026-02-25

### Changed

- **Runtime-first architecture** — replaced static analysis pipeline (~1,500 lines) with runtime `importDurations` from Vitest. First run executes full suite and caches the reverse dependency map; subsequent runs load the cache, delta-parse only changed files (~5ms), and BFS-select affected tests.
- v2 cache format (`{ version: 2, builtAt, reverseMap }`) with automatic v1 migration
- `builder.ts` reduced from ~253 to ~133 lines — removed `buildFullGraph`/`buildFullGraphSync`, kept `deltaParseNewImports`
- `cache.ts` reduced from ~834 to ~210 lines — removed all v1-only functions
- `plugin.ts` rewritten around `configureVitest` hook with runtime reporter injection
- Net reduction: **-2,969 lines** across source and tests

### Fixed

- Cache overwrite on selective runs — was replacing entire cache with edges from only the tests that ran, destroying graph data for non-running tests. Now uses per-test merge strategy.
- Stale edge pruning — cache was grow-only (never removed edges for deleted imports). Now prunes edges for tests that ran before re-adding fresh ones.
- `testModule.moduleId` not normalized — un-normalized paths with query strings failed `testFileSet.has()` lookup, silently dropping affected tests
- `path.isAbsolute()` instead of `startsWith('/')` for Windows compatibility in reporter guards
- Vite paths use `/` (reporter context) vs `path.sep` for oxc-resolver (builder context) — fixed cross-platform path handling across both domains
- Snapshot map before `clear()` in `onEdgesCollected` callback — prevents latent data loss if callback becomes async
- `saveCacheSync` cleanup on `renameSync` failure — temp files no longer leak on cross-device rename errors
- Initialize `reverse` map at declaration — prevents stale state across watch-mode re-invocations
- Hoist `rootPrefix` computation outside inner loop in `resolveFileImports`
- Replace `require('node:fs')` with ESM import in test file

### Removed

- `buildFullGraph`, `buildFullGraphSync`, `GRAPH_GLOB_PATTERN`, `GRAPH_GLOB_IGNORE` from builder
- `loadOrBuildGraph`, `loadOrBuildGraphSync`, `saveGraph`, `saveGraphSyncInternal`, `statAllFiles`, `diffGraphMtimes`, `loadCachedMtimes`, `pruneRuntimeEdges`, `entriesToMaps`, `isValidFilesObject` from cache
- 4 obsolete v1 test files (cache.test.ts, cache-sync.test.ts, cache-robustness.test.ts, cache-new-file-discovery.test.ts)

## [0.3.0] - 2026-02-24

### Added

- Dependency graph caching — graph persists to `.vitest-affected/graph.json` with mtime-based staleness detection; only changed files are re-parsed on subsequent runs
- Incremental cache loading — `loadOrBuildGraph` and `loadOrBuildGraphSync` check file mtimes and re-parse only stale entries
- New file discovery on incremental loads — glob pass detects files added since last cache write
- Watch mode support — runtime reporter captures actual module imports during test execution via `onTestModuleEnd` / `importDurations` diagnostic
- Runtime edge merging — `mergeRuntimeEdges` unions runtime-observed imports into the static reverse graph for more accurate watch-cycle filtering
- `cache` option (default: `true`) to control graph caching behavior
- Schema validation for cached graph files (version check, required fields)
- Path confinement — cached paths are validated against project root to prevent directory traversal
- Stale entry pruning — orphaned cache entries are removed on save

### Fixed

- `normalizeModuleId` off-by-one: `/@fs/` prefix is 5 characters, not 4 — `id.slice(4)` left a double-slash breaking watch filter matching
- Add forward-graph guard in runtime reporter callback — prevents crash if `onEdgesCollected` fires before `configureVitest` populates the forward map
- Validate and prune `runtimeEdges` from existing cache before merging in `saveGraph` async path
- Remove redundant `existsSync` call before `lstatSync` in `loadOrBuildGraph`
- Add `safeJsonReviver` to all 5 `JSON.parse` call sites to prevent prototype pollution via `__proto__`/`constructor`/`prototype` keys

## [0.2.1] - 2026-02-23

### Fixed

- Add `extensionAlias` to oxc-resolver config for ESM `.js` → `.ts` import resolution — without this, the dependency graph was empty for any project using ESM-style `.js` extensions in TypeScript imports
- Fix unsafe type assertion in git exec helper — use `instanceof Error` narrowing instead of `as` cast
- Remove dead `setupFileSet.has(path.basename(f))` fallback in setup file detection
- Remove unused `allowNoTests` option from `VitestAffectedOptions` interface
- Add `project.config.exclude` to test file glob for correct filtering
- Skip template literal dynamic imports containing `${}` expressions (non-resolvable)

### Changed

- Reorder package.json exports: `types` before `import` for correct TypeScript resolution
- Add `repository`, `homepage`, `bugs`, and `sideEffects` fields to package.json
- Add warning when no test files match include patterns
- Add verbose warning when no affected tests found

## [0.2.0] - 2026-02-23

### Added

- Implement dependency graph builder with oxc-parser and oxc-resolver (`src/graph/builder.ts`)
- Implement git integration with 4 parallel git commands for changed/deleted file detection (`src/git.ts`)
- Implement BFS test selector that walks the reverse dependency graph (`src/selector.ts`)
- Wire full plugin orchestration in the `configureVitest` hook with 17-step pipeline (`src/plugin.ts`)
- Add `changedFiles` option to bypass git diff and provide changed files directly
- Add `ref` option for CI diffing against a base branch
- Add `threshold` option to fall back to full suite when affected ratio exceeds limit
- Add `verbose` option for diagnostic logging
- Add environment variable override `VITEST_AFFECTED_DISABLED=1`
- Add watch mode and workspace guards with graceful fallback
- Add config file and setup file change detection for force-rerun

### Fixed

- Fix `startsWith(rootDir)` path boundary bug that matched sibling directories with shared prefixes
- Add `**/test/fixtures/**` to graph glob ignore list
- Add parse error warnings when oxc-parser encounters malformed source files
- Add missing tsconfig.json warning when path aliases cannot resolve

## [0.1.0] - 2026-02-22

### Added

- Scaffold project structure with TypeScript, tsup, and Vitest
- Add stub implementations for plugin, graph builder, git, and selector modules
