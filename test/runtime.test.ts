/// <reference types="vitest/config" />
import { describe, test, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import type { Reporter, TestRunEndReason } from 'vitest/reporters';
import type { TestModule } from 'vitest/node';
import { createRuntimeReporter, vitestAffected } from '../src/plugin.js';
import { saveCacheSync, loadCachedReverseMap } from '../src/graph/cache.js';
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

function writeProjectFiles(
  projectDir: string,
  files: Record<string, string>,
): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(projectDir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
  }
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
// Scenario 6: cacheDir guard in onEdgesCollected callback
// ---------------------------------------------------------------------------

describe('Integration: cacheDir guard in onEdgesCollected callback', () => {
  test('no saveCacheSync call when plugin is disabled (configureVitest returns early)', async () => {
    const saveSpy = vi.spyOn(cacheModule, 'saveCacheSync');

    const savedEnv = process.env.VITEST_AFFECTED_DISABLED;
    process.env.VITEST_AFFECTED_DISABLED = '1';

    try {
      const plugin = vitestAffected();

      const projectConfig = {
        include: ['tests/**/*.test.ts'],
        exclude: [] as string[],
        setupFiles: [] as string[],
      };
      const mockProject = { config: projectConfig };
      const mockVitest = {
        config: { root: '/project', watch: false },
        projects: [mockProject],
        reporters: [] as unknown[],
        onFilterWatchedSpecification: () => {},
      };

      const hook = (plugin as Record<string, unknown>).configureVitest as (ctx: {
        vitest: typeof mockVitest;
        project: typeof mockProject;
      }) => Promise<void>;

      await hook({ vitest: mockVitest, project: mockProject });

      // When disabled, no reporter is injected — so no saveCacheSync can be called
      expect(mockVitest.reporters).toHaveLength(0);
      expect(saveSpy).not.toHaveBeenCalled();
    } finally {
      if (savedEnv !== undefined) {
        process.env.VITEST_AFFECTED_DISABLED = savedEnv;
      } else {
        delete process.env.VITEST_AFFECTED_DISABLED;
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
// Scenario 9: v2 cache round-trip with runtime reporter
// ---------------------------------------------------------------------------

describe('Cache persistence: runtime edges via v2 format', () => {
  test('round-trip: saveCacheSync → loadCachedReverseMap returns correct reverse map', () => {
    const rootDir = makeTmpDir();
    tempDirs.push(rootDir);
    const cacheDir = path.join(rootDir, '.vitest-affected');

    const srcFile = path.join(rootDir, 'src', 'utils.ts');
    const testFile = path.join(rootDir, 'tests', 'utils.test.ts');
    writeProjectFiles(rootDir, {
      'src/utils.ts': 'export const utils = 1;\n',
      'tests/utils.test.ts': 'import { utils } from "../src/utils";\n',
    });

    const reverse = new Map<string, Set<string>>([[srcFile, new Set([testFile])]]);
    saveCacheSync(cacheDir, reverse);

    const { reverse: loaded, hit } = loadCachedReverseMap(cacheDir, rootDir);
    expect(hit).toBe(true);
    expect(loaded.has(srcFile)).toBe(true);
    expect(loaded.get(srcFile)?.has(testFile)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario 10: ENOENT on fresh install
// ---------------------------------------------------------------------------

describe('Cache persistence: ENOENT on fresh install', () => {
  test('loadCachedReverseMap without existing cache returns cache miss', () => {
    const rootDir = makeTmpDir();
    tempDirs.push(rootDir);
    const cacheDir = path.join(rootDir, '.vitest-affected');

    const { reverse, hit } = loadCachedReverseMap(cacheDir, rootDir);
    expect(hit).toBe(false);
    expect(reverse.size).toBe(0);
  });

  test('saveCacheSync with empty reverse map does not throw', () => {
    const rootDir = makeTmpDir();
    tempDirs.push(rootDir);
    const cacheDir = path.join(rootDir, '.vitest-affected');

    expect(() => saveCacheSync(cacheDir, new Map())).not.toThrow();

    const raw = readFileSync(path.join(cacheDir, 'graph.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { version: number; reverseMap: Record<string, string[]> };
    expect(parsed.version).toBe(2);
    expect(typeof parsed.reverseMap).toBe('object');
  });
});
