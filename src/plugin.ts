// TODO: Phase 1 implementation
// - Vitest configureVitest plugin hook (v3.1+)
// - On test run: load/build cached dependency graph
// - Get changed files from git (3 commands: committed, staged, unstaged)
// - BFS reverse graph to find affected test files
// - TWO filtering mechanisms:
//   1. One-shot mode: mutate vitest.config.include before start() globs
//   2. Watch mode: vitest.onFilterWatchedSpecification(spec => boolean)
//
// Key types:
//   /// <reference types="vitest/config" />
//   import type { Plugin } from 'vite'
//   VitestPluginContext: { vitest, project, injectTestProjects }
//   TestSpecification: spec.moduleId = absolute file path

export interface VitestSmartOptions {
  /** Disable smart filtering (run all tests) */
  disabled?: boolean;
  /** Git ref to diff against (default: auto-detect) */
  ref?: string;
}

export function vitestSmart(_options: VitestSmartOptions = {}) {
  return {
    name: "vitest:smart",
    // configureVitest hook will go here
  };
}
