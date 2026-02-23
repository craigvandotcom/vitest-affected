# AGENTS.md — Subagent Context

## Project Overview

| Field       | Value                                                                 |
| ----------- | --------------------------------------------------------------------- |
| **Name**    | vitest-affected                                                       |
| **Stack**   | TypeScript / Vitest Plugin API / oxc-parser / oxc-resolver / tinyglobby |
| **Type**    | Library (Vitest plugin, ESM-only)                                     |
| **Purpose** | Intelligent test selection — run only tests affected by your changes  |

## Project Commands

| Operation        | Command                                              |
| ---------------- | ---------------------------------------------------- |
| **Dev server**   | N/A (library, not a server)                          |
| **Test**         | `npx vitest run`                                     |
| **Test (single)**| `npx vitest run test/path/to/file.test.ts`           |
| **Lint**         | `tsc --noEmit`                                       |
| **Type-check**   | `tsc --noEmit`                                       |
| **Format**       | N/A (no formatter configured)                        |
| **Build**        | `npm run build`                                      |
| **Quality gate** | `tsc --noEmit && npx vitest run && npm run build`    |

## Architecture

```
vitest-affected/
├── src/
│   ├── index.ts          # Public API: vitestAffected() + VitestAffectedOptions type
│   ├── plugin.ts         # Vitest plugin — configureVitest({ vitest, project }) orchestration
│   ├── graph/
│   │   └── builder.ts    # oxc-parser + oxc-resolver → { forward, reverse } Map<string, Set<string>>
│   ├── git.ts            # 3 parallel git commands → { changed: string[], deleted: string[] }
│   └── selector.ts       # Pure BFS on reverse graph → affected test file paths
├── test/
│   ├── fixtures/         # Known-structure projects: simple/, diamond/, circular/
│   └── *.test.ts         # Unit + integration tests
├── _backlog/             # Master plan: intelligent-test-selection.md
├── .beads/               # beads_rust task management database
├── package.json          # ESM-only, peerDep vitest >=3.1.0
├── tsconfig.json         # Strict, ES2022, bundler resolution
├── tsup.config.ts        # Build: ESM-only, dts, clean
└── vitest.config.ts      # Test config: include test/**/*.test.ts, exclude test/fixtures/**
```

**Data flow:** `plugin.configureVitest` → `buildFullGraph(rootDir)` → `getChangedFiles(rootDir)` → `bfsAffectedTests(changed, reverse, isTestFile)` → mutate `project.config.include` to absolute paths.

**Runtime dependencies:** `oxc-parser`, `oxc-resolver`, and `tinyglobby` are runtime deps (used inside the plugin at test time), not devDependencies. They must be in `dependencies` so consumers get them transitively.

**Safety invariant:** Never silently skip tests. Any failure → fallback to full suite with warning.

## Available Skills

| Skill | Type | Trigger |
|---|---|---|
| `vitest-plugin-dev` | Model-invocable | Auto-activates for plugin code, oxc API, graph building, test selection |
| `bump-release` | User-invocable | `/bump-release [version] [--beta] [--dry-run]` |
| `commit` | User-invocable | `/commit [--all] [--deep] [--push]` |

Flywheel commands are in `.claude/commands/`.

## Rules

- TypeScript strict — no `any` types. Use proper Vitest/Vite types with `/// <reference types="vitest/config" />` triple-slash directive.
- All new modules must have corresponding test files. Build-only beads (scaffolding) are the exception.
- Graph data structures use `Map<string, Set<string>>` with absolute file paths throughout.
- `node_modules/` paths are never included in the dependency graph. Non-source imports (json, css) are leaf nodes.
- Test fixtures in `test/fixtures/` must have known dependency structures and `"type": "module"` in package.json.
- ESM-only output — no CJS build. Package exports only has `"import"` entry.
- Follow existing patterns in neighboring files before introducing new conventions.
