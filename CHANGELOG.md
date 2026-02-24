# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
