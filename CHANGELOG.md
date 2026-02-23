# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
