/// <reference types="vitest/config" />
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  lstatSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import type { Reporter, TestRunEndReason } from 'vitest/reporters';
import type { TestModule } from 'vitest/node';
import { vitestAffected } from '../src/plugin.js';
import { saveGraphSyncInternal } from '../src/graph/cache.js';
import * as cacheModule from '../src/graph/cache.js';

// ---------------------------------------------------------------------------
// Env save/restore (same pattern as plugin.test.ts)
// ---------------------------------------------------------------------------

let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env.VITEST_AFFECTED_DISABLED;
  delete process.env.VITEST_AFFECTED_DISABLED;
});

afterEach(() => {
  if (savedEnv !== undefined) {
    process.env.VITEST_AFFECTED_DISABLED = savedEnv;
  } else {
    delete process.env.VITEST_AFFECTED_DISABLED;
  }
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  tempDirs.length = 0;
});

const tempDirs: string[] = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal temp project:
 *   src/main.ts  (imports src/lib.ts)
 *   src/lib.ts
 *   src/orphan.ts (no importers)
 *   tests/main.test.ts (imports src/main.ts)
 *
 * Returns absolute paths to key files.
 */
function setupWatchFixture(): {
  tmpDir: string;
  mainTs: string;
  libTs: string;
  orphanTs: string;
  mainTestTs: string;
} {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'vitest-affected-watch-'));
  tempDirs.push(tmpDir);

  mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
  mkdirSync(path.join(tmpDir, 'tests'), { recursive: true });

  writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}');
  writeFileSync(
    path.join(tmpDir, 'src', 'lib.ts'),
    'export const lib = 42;\n',
  );
  writeFileSync(
    path.join(tmpDir, 'src', 'main.ts'),
    'import { lib } from "./lib";\nexport const main = lib + 1;\n',
  );
  writeFileSync(
    path.join(tmpDir, 'src', 'orphan.ts'),
    'export const orphan = 99;\n',
  );
  writeFileSync(
    path.join(tmpDir, 'tests', 'main.test.ts'),
    'import { main } from "../src/main";\nimport { test, expect } from "vitest";\ntest("main", () => expect(main).toBeDefined());\n',
  );

  return {
    tmpDir,
    mainTs: path.join(tmpDir, 'src', 'main.ts'),
    libTs: path.join(tmpDir, 'src', 'lib.ts'),
    orphanTs: path.join(tmpDir, 'src', 'orphan.ts'),
    mainTestTs: path.join(tmpDir, 'tests', 'main.test.ts'),
  };
}

/**
 * Create a watch-mode mock context.
 * Captures the onFilterWatchedSpecification callback.
 */
function createWatchMockContext(rootDir: string) {
  const projectConfig = {
    include: ['tests/**/*.test.ts'],
    exclude: [] as string[],
    setupFiles: [] as string[],
  };
  const mockProject = { config: projectConfig };

  let filterCallback: ((spec: { moduleId: string }) => boolean) | null = null;

  const mockVitest = {
    config: { root: rootDir, watch: true },
    projects: [mockProject],
    onFilterWatchedSpecification: (cb: (spec: { moduleId: string }) => boolean) => {
      filterCallback = cb;
    },
  };

  return {
    vitest: mockVitest,
    project: mockProject,
    projectConfig,
    getFilterCallback: () => filterCallback,
  };
}

/**
 * Helper to invoke the configureVitest hook.
 */
