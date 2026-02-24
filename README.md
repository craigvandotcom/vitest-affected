# vitest-affected

Intelligent test selection for Vitest. Maintains a dependency graph and runs only the tests affected by your changes.

Instead of running your entire test suite on every change, `vitest-affected` builds a dependency graph of your project's imports and uses `git diff` to determine which source files changed. It then walks the graph in reverse to find exactly which test files need to run.

## Install

```bash
npm install -D vitest-affected
```

## Setup

Add the plugin to your `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
import { vitestAffected } from 'vitest-affected';

export default defineConfig({
  plugins: [vitestAffected()],
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
```

That's it. On your next `vitest run`, only affected tests will execute.

## How It Works

1. **Build a dependency graph** using [oxc-parser](https://github.com/nicolo-ribaudo/oxc) and [oxc-resolver](https://github.com/nicolo-ribaudo/oxc) (static imports, dynamic imports, re-exports)
2. **Detect changed files** via `git diff` (unstaged, staged, and committed changes vs your base ref)
3. **Walk the reverse graph** using BFS to find all test files that transitively depend on the changed files
4. **Mutate `config.include`** so Vitest only runs the affected tests

If anything goes wrong (git fails, graph is incomplete, deleted files detected), the plugin falls back to running the full test suite with a warning. It never silently skips tests.

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

  // When true, allow 0 affected tests (skip entire suite). Default: false (runs full suite instead)
  allowNoTests: false,

  // Enable dependency graph caching to disk (default: true)
  cache: true,

  // Disable the plugin entirely
  disabled: false,
});
```

### Environment Variable

Set `VITEST_AFFECTED_DISABLED=1` to disable the plugin without changing config.

## Caching

Graph caching is enabled by default. The dependency graph is saved to `.vitest-affected/graph.json` after the first run. Subsequent runs reuse the cached graph — only files whose mtime has changed are re-parsed. This makes cold-start graph building a one-time cost.

Add `.vitest-affected/` to your `.gitignore`.

## Watch Mode

In `vitest --watch` mode, the plugin uses Vitest's runtime reporter to capture actual module imports at test runtime. These runtime edges are merged into the static graph, so the next watch cycle has more accurate dependency information. This handles cases where static analysis can't resolve dynamic imports.

## Requirements

- **Vitest** >= 3.2.0
- **Node.js** >= 18
- A **git** repository (the plugin uses `git diff` to detect changes)

## Config File Detection

Changes to project config files automatically trigger a full test suite run:

`package.json`, `tsconfig.json`, `vitest.config.*`, `vite.config.*`, lockfiles

Changes to Vitest `setupFiles` also trigger a full rerun.

## Limitations

- **Deleted files**: If git reports deleted files, the plugin falls back to the full suite (the graph can't resolve files that no longer exist)
- **Dynamic imports with template literals**: Imports like `` import(`./locale/${lang}.ts`) `` can't be statically resolved and are skipped
- **Non-TypeScript/JavaScript files**: CSS, JSON, and other asset imports are excluded from the graph

## License

MIT
