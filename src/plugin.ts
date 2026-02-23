/// <reference types="vitest/config" />
import type { Plugin } from 'vite';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { glob, globSync } from 'tinyglobby';
import { buildFullGraph } from './graph/builder.js';
import { loadOrBuildGraph, saveGraph, loadOrBuildGraphSync, saveGraphSyncInternal, loadCachedMtimes, statAllFiles, diffGraphMtimes } from './graph/cache.js';
import { normalizeModuleId } from './graph/normalize.js';
import { getChangedFiles } from './git.js';
import { bfsAffectedTests } from './selector.js';

export interface VitestAffectedOptions {
  disabled?: boolean;
  ref?: string;
  changedFiles?: string[];
  verbose?: boolean;
  threshold?: number;
  allowNoTests?: boolean; // If true, allow selecting 0 tests (default: false — runs full suite instead)
  cache?: boolean; // Enable graph caching (default: true)
}

/**
 * Config file basenames that, when changed, should trigger a full test suite run.
 * Changes to these files affect the entire project rather than specific modules.
 */
const CONFIG_BASENAMES = new Set([
  'package.json',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'tsconfig.json',
  'vitest.config.ts',
  'vitest.config.js',
  'vitest.config.mts',
  'vitest.config.mjs',
  'vitest.workspace.ts',
  'vitest.workspace.js',
  'vitest.workspace.mts',
  'vitest.workspace.mjs',
  'vite.config.ts',
  'vite.config.js',
  'vite.config.mts',
  'vite.config.mjs',
]);

