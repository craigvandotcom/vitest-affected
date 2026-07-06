/// <reference types="vitest/config" />
import { describe, test, expect, afterEach, beforeEach, vi } from 'vitest';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Reporter, TestRunEndReason } from 'vitest/reporters';
import { vitestAffected } from '../src/plugin.js';
import { saveCacheSync } from '../src/graph/cache.js';
import {
  createMockContext,
  runHook,
  readStats,
  lastStat,
  createMockTestModule as mockModule,
  makeTempDir,
  cleanupTempDirs,
} from './_helpers.js';

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
  cleanupTempDirs(tempDirs);
});

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

/** Temp project with main.ts → main.test.ts and a warm v2 cache. */
function setupProject(): { tmpDir: string; mainPath: string; testPath: string } {
  // realpathSync: os.tmpdir() sits behind a symlink on macOS (/var → /private/var);
  // the plugin canonicalizes all paths, so fixture literals must be canonical too.
  const tmpDir = makeTempDir(tempDirs, 'vitest-affected-heartbeat-');

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

/**
 * Temp project WITHOUT a warm cache — the plugin takes the cache-miss
 * full-suite path, so no selective decision is applied and selectedTests stays
 * null (self-verify is skipped). Lets a zero-edge test feed many modules
 * without tripping the selection self-verify.
 */
function setupProjectNoCache(): { tmpDir: string; mainPath: string } {
  const tmpDir = makeTempDir(tempDirs, 'vitest-affected-heartbeat-nc-');

  mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
  mkdirSync(path.join(tmpDir, 'tests'), { recursive: true });
  writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}');
  writeFileSync(path.join(tmpDir, 'src', 'main.ts'), 'export const main = 1;\n');
  writeFileSync(
    path.join(tmpDir, 'tests', 'main.test.ts'),
    'import { main } from "../src/main";\nimport { test, expect } from "vitest";\ntest("main", () => expect(main).toBe(1));\n',
  );

  return { tmpDir, mainPath: path.join(tmpDir, 'src', 'main.ts') };
}

/** Count stats lines by their `action` field. */
function countByAction(statsFile: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of readStats(statsFile)) {
    const a = String(line.action);
    out[a] = (out[a] ?? 0) + 1;
  }
  return out;
}

/** Grab the runtime reporter the plugin wired into vitest.reporters. */
function wiredReporter(vitest: { reporters: unknown[] }): Reporter {
  const r = (vitest.reporters as Reporter[]).find(
    (x) => typeof x.onTestRunEnd === 'function',
  );
  if (!r) throw new Error('no reporter wired');
  return r;
}

// ===========================================================================
// (a) ZERO-EDGE HEARTBEAT — completed run, empty importDurations for all
//     modules → loud warning + stats reason 'zero-edges'.
// ===========================================================================

