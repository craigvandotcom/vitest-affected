# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**vitest-affected** — Intelligent test selection for Vitest. Maintains a dependency graph and runs only tests affected by your changes. ESM-only Vitest plugin using `configureVitest` hook.

Stack: TypeScript, Vitest plugin API, oxc-parser, oxc-resolver, tinyglobby

## Commands

| Operation | Command |
|-----------|---------|
| Build | `npm run build` (tsup) |
| Test | `npx vitest run` |
| Test (single file) | `npx vitest run test/path/to/file.test.ts` |
| Type-check | `tsc --noEmit` |
| Lint | `tsc --noEmit` (TypeScript strict is the linter) |
| Quality gate | `npm run build && tsc --noEmit && tsc -p tsconfig.test.json --noEmit && VITEST_AFFECTED_DISABLED=1 npx vitest run` |

No separate eslint/prettier/biome — TypeScript strict mode is the only static analysis.

## Architecture

```
src/
├── index.ts          # Public API: vitestAffected() + VitestAffectedOptions type
├── plugin.ts         # Vitest plugin — configureVitest hook + runtime reporter
├── changed-files.ts  # filterRelevantChangedFiles/toRepoRelative — extension + ignore-path filtering of git changes
├── explain-core.ts   # Pure "why would/wouldn't test X be selected" decision logic, no IO
├── explain-cli.ts    # `vitest-affected-explain` bin — ad hoc CLI against on-disk cache + git state
├── runtime-merge.ts  # mergeRuntimeEdges — folds Vitest's importDurations into the reverse graph
├── graph/
│   ├── types.ts      # ReverseMap — canonical domain type
│   ├── builder.ts    # oxc-parser + oxc-resolver → deltaParseNewImports for changed files
│   ├── cache.ts      # v3 cache (rootDir-relative paths; v1/v2 read-migrated): loadCachedReverseMap / saveCacheSync
│   └── normalize.ts  # Strip Vite query strings, \0 prefixes, /@fs/ from module IDs
├── git.ts            # 4 parallel git commands → { changed[], deleted[] }
└── selector.ts       # Pure BFS on reverse graph → affected test file paths
```

**Data flow:** `plugin.configureVitest` orchestrates: load cached reverse map → get changed files → delta parse new imports → BFS reverse graph → mutate `project.config.include`. After each run, the runtime reporter collects `importDurations` and merges into the cache.

**Safety invariant:** Never silently skip tests. Any failure in graph/git/BFS → fallback to full suite with warning.

## Key Technical Decisions

- **oxc-parser** for import extraction (static + dynamic + re-exports), not esbuild/swc
- **oxc-resolver** for specifier → absolute path resolution with tsconfig support
- **ESM-only** output (`format: ['esm']` in tsup) — Vitest users are ESM-native
- **`configureVitest` hook** receives `{ vitest, project }` where `project.config.include` is mutated
- **`/// <reference types="vitest/config" />`** triple-slash directive required for type augmentation
- **peerDep `vitest >=3.2.0`** (configureVitest hook + importDurations require 3.2+)

## Beads Workflow

This project uses `beads_rust` (`br`) and `beads_viewer` (`bv`) for task management. Flywheel commands in `.claude/commands/`:

`/plan-init` → `/plan-refine-internal` → `/beadify` → `/bead-refine` → `/bead-work` → `/bead-land`

The master plan lives at `_backlog/intelligent-test-selection.md`. Beads are the implementation units — each is self-contained with acceptance criteria.

## Rules

- TypeScript strict — no `any` types (use proper Vitest/Vite types with triple-slash directives)
- All new modules must have corresponding test files
- `node_modules/` paths are never included in the dependency graph
- Graph maps use `Map<string, Set<string>>` with absolute file paths
- Test fixtures live in `test/fixtures/` with known dependency structures (simple, diamond, circular)

## Evidence badge

`_evidence/hero.svg` is the README's live miss-record hero card (embedded via
raw.githubusercontent, regenerated with current numbers).
Refresh it via `node scripts/update-evidence-badge.mjs` — reads the sibling
body-compass-app evidence log; no-ops when the sibling is absent. Wired as a
pre-commit hook: one-time `git config core.hooksPath .githooks` per clone.
