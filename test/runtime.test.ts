/// <reference types="vitest/config" />
import { describe, test, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { execa } from 'execa';
import type { Reporter, TestRunEndReason } from 'vitest/reporters';
import type { TestModule } from 'vitest/node';
import { createRuntimeReporter, vitestAffected } from '../src/plugin.js';
import { saveCacheSync, loadCachedReverseMap } from '../src/graph/cache.js';
import * as cacheModule from '../src/graph/cache.js';
import { normalizeModuleId } from '../src/graph/normalize.js';

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
  // realpathSync: os.tmpdir() sits behind a symlink on macOS (/var -> /private/var);
  // cache load canonicalizes keys/values, so fixture literals must be canonical.
  return realpathSync(mkdtempSync(path.join(tmpdir(), 'vitest-runtime-test-')));
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

/** One record per test module: its moduleId and the raw importDurations keys observed. */
interface DiagnosticRecord {
  moduleId: string;
  importedModules: string[];
}

/**
 * Spawns a REAL nested `vitest run` (via execa/npx — same pattern as
 * test/integration.test.ts) against a tiny fixture project, using a
 * self-contained custom reporter (embedded directly in the generated
 * vitest.config.ts) that dumps `testModule.diagnostic().importDurations`
 * to a JSON file. This observes Vitest's OWN import-tracking behavior
 * directly — not our reporter's filtering logic (already covered by the
 * mock-based scenarios above) — which is exactly what's in question for
 * the vi.mock/importActual boundary: does the real dep module actually
 * get loaded (and therefore show up in importDurations) or not.
 *
 * `mockDeclaration` is spliced verbatim into the generated test file, after
 * the test imports `getDep` from a `service.ts` that statically imports
 * `dep.ts` — the test file itself never imports `dep` directly, matching
 * the real-world "factory vi.mock decouples the test from the real module"
 * pattern (mock declared relative to a consumer, not statically imported).
 */
async function runDiagnosticFixture(
  mockDeclaration: string,
): Promise<{ depPath: string; records: DiagnosticRecord[] }> {
  const tmpDir = makeTmpDir();
  tempDirs.push(tmpDir);

  const projectRoot = path.resolve(import.meta.dirname, '..');
  symlinkSync(
    path.join(projectRoot, 'node_modules'),
    path.join(tmpDir, 'node_modules'),
  );

  const outputFile = path.join(tmpDir, 'diagnostic.json');
  const depPath = path.join(tmpDir, 'src', 'dep.ts');

  writeProjectFiles(tmpDir, {
    'package.json': '{"type":"module"}\n',
    'src/dep.ts': 'export const dep = "real";\n',
    'src/service.ts':
      'import { dep } from "./dep";\nexport function getDep(): string {\n  return dep;\n}\n',
    'tests/consumer.test.ts': [
      "import { describe, test, expect, vi } from 'vitest';",
      "import { getDep } from '../src/service';",
      '',
      mockDeclaration,
      '',
      "describe('mock boundary', () => {",
      "  test('resolves getDep()', () => {",
      "    expect(typeof getDep()).toBe('string');",
      '  });',
      '});',
      '',
    ].join('\n'),
    'vitest.config.ts': `import { defineConfig } from 'vitest/config';
import { writeFileSync } from 'node:fs';

const records = [];

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    reporters: [
      'default',
      {
        onTestModuleEnd(testModule) {
          const diag = testModule.diagnostic();
          records.push({
            moduleId: testModule.moduleId,
            importedModules: Object.keys(diag.importDurations ?? {}),
          });
        },
        onTestRunEnd() {
          writeFileSync(${JSON.stringify(outputFile)}, JSON.stringify(records, null, 2));
        },
      },
    ],
  },
});
`,
  });

  const result = await execa('npx', ['vitest', 'run'], {
    cwd: tmpDir,
    reject: false,
  });

  if (result.exitCode !== 0) {
    throw new Error(
      `Nested vitest run failed (exit ${String(result.exitCode)}).\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }

  const records = JSON.parse(readFileSync(outputFile, 'utf-8')) as DiagnosticRecord[];

  return { depPath, records };
}

/** Whether any test module's importDurations include the given (real) file path. */
function hasImportEdgeTo(records: DiagnosticRecord[], targetAbsolutePath: string): boolean {
  return records.some((r) =>
    r.importedModules.some((m) => normalizeModuleId(m) === targetAbsolutePath),
  );
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

// ---------------------------------------------------------------------------
// Scenario 11: vi.mock/importActual BY-DESIGN boundary (va-1ij.5)
//
// VERDICT: fully-mocked modules are intentionally edge-free; partial mocks
// via importActual are runtime-tracked. See src/runtime-merge.ts module
// docstring for the full rationale. These two cases pin exactly that
// boundary against Vitest's real importDurations diagnostic (not our own
// filtering logic, which is agnostic to mocks — it just processes whatever
// importDurations reports).
// ---------------------------------------------------------------------------

describe('vi.mock / vi.importActual boundary: BY-DESIGN edge presence', () => {
  test(
    'factory vi.mock with no static import of dep: dep.ts is NEVER loaded, so it has NO edge (by design)',
    async () => {
      const { depPath, records } = await runDiagnosticFixture(
        "vi.mock('../src/dep', () => ({ dep: 'mocked' }));",
      );

      expect(hasImportEdgeTo(records, depPath)).toBe(false);
    },
    30_000,
  );

  test(
    'factory using vi.importActual loads the real dep.ts: it DOES have an edge (runtime coverage works)',
    async () => {
      const { depPath, records } = await runDiagnosticFixture(
        [
          "vi.mock('../src/dep', async () => {",
          "  const actual = await vi.importActual('../src/dep');",
          "  return { ...actual, dep: `${actual.dep}-partial` };",
          '});',
        ].join('\n'),
      );

      expect(hasImportEdgeTo(records, depPath)).toBe(true);
    },
    30_000,
  );
});