export function vitestAffected(options: VitestAffectedOptions = {}): Plugin {
  return {
    name: 'vitest-affected',
    async configureVitest({ vitest, project }) {
      try {
        // 1. Env override
        let { disabled = false } = options;
        if (process.env.VITEST_AFFECTED_DISABLED === '1') {
          disabled = true;
        }

        // 2. Disabled check
        if (disabled) {
          return;
        }

        // 4. Workspace guard
        if (vitest.projects.length > 1) {
          console.warn(
            '[vitest-affected] Workspace with multiple projects detected — skipping test selection, running full suite',
          );
          return;
        }

        // 5. Config shape validation
        if (
          !vitest.config ||
          !vitest.config.root ||
          !project.config ||
          !project.config.include
        ) {
          console.warn(
            '[vitest-affected] Unexpected config shape — running full suite',
          );
          return;
        }

        const rootDir = vitest.config.root;
        const verbose = options.verbose ?? false;

        // Capture BEFORE any mutation of project.config.include
        const originalInclude = [...project.config.include];
        const originalExclude = [...(project.config.exclude ?? [])];

        // 6. Build graph
        const cacheDir = path.join(rootDir, '.vitest-affected');

        // Mutable state — shared between one-shot path and watch callback
        let forward: Map<string, Set<string>>;
        let reverse: Map<string, Set<string>>;
        let currentAffectedSet: Set<string> | null = null;
        let lastRunAt = Date.now();

        ({ forward, reverse } = options.cache !== false
          ? await loadOrBuildGraph(rootDir, cacheDir, verbose)
          : await buildFullGraph(rootDir));
        if (options.cache !== false) await saveGraph(forward, cacheDir);

        // Register watch-mode filter (fires on subsequent reruns, not initial run)
        if (vitest.config.watch) {
          const PERF_CEILING_MS = 300;
          let perfCeilingExceeded = false;

          vitest.onFilterWatchedSpecification((spec) => {
            try {
              // CRITICAL: onFilterWatchedSpecification acts as a refinement FILTER, not a selector.
              // Vitest's runtime module graph determines which tests are CANDIDATES.
              // Our static graph removes FALSE POSITIVES (specs Vitest selected but we know aren't affected).
              // Conservative: return true for specs not in our graph — we cannot add tests Vitest missed.

              // Batch reset: if enough time passed since last computation, reset affected set
              if ((currentAffectedSet || perfCeilingExceeded) && Date.now() - lastRunAt > 500) {
                currentAffectedSet = null;
                perfCeilingExceeded = false;
              }

              // Perf ceiling was hit earlier in this batch — skip rebuild, pass through
              if (perfCeilingExceeded) return true;

              if (!currentAffectedSet) {
                // First filter call in this batch — rebuild and detect changes
                const buildStart = Date.now();

                const oldMtimes = loadCachedMtimes(cacheDir);
                const { forward: newForward, reverse: newReverse } =
                  loadOrBuildGraphSync(rootDir, cacheDir);

                const buildDuration = Date.now() - buildStart;
                if (buildDuration > PERF_CEILING_MS) {
                  // Performance ceiling exceeded — fall back to pass-through for entire batch
                  console.warn(
                    `[vitest-affected] Graph build took ${buildDuration}ms (>${PERF_CEILING_MS}ms) — passing through all specs`,
                  );
                  perfCeilingExceeded = true;
                  lastRunAt = Date.now();
                  return true;
                }

                forward = newForward;
                reverse = newReverse;

                const currentMtimes = statAllFiles(forward.keys());
                const { changed, added } = diffGraphMtimes(oldMtimes, currentMtimes);
                const bfsSeeds = [...changed, ...added];

                const testFiles = globSync(originalInclude, {
                  cwd: rootDir,
                  absolute: true,
                  ignore: [...originalExclude, '**/node_modules/**'],
                });
                const testFileSet = new Set(testFiles);
                const affected = bfsAffectedTests(
                  bfsSeeds,
                  reverse,
                  (f) => testFileSet.has(f),
                );
                currentAffectedSet = new Set(affected);
                lastRunAt = Date.now();

                saveGraphSyncInternal(forward, cacheDir);
              }

              // CRITICAL: normalize before lookup
              const moduleId = normalizeModuleId(spec.moduleId);

              // Conservative: keep specs not in our graph
              if (!forward.has(moduleId)) return true;
              return currentAffectedSet.has(moduleId);
            } catch (err) {
              // Safety invariant: never crash Vitest — fall back to full suite
              console.warn(
                `[vitest-affected] Watch filter error — passing through all specs: ${err instanceof Error ? err.message : String(err)}`,
              );
              return true;
            }
          });
        }

        // 7. Get changed files
        let changed: string[];
        let deleted: string[];

        if (options.changedFiles !== undefined) {
          // Resolve relative paths to rootDir; split by existsSync
          const resolved = options.changedFiles.map((f) =>
            path.isAbsolute(f) ? f : path.resolve(rootDir, f),
          );
          changed = resolved.filter((f) => existsSync(f));
          deleted = resolved.filter((f) => !existsSync(f));
        } else {
          const result = await getChangedFiles(rootDir, options.ref);
          changed = result.changed;
          deleted = result.deleted;
        }

        // 8. No changes check — run full suite
        if (changed.length === 0 && deleted.length === 0) {
          return;
        }

        // 9. Deleted file handling — Phase 1 limitation: fall back to full suite
        if (deleted.length > 0) {
          console.warn(
            '[vitest-affected] Deleted files detected — running full suite (Phase 1 limitation)',
          );
          return;
        }

        // 10. Force-rerun check: config file or setupFiles changes → full suite
        const hasConfigChange = changed.some((f) =>
          CONFIG_BASENAMES.has(path.basename(f)),
        );
        if (hasConfigChange) {
          console.warn(
            '[vitest-affected] Config file change detected — running full suite',
          );
          return;
        }

        const setupFiles = project.config.setupFiles ?? [];
        const setupFileSet = new Set(
          Array.isArray(setupFiles) ? setupFiles : [setupFiles],
        );
        const hasSetupFileChange = changed.some((f) => setupFileSet.has(f));
        if (hasSetupFileChange) {
          console.warn(
            '[vitest-affected] Setup file change detected — running full suite',
          );
          return;
        }

        // 11. Glob test files using project.config.include patterns
        const includePatterns = project.config.include;
        if (!includePatterns || includePatterns.length === 0) {
          console.warn(
            '[vitest-affected] No include patterns configured — running full suite',
          );
          return;
        }

        const testFiles = await glob(includePatterns, {
          cwd: rootDir,
          absolute: true,
          ignore: [...(project.config.exclude ?? []), '**/node_modules/**'],
        });

        if (testFiles.length === 0) {
          console.warn(
            '[vitest-affected] No test files matched include patterns — running full suite',
          );
          return;
        }

        const testFileSet = new Set(testFiles);

        // 12. BFS: find affected tests
        const affectedTests = bfsAffectedTests(
          changed,
          reverse,
          (f) => testFileSet.has(f),
        );

        // 13. Threshold check
        if (affectedTests.length === 0) {
          if (options.allowNoTests) {
            project.config.include = [];
            return;
          }
          console.warn(
            '[vitest-affected] No affected tests found — running full suite',
          );
          return;
        }

        const ratio = affectedTests.length / testFiles.length;
        const threshold = options.threshold ?? 1.0;
        if (ratio > threshold) {
          console.warn(
            `[vitest-affected] Threshold exceeded (${affectedTests.length}/${testFiles.length} = ${(ratio * 100).toFixed(1)}%) — running full suite`,
          );
          return;
        }

        // 14. Verbose warnings: log changed files not in graph
        if (options.verbose) {
          for (const f of changed) {
            if (!reverse.has(f)) {
              console.warn(
                `[vitest-affected] Changed file not in dependency graph: ${f}`,
              );
            }
          }
        }

        // 15. existsSync filter — warn on missing
        const validTests = affectedTests.filter((f) => {
          if (!existsSync(f)) {
            console.warn(
              `[vitest-affected] Affected test file not found on disk: ${f}`,
            );
            return false;
          }
          return true;
        });

        // 16. Apply results
        if (validTests.length > 0) {
          project.config.include = validTests;
        }
        // else: no valid affected tests — full suite runs as fallback
      } catch (err) {
        // 17. Catch-all: safety invariant — never crash, never skip silently
        console.warn(
          `[vitest-affected] Unexpected error — running full suite: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}
