/// <reference types="vitest/config" />
import type { Plugin } from 'vite';
import type { Reporter, TestRunEndReason } from 'vitest/reporters';
import type { TestModule } from 'vitest/node';
import { existsSync, appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { glob } from 'tinyglobby';
import { deltaParseNewImports } from './graph/builder.js';
import { loadCachedReverseMap, saveCacheSync } from './graph/cache.js';
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
  statsFile?: string; // Path to append JSON-line stats after each run (e.g. '.vitest-affected/stats.jsonl')
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
  'vitest.config.cts',
  'vitest.config.cjs',
  'vitest.workspace.ts',
  'vitest.workspace.js',
  'vitest.workspace.mts',
  'vitest.workspace.mjs',
  'vitest.workspace.cts',
  'vitest.workspace.cjs',
  'vite.config.ts',
  'vite.config.js',
  'vite.config.mts',
  'vite.config.mjs',
  'vite.config.cts',
  'vite.config.cjs',
]);

/**
 * @internal
 * Creates a Vitest reporter that collects runtime dependency edges
 * by reading importDurations from each TestModule after it runs.
 *
 * Returns the reporter object and a setRootDir function to call once the
 * resolved rootDir is known (deferred because config() runs before configureVitest()).
 */
export function createRuntimeReporter(
  onEdgesCollected: (edges: Map<string, Set<string>>) => void,
): { reporter: Reporter; setRootDir: (dir: string) => void } {
  let rootDir: string | null = null;
  const runtimeReverse = new Map<string, Set<string>>();

  function setRootDir(dir: string): void {
    rootDir = dir;
  }

  function onTestModuleEnd(testModule: TestModule): void {
    const testPath = normalizeModuleId(testModule.moduleId);

    // Guard: rootDir not yet set
    if (!rootDir) return;

    // Guard: virtual module IDs are not absolute paths
    if (!path.isAbsolute(testPath)) return;

    const { importDurations } = testModule.diagnostic();
    // Vite normalizes all paths to forward slashes (even on Windows), so use '/' here.
    const rootPrefix = rootDir.endsWith('/') ? rootDir : rootDir + '/';

    for (const rawPath of Object.keys(importDurations)) {
      const modulePath = normalizeModuleId(rawPath);
      // Must be absolute
      if (!path.isAbsolute(modulePath)) continue;
      // Skip node_modules (Vite paths always use forward slashes)
      if (modulePath.includes('/node_modules/')) continue;
      // Must be under rootDir
      if (!modulePath.startsWith(rootPrefix)) continue;
      // Skip self-reference
      if (modulePath === testPath) continue;

      // Add reverse edge: modulePath → Set<testPath>
      if (!runtimeReverse.has(modulePath)) {
        runtimeReverse.set(modulePath, new Set());
      }
      runtimeReverse.get(modulePath)!.add(testPath);
    }
  }

  function onTestRunEnd(
    _testModules: ReadonlyArray<TestModule>,
    _errors: ReadonlyArray<unknown>,
    reason: TestRunEndReason,
  ): void {
    // Interrupt: skip both persistence and clear
    if (reason === 'interrupted') return;

    if (runtimeReverse.size > 0) {
      // Snapshot: pass a copy so clear() doesn't affect the callback's data
      const snapshot = new Map(
        [...runtimeReverse].map(([k, v]) => [k, new Set(v)]),
      );
      onEdgesCollected(snapshot);
    }
    runtimeReverse.clear();
  }

  const reporter: Reporter = {
    onTestModuleEnd,
    onTestRunEnd,
  };

  return { reporter, setRootDir };
}

