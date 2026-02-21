// TODO: Phase 1 implementation
// - Vitest configureVitest plugin hook (v3.1+)
// - On test run: load/build cached dependency graph
// - Get changed files from git (3 commands: committed, staged, unstaged)
// - BFS reverse graph to find affected test files
// - TWO filtering mechanisms (BOTH VERIFIED to work on Vitest 3.2.4):
//   1. One-shot mode: mutate vitest.config.include → absolute paths of affected tests
//   2. Watch mode: vitest.onFilterWatchedSpecification(spec => boolean)
//
// GRACEFUL FALLBACK: if graph/git/BFS fails, don't modify config → runs full suite
//
// Key types:
//   /// <reference types="vitest/config" />
//   import type { Plugin } from 'vite'
//   VitestPluginContext: { vitest, project, injectTestProjects }
//   TestSpecification: spec.moduleId = absolute file path
/// <reference types="vitest/config" />
import type { Plugin } from "vite";

export interface VitestSmartOptions {
  /** Disable smart filtering (run all tests) */
  disabled?: boolean;
  /** Git ref to diff against (default: auto-detect) */
  ref?: string;
  /** Validate accuracy: run affected tests, then full suite, compare results */
  verify?: boolean;
}

export function vitestSmart(_options: VitestSmartOptions = {}): Plugin {
  return {
    name: "vitest:smart",

    // configureVitest runs during _setServer(), before start()
    // Mutating vitest.config.include here DOES affect globTestSpecifications()
    // (Empirically verified 2026-02-21 on Vitest 3.2.4)
    async configureVitest({ vitest }: any) {
      if (_options.disabled) return;

      // TODO: implement
      // try {
      //   const graph = await loadOrBuildGraph(vitest.config.root);
      //   const changedFiles = await getChangedFiles(vitest.config.root, _options.ref);
      //   const affectedTests = bfsAffectedTests(changedFiles, graph.reverse);
      //
      //   // One-shot mode
      //   vitest.config.include = [...affectedTests];
      //
      //   // Watch mode
      //   vitest.onFilterWatchedSpecification((spec: any) =>
      //     affectedTests.has(spec.moduleId)
      //   );
      // } catch (err) {
      //   // Graceful fallback — don't modify config, runs full suite
      //   console.warn('[vitest-smart] Error — running full suite:', err);
      // }
    },
  };
}