async function runHook(
  plugin: ReturnType<typeof vitestAffected>,
  vitest: ReturnType<typeof createWatchMockContext>['vitest'],
  project: ReturnType<typeof createWatchMockContext>['project'],
): Promise<void> {
  const hook = (plugin as Record<string, unknown>).configureVitest as (ctx: {
    vitest: typeof vitest;
    project: typeof project;
  }) => Promise<void>;
  await hook({ vitest, project });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('watch mode filter registration', () => {
  test('filter callback is registered in watch mode after plugin init', async () => {
    const { tmpDir } = setupWatchFixture();
    const { vitest, project, getFilterCallback } = createWatchMockContext(tmpDir);

    const plugin = vitestAffected({
      changedFiles: [],
      cache: true,
    });

    await runHook(plugin, vitest, project);

    // The callback should have been registered
    expect(getFilterCallback()).not.toBeNull();
    expect(typeof getFilterCallback()).toBe('function');
  });

  test('filter callback is NOT registered in non-watch mode', async () => {
    const { tmpDir } = setupWatchFixture();
    const projectConfig = {
      include: ['tests/**/*.test.ts'],
      exclude: [] as string[],
      setupFiles: [] as string[],
    };
    const mockProject = { config: projectConfig };

    let filterCallbackRegistered = false;
    const mockVitest = {
      config: { root: tmpDir, watch: false },
      projects: [mockProject],
      onFilterWatchedSpecification: (_cb: (spec: { moduleId: string }) => boolean) => {
        filterCallbackRegistered = true;
      },
    };

    const plugin = vitestAffected({ changedFiles: [], cache: false });
    const hook = (plugin as Record<string, unknown>).configureVitest as (ctx: {
      vitest: typeof mockVitest;
      project: typeof mockProject;
    }) => Promise<void>;
    await hook({ vitest: mockVitest, project: mockProject });

    expect(filterCallbackRegistered).toBe(false);
  });
});

describe('watch filter callback behavior', () => {
  test('unknown spec (not in forward graph) returns true (conservative fallback)', async () => {
    const { tmpDir } = setupWatchFixture();
    const { vitest, project, getFilterCallback } = createWatchMockContext(tmpDir);

    const plugin = vitestAffected({ changedFiles: [], cache: true });
    await runHook(plugin, vitest, project);

    const filter = getFilterCallback();
    expect(filter).not.toBeNull();

    // A moduleId not in our graph should pass through
    const result = filter!({ moduleId: '/nonexistent/path/that/is/not/in/graph.ts' });
    expect(result).toBe(true);
  });

  test('affected spec (in changed dependency chain) returns true', async () => {
    const { tmpDir, libTs, mainTestTs } = setupWatchFixture();
    const { vitest, project, getFilterCallback } = createWatchMockContext(tmpDir);

    const cacheDir = path.join(tmpDir, '.vitest-affected');
    const mainTs = path.join(tmpDir, 'src', 'main.ts');
    const orphanTs = path.join(tmpDir, 'src', 'orphan.ts');

    // Run the plugin to get the filter registered (also writes current-mtime cache)
    const plugin = vitestAffected({ changedFiles: [], cache: true });
    await runHook(plugin, vitest, project);

    // NOW overwrite the cache with a stale mtime for libTs.
    // The filter reads the cache lazily when invoked, so this stale cache will
    // be read on the first filter call, making libTs appear "changed".
    const forward = new Map<string, Set<string>>([
      [mainTestTs, new Set([mainTs])],
      [mainTs, new Set([libTs])],
      [libTs, new Set()],
      [orphanTs, new Set()],
    ]);
    const staleMtimes = new Map([
      [mainTestTs, lstatSync(mainTestTs).mtimeMs],
      [mainTs, lstatSync(mainTs).mtimeMs],
      [libTs, 0], // stale — will appear "changed" when compared to real mtime
      [orphanTs, lstatSync(orphanTs).mtimeMs],
    ]);
    saveGraphSyncInternal(forward, cacheDir, staleMtimes);

    const filter = getFilterCallback();
    expect(filter).not.toBeNull();

    // mainTestTs imports mainTs which imports libTs (the "changed" file)
    // So mainTestTs should be in the affected set → filter returns true
    const result = filter!({ moduleId: mainTestTs });
    expect(result).toBe(true);
  });

  test('unaffected spec: stale cache triggers full-rebuild pass-through (not BFS filtering)', async () => {
    // With the new design, loadOrBuildGraphSync does FULL REBUILD when any file is stale,
    // returning empty mtime maps. The full-rebuild guard then passes ALL specs through.
    // This is correct — when a rebuild occurred, we conservatively include all specs.

    const { tmpDir, libTs, mainTestTs } = setupWatchFixture();

    const cacheDir = path.join(tmpDir, '.vitest-affected');
    const mainTs = path.join(tmpDir, 'src', 'main.ts');
    const orphanTs = path.join(tmpDir, 'src', 'orphan.ts');

    const { vitest, project, getFilterCallback } = createWatchMockContext(tmpDir);
    const plugin = vitestAffected({ changedFiles: [], cache: true });
    await runHook(plugin, vitest, project);

    // Overwrite cache with stale mtime for libTs
    const forward = new Map<string, Set<string>>([
      [mainTestTs, new Set([mainTs])],
      [mainTs, new Set([libTs])],
      [libTs, new Set()],
      [orphanTs, new Set()],
    ]);
    const staleMtimes = new Map([
      [mainTestTs, lstatSync(mainTestTs).mtimeMs],
      [mainTs, lstatSync(mainTs).mtimeMs],
      [libTs, 0], // stale → triggers full rebuild
      [orphanTs, lstatSync(orphanTs).mtimeMs],
    ]);
    saveGraphSyncInternal(forward, cacheDir, staleMtimes);

    const filter = getFilterCallback();
    expect(filter).not.toBeNull();

    // With stale cache → full rebuild → pass-through for ALL specs.
    // orphanTs is in the forward graph, but full-rebuild guard passes it through too.
    const result = filter!({ moduleId: orphanTs });
    expect(result).toBe(true);
  });

  test('no-change scenario: spec in forward graph with fresh cache returns false (no BFS seeds)', async () => {
    // When the cache is completely fresh (all mtimes current), loadOrBuildGraphSync
    // returns non-empty mtime maps (cache hit). diffGraphMtimes finds 0 changed/added.
    // BFS with empty seeds → empty affected set → known specs return false.

    const { tmpDir, mainTestTs } = setupWatchFixture();
    const { vitest, project, getFilterCallback } = createWatchMockContext(tmpDir);

    // Run the plugin — writes fresh cache with current mtimes
    const plugin = vitestAffected({ changedFiles: [], cache: true });
    await runHook(plugin, vitest, project);

    // Do NOT overwrite the cache — it has fresh mtimes, so loadOrBuildGraphSync
    // will return non-empty mtime maps and diffGraphMtimes finds 0 changes.

    const filter = getFilterCallback();
    expect(filter).not.toBeNull();

    // mainTestTs is in the forward graph. No files changed → BFS seeds empty → not in affected set → false
    const result = filter!({ moduleId: mainTestTs });
    expect(result).toBe(false);
  });

  test('full-rebuild guard: when both mtime maps are empty, all specs pass through', async () => {
    // When loadOrBuildGraphSync returns empty oldMtimes and currentMtimes (full rebuild path),
    // diffGraphMtimes would see 0 changed/added → 0 BFS seeds → empty affected set → specs skipped.
    // The guard must detect this and pass through ALL specs instead.

    const { tmpDir, mainTestTs, orphanTs } = setupWatchFixture();
    const { vitest, project, getFilterCallback } = createWatchMockContext(tmpDir);

    // Run plugin with a fresh (no-cache) project — first call will be a full rebuild
    const plugin = vitestAffected({ changedFiles: [], cache: true });
    await runHook(plugin, vitest, project);

    // Now deliberately DELETE the cache so the watch filter triggers a full rebuild
    const cacheDir = path.join(tmpDir, '.vitest-affected');
    rmSync(cacheDir, { recursive: true, force: true });

    const filter = getFilterCallback();
    expect(filter).not.toBeNull();

    // mainTestTs is a known test file in the fixture — with full rebuild, it must pass through
    const resultForTest = filter!({ moduleId: mainTestTs });
    expect(resultForTest).toBe(true);

    // orphanTs is a source file but not a test file — full rebuild still passes through
    // (conservative: we can't know what's affected, so pass all)
    const resultForOrphan = filter!({ moduleId: orphanTs });
    expect(resultForOrphan).toBe(true);
  });

  test('batch reset: full-rebuild pass-through is consistent within a batch', async () => {
    // When the first filter call in a batch triggers a full rebuild (stale cache),
    // the fullRebuildPassThrough flag ensures ALL subsequent calls in the same batch
    // also pass through — without re-triggering the expensive loadOrBuildGraphSync.

    const { tmpDir, libTs, mainTestTs } = setupWatchFixture();
    const cacheDir = path.join(tmpDir, '.vitest-affected');
    const mainTs = path.join(tmpDir, 'src', 'main.ts');
    const orphanTs = path.join(tmpDir, 'src', 'orphan.ts');

    const { vitest, project, getFilterCallback } = createWatchMockContext(tmpDir);
    const plugin = vitestAffected({ changedFiles: [], cache: true });
    await runHook(plugin, vitest, project);

    // Overwrite cache with stale mtime for libTs — will trigger full rebuild
    const forward = new Map<string, Set<string>>([
      [mainTestTs, new Set([mainTs])],
      [mainTs, new Set([libTs])],
      [libTs, new Set()],
      [orphanTs, new Set()],
    ]);
    const staleMtimes = new Map([
      [mainTestTs, lstatSync(mainTestTs).mtimeMs],
      [mainTs, lstatSync(mainTs).mtimeMs],
      [libTs, 0], // stale → full rebuild
      [orphanTs, lstatSync(orphanTs).mtimeMs],
    ]);
    saveGraphSyncInternal(forward, cacheDir, staleMtimes);

    const filter = getFilterCallback();
    expect(filter).not.toBeNull();

    // First call: stale cache → full rebuild → fullRebuildPassThrough=true → passes through
    const firstResult = filter!({ moduleId: mainTestTs });
    expect(firstResult).toBe(true);

    // Second call within same batch (<500ms): fullRebuildPassThrough still true → passes through
    // (fullRebuildPassThrough flag prevents re-running loadOrBuildGraphSync)
    const secondResult = filter!({ moduleId: orphanTs });
    expect(secondResult).toBe(true);

    // Third call also within same batch: passes through
    const thirdResult = filter!({ moduleId: mainTestTs });
    expect(thirdResult).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// bd-7rv: accumulatedRuntimeEdges — edges accumulate across watch batches
// ---------------------------------------------------------------------------

function createMockTestModule(
  moduleId: string,
  importDurations: Record<string, { selfTime: number; totalTime: number }>,
): TestModule {
  return {
    moduleId,
    diagnostic: () => ({ importDurations }),
  } as unknown as TestModule;
}

/**
 * Helper: extract the runtime reporter injected by the plugin's config() hook.
 */
function extractReporter(
  plugin: ReturnType<typeof vitestAffected>,
): Reporter {
  const config = { test: { reporters: ['default'] } };
  (plugin as { config: (cfg: Record<string, unknown>) => void }).config(
    config as Record<string, unknown>,
  );
  const reporters = (config.test as { reporters: unknown[] }).reporters;
  return reporters[reporters.length - 1] as Reporter;
}

/**
 * Helper: invoke the plugin's configureVitest hook with a minimal watch context.
 */
async function invokeConfigureVitest(
  plugin: ReturnType<typeof vitestAffected>,
  tmpDir: string,
): Promise<void> {
  const mockProject = {
    config: {
      include: ['tests/**/*.test.ts'],
      exclude: [] as string[],
      setupFiles: [] as string[],
    },
  };
  const mockVitest = {
    config: { root: tmpDir, watch: true },
    projects: [mockProject],
    onFilterWatchedSpecification: (_cb: unknown) => { /* noop */ },
  };
  const hook = (plugin as Record<string, unknown>).configureVitest as (ctx: {
    vitest: typeof mockVitest;
    project: typeof mockProject;
  }) => Promise<void>;
  await hook({ vitest: mockVitest, project: mockProject });
}

describe('bd-7rv: accumulatedRuntimeEdges across watch batches', () => {
  test('saveGraphSyncInternal is called with accumulatedRuntimeEdges, not raw per-call edges', async () => {
    // This test verifies that the onEdgesCollected callback passes accumulatedRuntimeEdges
    // (the closure accumulator) to saveGraphSyncInternal, not just the current call's edges.
    // We spy on saveGraphSyncInternal and check what runtimeEdges argument it receives.

    const { tmpDir, mainTs, mainTestTs } = setupWatchFixture();

    const srcA = mainTs;
    const testA = mainTestTs;

    const plugin = vitestAffected({ changedFiles: [], cache: true });
    const reporter = extractReporter(plugin);
    await invokeConfigureVitest(plugin, tmpDir);

    // Spy AFTER invokeConfigureVitest (which calls saveGraphSyncInternal internally)
    const saveSpy = vi.spyOn(cacheModule, 'saveGraphSyncInternal');

    // Fire one batch — verify saveGraphSyncInternal receives a Map (accumulatedRuntimeEdges)
    reporter.onTestModuleEnd!(createMockTestModule(testA, {
      [srcA]: { selfTime: 1, totalTime: 2 },
    }));
    reporter.onTestRunEnd!([], [], 'passed' as TestRunEndReason);

    // The onEdgesCollected callback should have called saveGraphSyncInternal once
    expect(saveSpy).toHaveBeenCalledTimes(1);

    // The 4th argument (runtimeEdges) should be a Map (the accumulator)
    const callArgs = saveSpy.mock.calls[0];
    const runtimeEdgesArg = callArgs[3] as Map<string, Set<string>> | undefined;
    expect(runtimeEdgesArg).toBeInstanceOf(Map);
    expect(runtimeEdgesArg!.has(srcA)).toBe(true);
    expect(runtimeEdgesArg!.get(srcA)!.has(testA)).toBe(true);
  });

  test('failed save preserves accumulatedRuntimeEdges — next batch includes both batches edges', async () => {
    // If saveGraphSyncInternal throws during onEdgesCollected, accumulatedRuntimeEdges
    // must NOT be reset. The next successful batch save should include both batches' edges.

    const { tmpDir, mainTs, libTs, mainTestTs } = setupWatchFixture();
    const cacheDir = path.join(tmpDir, '.vitest-affected');

    const srcA = mainTs;
    const srcB = libTs;
    const testA = mainTestTs;

    const plugin = vitestAffected({ changedFiles: [], cache: true });
    const reporter = extractReporter(plugin);
    await invokeConfigureVitest(plugin, tmpDir);

    // Make the first save throw to simulate a disk error
    const saveSpy = vi.spyOn(cacheModule, 'saveGraphSyncInternal');
    let callCount = 0;
    saveSpy.mockImplementation((...args) => {
      callCount++;
      if (callCount === 1) {
        // First call from onEdgesCollected: throw to simulate failure
        throw new Error('simulated disk error');
      }
      // Subsequent calls: use real implementation
      return (saveGraphSyncInternal as (...args: unknown[]) => void)(...args);
    });

    // Batch 1: srcA → testA (save fails → accumulator NOT reset)
    reporter.onTestModuleEnd!(createMockTestModule(testA, {
      [srcA]: { selfTime: 1, totalTime: 2 },
    }));
    reporter.onTestRunEnd!([], [], 'passed' as TestRunEndReason);

    // Restore to real implementation for batch 2
    saveSpy.mockRestore();

    // Batch 2: srcB → testA (save succeeds → accumulator has BOTH srcA + srcB)
    reporter.onTestModuleEnd!(createMockTestModule(testA, {
      [srcB]: { selfTime: 1, totalTime: 2 },
    }));
    reporter.onTestRunEnd!([], [], 'passed' as TestRunEndReason);

    // Read the graph.json saved by batch 2
    const raw = readFileSync(path.join(cacheDir, 'graph.json'), 'utf-8');
    const parsed = JSON.parse(raw) as {
      version: number;
      files: Record<string, unknown>;
      runtimeEdges?: Record<string, string[]>;
    };

    // Both srcA (from failed batch 1 accumulation) and srcB (batch 2) should appear
    expect(parsed.runtimeEdges).toBeDefined();
    expect(parsed.runtimeEdges![srcA]).toBeDefined();
    expect(parsed.runtimeEdges![srcB]).toBeDefined();
  });

  test('accumulatedRuntimeEdges is reset after successful save — next batch starts fresh', async () => {
    // After each successful save, accumulatedRuntimeEdges is reset to undefined.
    // A subsequent batch starts fresh — it does NOT include edges from the prior batch.
    // The graph.json after the second successful save contains only the second batch's edges.

    const { tmpDir, mainTs, libTs, mainTestTs } = setupWatchFixture();
    const cacheDir = path.join(tmpDir, '.vitest-affected');

    const srcA = mainTs;
    const srcB = libTs;
    const testA = mainTestTs;

    const plugin = vitestAffected({ changedFiles: [], cache: true });
    const reporter = extractReporter(plugin);
    await invokeConfigureVitest(plugin, tmpDir);

    // Batch 1: srcA → testA (save succeeds → accumulator resets)
    reporter.onTestModuleEnd!(createMockTestModule(testA, {
      [srcA]: { selfTime: 1, totalTime: 2 },
    }));
    reporter.onTestRunEnd!([], [], 'passed' as TestRunEndReason);

    // Batch 2: srcB ONLY → testA (accumulator starts fresh — only srcB)
    reporter.onTestModuleEnd!(createMockTestModule(testA, {
      [srcB]: { selfTime: 1, totalTime: 2 },
    }));
    reporter.onTestRunEnd!([], [], 'passed' as TestRunEndReason);

    // Read the graph.json saved by batch 2
    const raw = readFileSync(path.join(cacheDir, 'graph.json'), 'utf-8');
    const parsed = JSON.parse(raw) as {
      version: number;
      files: Record<string, unknown>;
      runtimeEdges?: Record<string, string[]>;
    };

    // Batch 2 only has srcB — srcA should NOT appear (accumulator was reset after batch 1)
    expect(parsed.runtimeEdges).toBeDefined();
    expect(parsed.runtimeEdges![srcB]).toBeDefined();
    expect(parsed.runtimeEdges![srcA]).toBeUndefined();
  });
});