function writeStatsLine(
  statsFile: string,
  rootDir: string,
  data: {
    action: string;
    reason?: string;
    changedFiles?: number;
    deletedFiles?: number;
    affectedTests?: number;
    totalTests?: number;
    graphSize?: number;
    cacheHit?: boolean;
    durationMs?: number;
  },
  verbose = false,
): void {
  try {
    const filePath = path.isAbsolute(statsFile) ? statsFile : path.resolve(rootDir, statsFile);
    mkdirSync(path.dirname(filePath), { recursive: true });
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...data });
    appendFileSync(filePath, line + '\n');
  } catch (err) {
    // Best-effort — never crash on stats writing
    if (verbose) {
      console.warn(
        `[vitest-affected] Failed to write stats: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export function vitestAffected(options: VitestAffectedOptions = {}): Plugin {
  // Hoisted state — shared between config() and configureVitest()
  let reverse: Map<string, Set<string>> = new Map();
  let cacheDir: string | undefined;

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

        // 3. Workspace guard
        if (vitest.projects.length > 1) {
          console.warn(
            '[vitest-affected] Workspace with multiple projects detected — skipping test selection, running full suite',
          );
          return;
        }

        // 4. Config shape validation
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
        const statsFile = options.statsFile;
        const startMs = Date.now();

        // 5. Load cached reverse map (runtime-first: JSON read, no parsing)
        cacheDir = path.join(rootDir, '.vitest-affected');

        let cacheHit: boolean;
        if (options.cache !== false) {
          ({ reverse, hit: cacheHit } = loadCachedReverseMap(cacheDir, rootDir, verbose));
        } else {
          reverse = new Map();
          cacheHit = false;
        }

        // Inject runtime reporter that merges runtime edges into cached reverse map.
        // On selective runs only a subset of tests execute, so we merge new edges
        // into the existing cache rather than replacing it (which would destroy
        // graph data for tests that didn't run this time).
        const { reporter, setRootDir } = createRuntimeReporter((edges) => {
          if (!cacheDir) return;
          try {
            // Per-test overwrite: collect which tests ran this cycle, then
            // remove their stale edges before adding new ones. This ensures
            // removed imports are reflected (not just accumulated forever).
            const ranTests = new Set<string>();
            for (const tests of edges.values()) {
              for (const t of tests) ranTests.add(t);
            }
            // Strip stale edges for tests that ran
            for (const [file, tests] of reverse) {
              for (const t of ranTests) tests.delete(t);
              if (tests.size === 0) reverse.delete(file);
            }
            // Add fresh edges from this run
            for (const [file, tests] of edges) {
              if (!reverse.has(file)) {
                reverse.set(file, new Set(tests));
              } else {
                for (const t of tests) {
                  reverse.get(file)!.add(t);
                }
              }
            }
            saveCacheSync(cacheDir, reverse);
          } catch {
            // Best-effort: runtime edge persistence failed — cache will be stale next run
          }
        });
        setRootDir(rootDir);

        // configureVitest fires BEFORE Vitest's createReporters assigns vitest.reporters.
        // A direct push onto the current (empty) array is lost when createReporters
        // overwrites it with a new array. Use a property setter to intercept that
        // assignment and append our reporter to whatever Vitest creates.
        const vitestAny = vitest as unknown as { reporters: Reporter[] };
        try {
          let _reporters = vitestAny.reporters;
          _reporters.push(reporter);
          Object.defineProperty(vitest, 'reporters', {
            configurable: true,
            enumerable: true,
            get() { return _reporters; },
            set(value: Reporter[]) {
              _reporters = value;
              if (!value.includes(reporter)) {
                value.push(reporter);
              }
            },
          });
        } catch {
          // Fallback: direct push (works in unit tests with plain mock objects)
          vitestAny.reporters.push(reporter);
        }

        // Register watch-mode filter: pass-through (Vitest's own module graph handles it)
        if (vitest.config.watch) {
          vitest.onFilterWatchedSpecification(() => true);
        }

        // 6. Get changed files
        let changed: string[];
        let deleted: string[];

        if (options.changedFiles !== undefined) {
          // Resolve relative paths to rootDir and normalize to forward slashes (Vite convention)
          const resolved = options.changedFiles.map((f) =>
            (path.isAbsolute(f) ? f : path.resolve(rootDir, f)).replaceAll('\\', '/'),
          );
          changed = resolved.filter((f) => existsSync(f));
          deleted = resolved.filter((f) => !existsSync(f));
        } else {
          const result = await getChangedFiles(rootDir, options.ref);
          changed = result.changed;
          deleted = result.deleted;
        }

        // 7. No changes check — run full suite
        if (changed.length === 0 && deleted.length === 0) {
          if (statsFile) writeStatsLine(statsFile, rootDir, {
            action: 'full-suite', reason: 'no-changes',
            changedFiles: 0, deletedFiles: 0, graphSize: reverse.size,
            durationMs: Date.now() - startMs,
          }, verbose);
          return;
        }

        // 8. Deleted file handling — treat as BFS seeds
        if (deleted.length > 0 && verbose) {
          console.warn(
            `[vitest-affected] ${deleted.length} deleted file(s) — will include as BFS seeds`,
          );
        }

        // 9. Force-rerun check: config file or setupFiles changes → full suite
        const allChangedFiles = [...changed, ...deleted];
        const hasConfigChange = allChangedFiles.some((f) =>
          CONFIG_BASENAMES.has(path.basename(f)),
        );
        if (hasConfigChange) {
          console.warn(
            '[vitest-affected] Config file change detected — running full suite',
          );
          if (statsFile) writeStatsLine(statsFile, rootDir, {
            action: 'full-suite', reason: 'config-change',
            changedFiles: changed.length, deletedFiles: deleted.length,
            graphSize: reverse.size, durationMs: Date.now() - startMs,
          }, verbose);
          return;
        }

        const setupFilesRaw = project.config.setupFiles ?? [];
        const setupFileSet = new Set(
          (Array.isArray(setupFilesRaw) ? setupFilesRaw : [setupFilesRaw]).map(
            (f) => (path.isAbsolute(f) ? f : path.resolve(rootDir, f)).replaceAll('\\', '/'),
          ),
        );
        const hasSetupFileChange = allChangedFiles.some((f) => setupFileSet.has(f));
        if (hasSetupFileChange) {
          console.warn(
            '[vitest-affected] Setup file change detected — running full suite',
          );
          if (statsFile) writeStatsLine(statsFile, rootDir, {
            action: 'full-suite', reason: 'setup-file-change',
            changedFiles: changed.length, deletedFiles: deleted.length,
            graphSize: reverse.size, durationMs: Date.now() - startMs,
          }, verbose);
          return;
        }

        // 10. Cache miss → full suite (first run collects runtime data)
        if (!cacheHit) {
          if (verbose) {
            console.warn(
              '[vitest-affected] No cached runtime graph — running full suite (will populate cache after run)',
            );
          }
          if (statsFile) writeStatsLine(statsFile, rootDir, {
            action: 'full-suite', reason: 'cache-miss',
            changedFiles: changed.length, deletedFiles: deleted.length,
            graphSize: 0, cacheHit: false,
            durationMs: Date.now() - startMs,
          }, verbose);
          return;
        }

        // 11. Delta parse: find new imports in changed files not yet in cache
        const extraSeeds = deltaParseNewImports(changed, reverse, rootDir, verbose);
        const bfsSeeds = [...allChangedFiles, ...extraSeeds];

        // 12. Glob test files using project.config.include patterns
        const includePatterns = project.config.include;
        if (!includePatterns || includePatterns.length === 0) {
          console.warn(
            '[vitest-affected] No include patterns configured — running full suite',
          );
          return;
        }

        // Normalize glob results to forward slashes (Vite convention) for Windows compat
        const testFiles = (await glob(includePatterns, {
          cwd: rootDir,
          absolute: true,
          ignore: [...(project.config.exclude ?? []), '**/node_modules/**'],
        })).map((f) => f.replaceAll('\\', '/'));

        if (testFiles.length === 0) {
          console.warn(
            '[vitest-affected] No test files matched include patterns — running full suite',
          );
          return;
        }

        const testFileSet = new Set(testFiles);

        // 13. BFS: find affected tests
        const affectedTests = bfsAffectedTests(
          bfsSeeds,
          reverse,
          (f) => testFileSet.has(f),
        );

        // 14. Threshold check
        if (affectedTests.length === 0) {
          if (options.allowNoTests) {
            project.config.include = [];
            if (statsFile) writeStatsLine(statsFile, rootDir, {
              action: 'selective', reason: 'allow-no-tests',
              changedFiles: changed.length, deletedFiles: deleted.length,
              affectedTests: 0, totalTests: testFiles.length,
              graphSize: reverse.size, cacheHit, durationMs: Date.now() - startMs,
            }, verbose);
            return;
          }
          console.warn(
            '[vitest-affected] No affected tests found — running full suite',
          );
          if (statsFile) writeStatsLine(statsFile, rootDir, {
            action: 'full-suite', reason: 'no-affected-tests',
            changedFiles: changed.length, deletedFiles: deleted.length,
            affectedTests: 0, totalTests: testFiles.length,
            graphSize: reverse.size, cacheHit, durationMs: Date.now() - startMs,
          }, verbose);
          return;
        }

        const ratio = affectedTests.length / testFiles.length;
        const threshold = options.threshold ?? 1.0;
        if (ratio > threshold) {
          console.warn(
            `[vitest-affected] Threshold exceeded (${affectedTests.length}/${testFiles.length} = ${(ratio * 100).toFixed(1)}%) — running full suite`,
          );
          if (statsFile) writeStatsLine(statsFile, rootDir, {
            action: 'full-suite', reason: 'threshold-exceeded',
            changedFiles: changed.length, deletedFiles: deleted.length,
            affectedTests: affectedTests.length, totalTests: testFiles.length,
            graphSize: reverse.size, cacheHit, durationMs: Date.now() - startMs,
          }, verbose);
          return;
        }

        // 15. Verbose warnings: log changed files not in graph
        if (options.verbose) {
          for (const f of changed) {
            if (!reverse.has(f)) {
              console.warn(
                `[vitest-affected] Changed file not in dependency graph: ${f}`,
              );
            }
          }
        }

        // 16. existsSync filter — warn on missing
        const validTests = affectedTests.filter((f) => {
          if (!existsSync(f)) {
            console.warn(
              `[vitest-affected] Affected test file not found on disk: ${f}`,
            );
            return false;
          }
          return true;
        });

        // 17. Apply results
        if (validTests.length > 0) {
          project.config.include = validTests;
          if (statsFile) writeStatsLine(statsFile, rootDir, {
            action: 'selective',
            changedFiles: changed.length, deletedFiles: deleted.length,
            affectedTests: validTests.length, totalTests: testFiles.length,
            graphSize: reverse.size, cacheHit, durationMs: Date.now() - startMs,
          }, verbose);
        } else if (statsFile) {
          writeStatsLine(statsFile, rootDir, {
            action: 'full-suite', reason: 'no-valid-tests-on-disk',
            changedFiles: changed.length, deletedFiles: deleted.length,
            affectedTests: 0, totalTests: testFiles.length,
            graphSize: reverse.size, cacheHit, durationMs: Date.now() - startMs,
          }, verbose);
        }
      } catch (err) {
        // 18. Catch-all: safety invariant — never crash, never skip silently
        console.warn(
          `[vitest-affected] Unexpected error — running full suite: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}
