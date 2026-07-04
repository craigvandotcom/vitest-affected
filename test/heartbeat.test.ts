/// <reference types="vitest/config" />
import { describe, test, expect, afterEach, beforeEach, vi } from 'vitest';
import path from 'node:path';
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import type { TestModule } from 'vitest/node';
import type { Reporter, TestRunEndReason } from 'vitest/reporters';
import { vitestAffected } from '../src/plugin.js';
import { saveCacheSync } from '../src/graph/cache.js';

// ---------------------------------------------------------------------------
// Env isolation — the plugin reads these; the outer runner leaks them in.
// ---------------------------------------------------------------------------
const ENV_KEYS = [
  'VITEST_AFFECTED_DISABLED',
  'VITEST_AFFECTED_SHADOW',
  'VITEST_AFFECTED_STATS_FILE',
] as const;
const savedEnv: Record<string, string | undefined> = {};
const tempDirs: string[] = [];

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
    else delete process.env[k];
  }
  vi.restoreAllMocks();
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  tempDirs.length = 0;
});

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

/** Temp project with main.ts → main.test.ts and a warm v2 cache. */
function setupProject(): { tmpDir: string; mainPath: string; testPath: string } {
  // realpathSync: os.tmpdir() sits behind a symlink on macOS (/var → /private/var);
  // the plugin canonicalizes all paths, so fixture literals must be canonical too.
  const tmpDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'vitest-affected-heartbeat-')));
  tempDirs.push(tmpDir);

  mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
  mkdirSync(path.join(tmpDir, 'tests'), { recursive: true });
  writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}');
  writeFileSync(path.join(tmpDir, 'src', 'main.ts'), 'export const main = 1;\n');
  const testPath = path.join(tmpDir, 'tests', 'main.test.ts');
  writeFileSync(
    testPath,
    'import { main } from "../src/main";\nimport { test, expect } from "vitest";\ntest("main", () => expect(main).toBe(1));\n',
  );

  const mainPath = path.join(tmpDir, 'src', 'main.ts');
  const reverse = new Map<string, Set<string>>();
  reverse.set(mainPath, new Set([testPath]));
  saveCacheSync(path.join(tmpDir, '.vitest-affected'), reverse);

  return { tmpDir, mainPath, testPath };
}

interface MockProjectConfig {
  include: string[];
  exclude: string[];
  setupFiles: string[];
  experimental?: {
    importDurations?: unknown;
  };
}

/** Mock { vitest, project }; experimental is passthrough so shape-check tests can drive it. */
function createMockContext(rootDir: string, experimental?: MockProjectConfig['experimental']) {
  const projectConfig: MockProjectConfig = {
    include: ['tests/**/*.test.ts'],
    exclude: [],
    setupFiles: [],
    experimental,
  };
  const project = { config: projectConfig };
  const vitest = {
    config: { root: rootDir, watch: false },
    projects: [project],
    reporters: [] as unknown[],
    onFilterWatchedSpecification: () => {},
  };
  return { vitest, project, projectConfig };
}

async function runHook(
  plugin: ReturnType<typeof vitestAffected>,
  ctx: { vitest: unknown; project: unknown },
): Promise<void> {
  const hook = (plugin as Record<string, unknown>).configureVitest as (
    c: { vitest: unknown; project: unknown },
  ) => Promise<void>;
  await hook(ctx);
}

