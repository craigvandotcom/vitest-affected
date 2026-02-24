/// <reference types="vitest/config" />
import { describe, test, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  lstatSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import type { Reporter, TestRunEndReason } from 'vitest/reporters';
import type { TestModule } from 'vitest/node';
import { createRuntimeReporter, mergeRuntimeEdges, vitestAffected } from '../src/plugin.js';
import { saveGraphSyncInternal, loadOrBuildGraphSync } from '../src/graph/cache.js';
import * as cacheModule from '../src/graph/cache.js';

// ---------------------------------------------------------------------------
// Helpers
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

function makeTmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'vitest-runtime-test-'));
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const d of tempDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  tempDirs.length = 0;
});

// ---------------------------------------------------------------------------
// Scenario 1: Edge collection from importDurations
// ---------------------------------------------------------------------------

describe('Reporter: edge collection from importDurations', () => {
  test('builds correct reverse map from TestModule.diagnostic().importDurations', () => {
    const collected: Map<string, Set<string>>[] = [];
    const { reporter, setRootDir } = createRuntimeReporter((edges) => {
      collected.push(new Map(edges));
    });

    setRootDir('/project');

    const testPath = '/project/tests/utils.test.ts';
    const depA = '/project/src/utils.ts';
    const depB = '/project/src/helpers.ts';

    const mod = createMockTestModule(testPath, {
      [depA]: { selfTime: 5, totalTime: 10 },
      [depB]: { selfTime: 2, totalTime: 8 },
    });

    reporter.onTestModuleEnd!(mod);
    reporter.onTestRunEnd!([], [], 'passed' as TestRunEndReason);

    expect(collected).toHaveLength(1);
    const edges = collected[0];

    // Reverse map: each dep maps back to the test that loaded it
    expect(edges.get(depA)).toEqual(new Set([testPath]));
    expect(edges.get(depB)).toEqual(new Set([testPath]));
  });

  test('multiple test modules aggregate into one reverse map', () => {
    const collected: Map<string, Set<string>>[] = [];
    const { reporter, setRootDir } = createRuntimeReporter((edges) => {
      collected.push(new Map(edges));
    });

    setRootDir('/project');

    const testA = '/project/tests/a.test.ts';
    const testB = '/project/tests/b.test.ts';
    const sharedDep = '/project/src/shared.ts';
    const depA = '/project/src/a.ts';
    const depB = '/project/src/b.ts';

    reporter.onTestModuleEnd!(createMockTestModule(testA, {
      [sharedDep]: { selfTime: 1, totalTime: 2 },
      [depA]: { selfTime: 1, totalTime: 2 },
    }));
    reporter.onTestModuleEnd!(createMockTestModule(testB, {
      [sharedDep]: { selfTime: 1, totalTime: 2 },
      [depB]: { selfTime: 1, totalTime: 2 },
    }));
    reporter.onTestRunEnd!([], [], 'passed' as TestRunEndReason);

    expect(collected).toHaveLength(1);
    const edges = collected[0];

    // sharedDep should appear in both test paths' sets
    expect(edges.get(sharedDep)).toEqual(new Set([testA, testB]));
    expect(edges.get(depA)).toEqual(new Set([testA]));
    expect(edges.get(depB)).toEqual(new Set([testB]));
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Merge correctness
// ---------------------------------------------------------------------------

describe('mergeRuntimeEdges: merge correctness', () => {
  test('runtime edges are ADDED (union) to static reverse map', () => {
    const staticReverse = new Map<string, Set<string>>();
    staticReverse.set('/src/a.ts', new Set(['/tests/a.test.ts']));

    const runtimeReverse = new Map<string, Set<string>>();
    runtimeReverse.set('/src/b.ts', new Set(['/tests/b.test.ts']));

    mergeRuntimeEdges(staticReverse, runtimeReverse);

    expect(staticReverse.has('/src/b.ts')).toBe(true);
    expect(staticReverse.get('/src/b.ts')).toEqual(new Set(['/tests/b.test.ts']));
  });

  test('static edges are NOT removed after merge', () => {
    const staticReverse = new Map<string, Set<string>>();
    staticReverse.set('/src/a.ts', new Set(['/tests/a.test.ts']));
    staticReverse.set('/src/c.ts', new Set(['/tests/c.test.ts']));

    // Runtime only touches /src/a.ts — /src/c.ts must survive
    const runtimeReverse = new Map<string, Set<string>>();
    runtimeReverse.set('/src/a.ts', new Set(['/tests/extra.test.ts']));

    mergeRuntimeEdges(staticReverse, runtimeReverse);

    expect(staticReverse.get('/src/c.ts')).toEqual(new Set(['/tests/c.test.ts']));
  });

  test('overlapping keys merge their test file sets', () => {
    const staticReverse = new Map<string, Set<string>>();
    staticReverse.set('/src/a.ts', new Set(['/tests/a.test.ts']));

    const runtimeReverse = new Map<string, Set<string>>();
    runtimeReverse.set('/src/a.ts', new Set(['/tests/b.test.ts'])); // same key, new test

    mergeRuntimeEdges(staticReverse, runtimeReverse);

    expect(staticReverse.get('/src/a.ts')).toEqual(
      new Set(['/tests/a.test.ts', '/tests/b.test.ts']),
    );
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Abort safety
// ---------------------------------------------------------------------------

describe('Reporter: abort safety (interrupted reason)', () => {
  test('onEdgesCollected callback is NOT called on interrupted run', () => {
    let callCount = 0;
    const { reporter, setRootDir } = createRuntimeReporter(() => {
      callCount++;
    });

    setRootDir('/project');

    const mod = createMockTestModule('/project/tests/a.test.ts', {
      '/project/src/a.ts': { selfTime: 1, totalTime: 2 },
    });

    reporter.onTestModuleEnd!(mod);
    reporter.onTestRunEnd!([], [], 'interrupted' as TestRunEndReason);

    expect(callCount).toBe(0);
  });

  test('runtimeReverse is NOT cleared on interrupt — partial edges survive for accumulation', () => {
    let callCount = 0;
    const { reporter, setRootDir } = createRuntimeReporter(() => {
      callCount++;
    });

    setRootDir('/project');

    const mod = createMockTestModule('/project/tests/a.test.ts', {
      '/project/src/a.ts': { selfTime: 1, totalTime: 2 },
    });

    reporter.onTestModuleEnd!(mod);
    // Interrupt — should NOT clear accumulated edges
    reporter.onTestRunEnd!([], [], 'interrupted' as TestRunEndReason);
    expect(callCount).toBe(0);

    // A subsequent passed run should still see the accumulated edges
    reporter.onTestRunEnd!([], [], 'passed' as TestRunEndReason);
    expect(callCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: runtimeReverse cleared between runs
// ---------------------------------------------------------------------------

describe('Reporter: runtimeReverse cleared between sequential runs', () => {
  test('second run starts fresh — edges from first run do NOT carry over', () => {
    const collected: Map<string, Set<string>>[] = [];
    const { reporter, setRootDir } = createRuntimeReporter((edges) => {
      collected.push(new Map(edges));
    });

    setRootDir('/project');

    // First run: test A loads dep A
    reporter.onTestModuleEnd!(createMockTestModule('/project/tests/a.test.ts', {
      '/project/src/a.ts': { selfTime: 1, totalTime: 2 },
    }));
    reporter.onTestRunEnd!([], [], 'passed' as TestRunEndReason);

    // First run edges should only contain depA
    expect(collected).toHaveLength(1);
    expect(collected[0].get('/project/src/a.ts')).toEqual(
      new Set(['/project/tests/a.test.ts']),
    );
    expect(collected[0].has('/project/src/b.ts')).toBe(false);

    // Second run: test B loads dep B only
    reporter.onTestModuleEnd!(createMockTestModule('/project/tests/b.test.ts', {
      '/project/src/b.ts': { selfTime: 1, totalTime: 2 },
    }));
    reporter.onTestRunEnd!([], [], 'passed' as TestRunEndReason);

    // Second run edges should only contain depB — depA must NOT carry over
    expect(collected).toHaveLength(2);
    expect(collected[1].get('/project/src/b.ts')).toEqual(
      new Set(['/project/tests/b.test.ts']),
    );
    expect(collected[1].has('/project/src/a.ts')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: Deferred rootDir
// ---------------------------------------------------------------------------

describe('Reporter: deferred rootDir', () => {
  test('no error and no edges when onTestModuleEnd called before setRootDir', () => {
    const collected: Map<string, Set<string>>[] = [];
    const { reporter } = createRuntimeReporter((edges) => {
      collected.push(new Map(edges));
    });

    // Call BEFORE setRootDir
    const mod = createMockTestModule('/project/tests/a.test.ts', {
      '/project/src/a.ts': { selfTime: 1, totalTime: 2 },
    });

    expect(() => reporter.onTestModuleEnd!(mod)).not.toThrow();
    reporter.onTestRunEnd!([], [], 'passed' as TestRunEndReason);

    // No edges collected — rootDir was not set
    expect(collected).toHaveLength(0);
  });

  test('edges ARE collected after setRootDir is called', () => {
    const collected: Map<string, Set<string>>[] = [];
    const { reporter, setRootDir } = createRuntimeReporter((edges) => {
      collected.push(new Map(edges));
    });

    // First call BEFORE setRootDir — no edges
    reporter.onTestModuleEnd!(createMockTestModule('/project/tests/a.test.ts', {
      '/project/src/a.ts': { selfTime: 1, totalTime: 2 },
    }));
    reporter.onTestRunEnd!([], [], 'passed' as TestRunEndReason);
    expect(collected).toHaveLength(0);

    // Now set rootDir
    setRootDir('/project');

    // Second call AFTER setRootDir — edges collected
    reporter.onTestModuleEnd!(createMockTestModule('/project/tests/a.test.ts', {
      '/project/src/a.ts': { selfTime: 1, totalTime: 2 },
    }));
    reporter.onTestRunEnd!([], [], 'passed' as TestRunEndReason);
    expect(collected).toHaveLength(1);
    expect(collected[0].get('/project/src/a.ts')).toEqual(
      new Set(['/project/tests/a.test.ts']),
    );
  });
});

// ---------------------------------------------------------------------------
// Scenario 6: Integration — cacheDir guard prevents write when configureVitest skipped
// ---------------------------------------------------------------------------

describe('Integration: cacheDir guard prevents write when configureVitest skipped', () => {
  test('no saveGraphSyncInternal call when configureVitest was not invoked', () => {
    // Spy on saveGraphSyncInternal before creating plugin
    const saveSpy = vi.spyOn(cacheModule, 'saveGraphSyncInternal');

    // Restore VITEST_AFFECTED_DISABLED in case it's set in test env
    const savedEnv = process.env.VITEST_AFFECTED_DISABLED;
    delete process.env.VITEST_AFFECTED_DISABLED;

    try {
      const plugin = vitestAffected();
      const config = { test: { reporters: ['default'] } };

      // Call the config hook to inject the reporter — but do NOT call configureVitest
      (plugin as { config: (config: Record<string, unknown>) => void }).config(
        config as Record<string, unknown>,
      );

      // Extract the reporter appended by config hook
      const reporters = (config.test as { reporters: unknown[] }).reporters;
      const reporter = reporters[reporters.length - 1] as Reporter;

      // Fire a complete test run through the reporter
      // cacheDir is still undefined because configureVitest was skipped
      reporter.onTestModuleEnd!(createMockTestModule('/project/tests/a.test.ts', {
        '/project/src/a.ts': { selfTime: 1, totalTime: 2 },
      }));

      // We need to set rootDir via the returned setRootDir — but in this integration
      // test, the reporter's onEdgesCollected closure checks `if (!cacheDir) return`
      // Since configureVitest was never called, cacheDir remains undefined
      // So even if we trigger onTestRunEnd, the guard fires and saveGraphSyncInternal is never called

      reporter.onTestRunEnd!([], [], 'passed' as TestRunEndReason);

      expect(saveSpy).not.toHaveBeenCalled();
    } finally {
      if (savedEnv !== undefined) {
        process.env.VITEST_AFFECTED_DISABLED = savedEnv;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 7: Module filtering (comprehensive)
// ---------------------------------------------------------------------------

describe('Reporter: module filtering (comprehensive)', () => {
  test('collects project paths and skips node_modules, virtual, outside-rootDir, and self-reference', () => {
    const collected: Map<string, Set<string>>[] = [];
    const { reporter, setRootDir } = createRuntimeReporter((edges) => {
      collected.push(new Map(edges));
    });

    setRootDir('/project');

    const testPath = '/project/tests/a.test.ts';
    const projectDep = '/project/src/utils.ts';            // should be collected
    const nodeModuleDep = '/project/node_modules/lodash/index.js'; // skip node_modules
    const virtualDep = '/@vite/env';                        // not absolute under rootDir
    const outsideDep = '/other-project/src/lib.ts';         // outside rootDir
    // selfRef = testPath === modulePath                     // self-reference skip

    reporter.onTestModuleEnd!(createMockTestModule(testPath, {
      [projectDep]: { selfTime: 1, totalTime: 2 },
      [nodeModuleDep]: { selfTime: 1, totalTime: 2 },
      [virtualDep]: { selfTime: 1, totalTime: 2 },
      [outsideDep]: { selfTime: 1, totalTime: 2 },
      [testPath]: { selfTime: 1, totalTime: 2 }, // self-reference
    }));
    reporter.onTestRunEnd!([], [], 'passed' as TestRunEndReason);

    expect(collected).toHaveLength(1);
    const edges = collected[0];

    // Only projectDep should appear
    expect(edges.get(projectDep)).toEqual(new Set([testPath]));
    expect(edges.has(nodeModuleDep)).toBe(false);
    expect(edges.has(virtualDep)).toBe(false);
    expect(edges.has(outsideDep)).toBe(false);
    expect(edges.has(testPath)).toBe(false); // self-reference excluded
  });

  test('non-absolute import path keys in importDurations are skipped', () => {
    const collected: Map<string, Set<string>>[] = [];
    const { reporter, setRootDir } = createRuntimeReporter((edges) => {
      collected.push(new Map(edges));
    });

    setRootDir('/project');

    const testPath = '/project/tests/a.test.ts';

    reporter.onTestModuleEnd!(createMockTestModule(testPath, {
      './relative-dep': { selfTime: 1, totalTime: 2 },       // not absolute
      'bare-specifier': { selfTime: 1, totalTime: 2 },       // not absolute
      '/project/src/real.ts': { selfTime: 1, totalTime: 2 }, // absolute, collected
    }));
    reporter.onTestRunEnd!([], [], 'passed' as TestRunEndReason);

    expect(collected).toHaveLength(1);
    const edges = collected[0];

    expect(edges.has('./relative-dep')).toBe(false);
    expect(edges.has('bare-specifier')).toBe(false);
    expect(edges.get('/project/src/real.ts')).toEqual(new Set([testPath]));
  });
});

// ---------------------------------------------------------------------------
// Scenario 8: Virtual testModule.moduleId
// ---------------------------------------------------------------------------

describe('Reporter: virtual testModule.moduleId', () => {
  test('onTestModuleEnd returns early when moduleId is virtual (does not start with /)', () => {
    const collected: Map<string, Set<string>>[] = [];
    const { reporter, setRootDir } = createRuntimeReporter((edges) => {
      collected.push(new Map(edges));
    });

    setRootDir('/project');

    // Virtual module ID
    reporter.onTestModuleEnd!(createMockTestModule('virtual:some-module', {
      '/project/src/a.ts': { selfTime: 1, totalTime: 2 },
    }));
    reporter.onTestRunEnd!([], [], 'passed' as TestRunEndReason);

    // Guard fires — no edges collected because testPath is virtual
    expect(collected).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 9: Cache round-trip with runtimeEdges
// ---------------------------------------------------------------------------

describe('Cache persistence: runtime edges', () => {
  test('round-trip: saveGraphSyncInternal with runtimeEdges → loadOrBuildGraphSync returns them in reverse', () => {
    const rootDir = makeTmpDir();
    tempDirs.push(rootDir);
    const cacheDir = path.join(rootDir, '.vitest-affected');

    // Use an empty forward map — no static files, guaranteed cache hit (no mtimes to check)
    const forward = new Map<string, Set<string>>();
    const mtimes = new Map<string, number>();

    const srcFile = '/abs/src/utils.ts';
    const testFile = '/abs/tests/utils.test.ts';
    const runtimeEdges = new Map<string, Set<string>>([[srcFile, new Set([testFile])]]);

    saveGraphSyncInternal(forward, cacheDir, mtimes, runtimeEdges);

    const { reverse } = loadOrBuildGraphSync(rootDir, cacheDir);

    expect(reverse.has(srcFile)).toBe(true);
    expect(reverse.get(srcFile)?.has(testFile)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario 10: Save without runtimeEdges preserves existing
// ---------------------------------------------------------------------------

describe('Cache persistence: save without runtimeEdges preserves existing', () => {
  test('second save (watch filter path) without runtimeEdges preserves previously written runtimeEdges', () => {
    const rootDir = makeTmpDir();
    tempDirs.push(rootDir);
    const cacheDir = path.join(rootDir, '.vitest-affected');

    const forward = new Map<string, Set<string>>();
    const mtimes = new Map<string, number>();

    const srcFile = '/abs/src/lib.ts';
    const testFile = '/abs/tests/lib.test.ts';
    const runtimeEdges = new Map<string, Set<string>>([[srcFile, new Set([testFile])]]);

    // First save WITH runtime edges
    saveGraphSyncInternal(forward, cacheDir, mtimes, runtimeEdges);

    // Second save WITHOUT runtime edges (simulating watch filter save)
    saveGraphSyncInternal(forward, cacheDir, mtimes);

    // Read cache file directly and verify runtimeEdges field is preserved
    const raw = readFileSync(path.join(cacheDir, 'graph.json'), 'utf-8');
    const parsed = JSON.parse(raw) as {
      version: number;
      files: Record<string, unknown>;
      runtimeEdges?: Record<string, string[]>;
    };

    expect(parsed.runtimeEdges).toBeDefined();
    expect(parsed.runtimeEdges![srcFile]).toEqual([testFile]);
  });
});

// ---------------------------------------------------------------------------
// Scenario 11: Full rebuild discards runtimeEdges
// ---------------------------------------------------------------------------

describe('Cache persistence: full rebuild discards runtimeEdges', () => {
  test('stale mtime triggers full rebuild — runtime edges from old cache NOT in result', () => {
    const fixtureDir = path.resolve(import.meta.dirname, 'fixtures', 'simple');
    const cacheDir = makeTmpDir();
    tempDirs.push(cacheDir);

    // Write a cache with a real fixture file at stale mtime=0 and runtimeEdges
    // diffGraphMtimes detects the mtime mismatch → full rebuild is triggered
    const realFile = path.join(fixtureDir, 'src', 'a.ts');
    const srcFile = '/abs/src/runtime-src.ts';
    const testFile = '/abs/tests/runtime.test.ts';

    const cacheData = {
      version: 1,
      builtAt: Date.now(),
      files: {
        [realFile]: { mtime: 0, imports: [] }, // stale mtime → triggers rebuild
      },
      runtimeEdges: { [srcFile]: [testFile] },
    };
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(path.join(cacheDir, 'graph.json'), JSON.stringify(cacheData), 'utf-8');

    // loadOrBuildGraphSync detects stale → calls buildFullGraphSync
    // buildFullGraphSync starts fresh — runtime edges are NOT merged
    const { reverse } = loadOrBuildGraphSync(fixtureDir, cacheDir);

    expect(reverse.has(srcFile)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario 12: ENOENT on fresh install
// ---------------------------------------------------------------------------

describe('Cache persistence: ENOENT on fresh install', () => {
  test('saveGraphSyncInternal without runtimeEdges does not throw and written cache has no runtimeEdges', () => {
    const rootDir = makeTmpDir();
    tempDirs.push(rootDir);
    const cacheDir = path.join(rootDir, '.vitest-affected');

    // No cache file exists yet (fresh install)
    const forward = new Map<string, Set<string>>();

    expect(() => saveGraphSyncInternal(forward, cacheDir)).not.toThrow();

    const raw = readFileSync(path.join(cacheDir, 'graph.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { runtimeEdges?: unknown };
    expect(parsed.runtimeEdges).toBeUndefined();
  });

  test('saveGraphSyncInternal with empty runtimeEdges does not throw', () => {
    const rootDir = makeTmpDir();
    tempDirs.push(rootDir);
    const cacheDir = path.join(rootDir, '.vitest-affected');

    const forward = new Map<string, Set<string>>();
    const emptyRuntimeEdges = new Map<string, Set<string>>();

    expect(() => saveGraphSyncInternal(forward, cacheDir, undefined, emptyRuntimeEdges)).not.toThrow();

    const raw = readFileSync(path.join(cacheDir, 'graph.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { runtimeEdges?: Record<string, string[]> };
    // Empty runtimeEdges serializes to an empty object — defined but empty
    expect(typeof parsed.runtimeEdges).toBe('object');
  });
});