describe('zero-edge heartbeat', () => {
  test('a SMALL selective zero-edge run (<=5 modules) emits the line but stays QUIET on the console', async () => {
    const { tmpDir, mainPath, testPath } = setupProject();
    const statsFile = path.join(tmpDir, 'stats.jsonl');
    const { vitest, project } = createMockContext(tmpDir);

    await runHook(
      vitestAffected({ changedFiles: [mainPath], cache: true, statsFile }),
      { vitest, project },
    );

    const reporter = wiredReporter(vitest);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // A single selected test module ran but importDurations is empty — a small
    // run that legitimately imports only third-party modules. Line, no warn.
    const mod = mockModule(testPath, {});
    reporter.onTestModuleEnd!(mod);
    reporter.onTestRunEnd!([mod], [], 'passed' as TestRunEndReason);

    expect(warn).not.toHaveBeenCalled();
    const line = lastStat(statsFile);
    expect(line.action).toBe('heartbeat');
    expect(line.reason).toBe('zero-edges');
    // Slimmed diagnostic payload: no decision-line fields leak through.
    expect(line.graphSize).toBeUndefined();
    expect(line.cacheHit).toBeUndefined();

    // Decision (selective) + diagnostic (heartbeat) sequence: exactly 2 lines.
    expect(readStats(statsFile)).toHaveLength(2);
    expect(countByAction(statsFile)).toEqual({ selective: 1, heartbeat: 1 });
  });

  test('a FULL-SUITE-scale zero-edge run (>5 modules) warns loudly + emits reason=zero-edges', async () => {
    // No cache → cache-miss full-suite decision, selectedTests stays null, so
    // feeding many modules does not trip the selection self-verify.
    const { tmpDir, mainPath } = setupProjectNoCache();
    const statsFile = path.join(tmpDir, 'stats.jsonl');
    const { vitest, project } = createMockContext(tmpDir);

    await runHook(
      vitestAffected({ changedFiles: [mainPath], cache: true, statsFile }),
      { vitest, project },
    );

    const reporter = wiredReporter(vitest);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Six test modules ran (full-suite-scale) yet produced zero edges — the
    // v0.5.0 starvation signature.
    const mods = Array.from({ length: 6 }, (_, i) =>
      mockModule(path.join(tmpDir, 'tests', `m${i}.test.ts`), {}),
    );
    for (const m of mods) reporter.onTestModuleEnd!(m);
    reporter.onTestRunEnd!(mods, [], 'passed' as TestRunEndReason);

    expect(warn).toHaveBeenCalled();
    const line = lastStat(statsFile);
    expect(line.action).toBe('heartbeat');
    expect(line.reason).toBe('zero-edges');

    // Decision (full-suite/cache-miss) + diagnostic (heartbeat): exactly 2 lines.
    expect(readStats(statsFile)).toHaveLength(2);
    expect(countByAction(statsFile)).toEqual({ 'full-suite': 1, heartbeat: 1 });
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
      experimental: { importDurations: 123 as unknown }, // structural drift
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
      experimental: { importDurations: { limit: 'high' as unknown } }, // limit must be a number
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
      experimental: {
        importDurations: {
          limit: 10,
          print: 'on-warn',
          // a hypothetical future field must NOT trigger the fallback
          someFutureField: { nested: true },
        } as unknown,
      },
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
    const line = lastStat(statsFile);
    expect(line.reason).toBe('selection-mismatch');
    // Slimmed diagnostic payload: strayCount, not the decision-line affectedTests.
    expect(line.strayCount).toBe(1);
    expect(line.affectedTests).toBeUndefined();

    // Decision (selective) + diagnostic (selection-mismatch heartbeat): 2 lines.
    expect(readStats(statsFile)).toHaveLength(2);
    expect(countByAction(statsFile)).toEqual({ selective: 1, heartbeat: 1 });
  });

  test('a SECOND run does not re-fire selection-mismatch (one-shot self-verify reset)', async () => {
    // selectedTests is reset to null after each run-end verification, so a later
    // watch re-run Vitest legitimately re-scopes must NOT raise a false alarm.
    const { tmpDir, mainPath, testPath } = setupProject();
    const statsFile = path.join(tmpDir, 'stats.jsonl');
    const { vitest, project } = createMockContext(tmpDir);

    await runHook(
      vitestAffected({ changedFiles: [mainPath], cache: true, statsFile }),
      { vitest, project },
    );

    const reporter = wiredReporter(vitest);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    // First run: only the selected test runs (with a real edge) → no mismatch,
    // and selectedTests is reset to null.
    const mod = mockModule(testPath, { [mainPath]: { selfTime: 1, totalTime: 2 } });
    reporter.onTestModuleEnd!(mod);
    reporter.onTestRunEnd!([mod], [], 'passed' as TestRunEndReason);

    // Second run: an EXTRA (stray) test runs. Because selectedTests was reset,
    // self-verify does not fire again.
    const strayPath = path.join(tmpDir, 'tests', 'stray.test.ts');
    const strayMod = mockModule(strayPath, { [mainPath]: { selfTime: 1, totalTime: 2 } });
    reporter.onTestModuleEnd!(strayMod);
    reporter.onTestRunEnd!([strayMod], [], 'passed' as TestRunEndReason);

    const mismatches = readStats(statsFile).filter((l) => l.reason === 'selection-mismatch');
    expect(mismatches).toHaveLength(0);
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