function readStats(statsFile: string): Array<Record<string, unknown>> {
  if (!existsSync(statsFile)) return [];
  return readFileSync(statsFile, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function lastStat(statsFile: string): Record<string, unknown> {
  const lines = readStats(statsFile);
  return lines[lines.length - 1];
}

/** Grab the runtime reporter the plugin wired into vitest.reporters. */
function wiredReporter(vitest: { reporters: unknown[] }): Reporter {
  const r = (vitest.reporters as Reporter[]).find(
    (x) => typeof x.onTestRunEnd === 'function',
  );
  if (!r) throw new Error('no reporter wired');
  return r;
}

/** Mock TestModule with a given moduleId and importDurations map. */
function mockModule(
  moduleId: string,
  importDurations: Record<string, { selfTime: number; totalTime: number }>,
): TestModule {
  return {
    moduleId,
    diagnostic: () => ({ importDurations }),
  } as unknown as TestModule;
}

// ===========================================================================
// (a) ZERO-EDGE HEARTBEAT — completed run, empty importDurations for all
//     modules → loud warning + stats reason 'zero-edges'.
// ===========================================================================

describe('zero-edge heartbeat', () => {
  test('completed run whose modules yield no importDurations warns loudly + emits reason=zero-edges', async () => {
    const { tmpDir, mainPath, testPath } = setupProject();
    const statsFile = path.join(tmpDir, 'stats.jsonl');
    const { vitest, project } = createMockContext(tmpDir);

    await runHook(
      vitestAffected({ changedFiles: [mainPath], cache: true, statsFile }),
      { vitest, project },
    );

    const reporter = wiredReporter(vitest);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // A test module ran but importDurations is empty (the starvation symptom).
    const mod = mockModule(testPath, {});
    reporter.onTestModuleEnd!(mod);
    reporter.onTestRunEnd!([mod], [], 'passed' as TestRunEndReason);

    expect(warn).toHaveBeenCalled();
    const line = lastStat(statsFile);
    expect(line.action).toBe('heartbeat');
    expect(line.reason).toBe('zero-edges');
  });

  test('an INTERRUPTED empty run does NOT fire the heartbeat (no false positive)', async () => {
    const { tmpDir, mainPath, testPath } = setupProject();
    const statsFile = path.join(tmpDir, 'stats.jsonl');
    const { vitest, project } = createMockContext(tmpDir);

    await runHook(
      vitestAffected({ changedFiles: [mainPath], cache: true, statsFile }),
      { vitest, project },
    );
    const before = readStats(statsFile).length;

    const reporter = wiredReporter(vitest);
    const mod = mockModule(testPath, {});
    reporter.onTestModuleEnd!(mod);
    reporter.onTestRunEnd!([mod], [], 'interrupted' as TestRunEndReason);

    // No new stats line, and reason never becomes zero-edges.
    expect(readStats(statsFile).length).toBe(before);
    expect(lastStat(statsFile).reason).not.toBe('zero-edges');
  });

  test('a run where zero test modules ran does NOT fire the heartbeat (empty selection, not starvation)', async () => {
    const { tmpDir, mainPath } = setupProject();
    const statsFile = path.join(tmpDir, 'stats.jsonl');
    const { vitest, project } = createMockContext(tmpDir);

    await runHook(
      vitestAffected({ changedFiles: [mainPath], cache: true, statsFile }),
      { vitest, project },
    );
    const before = readStats(statsFile).length;

    const reporter = wiredReporter(vitest);
    // No modules ran at all → legitimate no-run, not a zero-edge starvation.
    reporter.onTestRunEnd!([], [], 'passed' as TestRunEndReason);

    expect(readStats(statsFile).length).toBe(before);
  });
});

// ===========================================================================
// (b) IMPORTDURATIONS SHAPE-CHECK — unexpected config shape at startup →
//     warning + full-suite fallback (reason 'import-durations-shape').
// ===========================================================================

describe('importDurations config shape-check', () => {
  test('importDurations that is not an object → warning + full-suite fallback', async () => {
    const { tmpDir, mainPath } = setupProject();
    const statsFile = path.join(tmpDir, 'stats.jsonl');
    const { vitest, project, projectConfig } = createMockContext(tmpDir, {
      importDurations: 123 as unknown, // structural drift
    });
    const originalInclude = [...projectConfig.include];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runHook(
      vitestAffected({ changedFiles: [mainPath], cache: true, statsFile }),
      { vitest, project },
    );

    // Full-suite fallback: include untouched, distinct reason, loud warning.
    expect(projectConfig.include).toEqual(originalInclude);
    expect(lastStat(statsFile).reason).toBe('import-durations-shape');
    expect(warn).toHaveBeenCalled();
  });

  test('importDurations.limit of the wrong type → full-suite fallback', async () => {
    const { tmpDir, mainPath } = setupProject();
    const statsFile = path.join(tmpDir, 'stats.jsonl');
    const { vitest, project } = createMockContext(tmpDir, {
      importDurations: { limit: 'high' as unknown }, // limit must be a number
    });

    await runHook(
      vitestAffected({ changedFiles: [mainPath], cache: true, statsFile }),
      { vitest, project },
    );

    expect(lastStat(statsFile).reason).toBe('import-durations-shape');
  });

  test('additive drift (unknown new fields) is tolerated — no shape fallback', async () => {
    const { tmpDir, mainPath } = setupProject();
    const statsFile = path.join(tmpDir, 'stats.jsonl');
    const { vitest, project } = createMockContext(tmpDir, {
      importDurations: {
        limit: 10,
        print: 'on-warn',
        // a hypothetical future field must NOT trigger the fallback
        someFutureField: { nested: true },
      } as unknown,
    });

    await runHook(
      vitestAffected({ changedFiles: [mainPath], cache: true, statsFile }),
      { vitest, project },
    );

    // Proceeds normally (selective decision), never the shape fallback.
    expect(lastStat(statsFile).reason).not.toBe('import-durations-shape');
  });
});

// ===========================================================================
// (c) SELECTION SELF-VERIFY — a test that ran but was NOT selected → loud
//     warning + stats reason 'selection-mismatch'.
// ===========================================================================

describe('selection self-verify', () => {
  test('a stray test (ran but not selected) warns loudly + emits reason=selection-mismatch', async () => {
    const { tmpDir, mainPath } = setupProject();
    const statsFile = path.join(tmpDir, 'stats.jsonl');
    const { vitest, project, projectConfig } = createMockContext(tmpDir);

    await runHook(
      vitestAffected({ changedFiles: [mainPath], cache: true, statsFile }),
      { vitest, project },
    );
    // Selective decision must have been applied (include narrowed to 1 file).
    expect(projectConfig.include.length).toBe(1);

    const reporter = wiredReporter(vitest);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // A test Vitest should NOT have run (not in the selected set) runs anyway.
    const strayPath = path.join(tmpDir, 'tests', 'stray.test.ts');
    const strayMod = mockModule(strayPath, {
      [mainPath]: { selfTime: 1, totalTime: 2 },
    });
    reporter.onTestModuleEnd!(strayMod);
    reporter.onTestRunEnd!([strayMod], [], 'passed' as TestRunEndReason);

    expect(warn).toHaveBeenCalled();
    expect(lastStat(statsFile).reason).toBe('selection-mismatch');
  });

  test('ran-tests ⊆ selected → no self-verify warning', async () => {
    const { tmpDir, mainPath, testPath } = setupProject();
    const statsFile = path.join(tmpDir, 'stats.jsonl');
    const { vitest, project } = createMockContext(tmpDir);

    await runHook(
      vitestAffected({ changedFiles: [mainPath], cache: true, statsFile }),
      { vitest, project },
    );

    const reporter = wiredReporter(vitest);
    // Only the selected test runs, with real edges → no mismatch, no heartbeat.
    const mod = mockModule(testPath, { [mainPath]: { selfTime: 1, totalTime: 2 } });
    reporter.onTestModuleEnd!(mod);
    reporter.onTestRunEnd!([mod], [], 'passed' as TestRunEndReason);

    expect(lastStat(statsFile).reason).not.toBe('selection-mismatch');
  });

  test('under shadow mode, self-verify is skipped even when a stray runs', async () => {
    const { tmpDir, mainPath } = setupProject();
    const statsFile = path.join(tmpDir, 'stats.jsonl');
    const { vitest, project } = createMockContext(tmpDir);

    await runHook(
      // shadow: include is NOT mutated, so all tests run — a "stray" is
      // expected, not a bug. Self-verify must not fire.
      vitestAffected({ shadow: true, changedFiles: [mainPath], cache: true, statsFile }),
      { vitest, project },
    );

    const reporter = wiredReporter(vitest);
    const strayPath = path.join(tmpDir, 'tests', 'stray.test.ts');
    const strayMod = mockModule(strayPath, {
      [mainPath]: { selfTime: 1, totalTime: 2 },
    });
    reporter.onTestModuleEnd!(strayMod);
    reporter.onTestRunEnd!([strayMod], [], 'passed' as TestRunEndReason);

    expect(lastStat(statsFile).reason).not.toBe('selection-mismatch');
  });
});
