/// <reference types="vitest/config" />
import { describe, test, expect, afterEach, beforeEach } from 'vitest';
import path from 'node:path';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { vitestAffected } from '../src/plugin.js';
import { saveCacheSync } from '../src/graph/cache.js';
import {
  createMockContext,
  runHook,
  readStats,
  lastStat,
  makeTempDir,
  cleanupTempDirs,
} from './_helpers.js';

const tempDirs: string[] = [];

// The env vars the plugin reads leak from the outer runner into this child
// process. Snapshot and restore them around every test.
const ENV_KEYS = [
  'VITEST_AFFECTED_DISABLED',
  'VITEST_AFFECTED_SHADOW',
  'VITEST_AFFECTED_STATS_FILE',
] as const;
const savedEnv: Record<string, string | undefined> = {};

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
  cleanupTempDirs(tempDirs);
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Temp project with main.ts → main.test.ts. `withCache` controls whether a v2
 * cache is written (cache hit → selective path; no cache → cache-miss path).
 */
function setupProject(withCache: boolean): {
  tmpDir: string;
  mainPath: string;
  testPath: string;
} {
  const tmpDir = makeTempDir(tempDirs, 'vitest-affected-shadow-');

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
  if (withCache) {
    const reverse = new Map<string, Set<string>>();
    reverse.set(mainPath, new Set([testPath]));
    saveCacheSync(path.join(tmpDir, '.vitest-affected'), reverse);
  }

  return { tmpDir, mainPath, testPath };
}

// ---------------------------------------------------------------------------
// (a) shadow on, warm cache — include untouched, action=shadow-selective
// ---------------------------------------------------------------------------

describe('shadow mode — selective decision', () => {
  test('warm cache: include is NOT mutated and stats carry shadow-selective + selectedFiles list', async () => {
    const { tmpDir, mainPath, testPath } = setupProject(true);
    const statsFile = path.join(tmpDir, 'stats.jsonl');

    const { vitest, project, projectConfig } = createMockContext(tmpDir);
    const original = [...projectConfig.include];

    await runHook(
      vitestAffected({ shadow: true, changedFiles: [mainPath], cache: true, statsFile }),
      { vitest, project },
    );

    // Mutation site guarded: include stays the full-suite pattern.
    expect(projectConfig.include).toEqual(original);

    const line = lastStat(statsFile);
    expect(line.action).toBe('shadow-selective');
    expect(line.selectedFiles).toEqual([testPath.replaceAll('\\', '/')]);
  });
});

// ---------------------------------------------------------------------------
// (b) shadow full-suite decision — action=shadow-full-suite, selectedFiles=null,
//     original reason retained
// ---------------------------------------------------------------------------

describe('shadow mode — full-suite decision', () => {
  test('cache-miss: shadow-full-suite with selectedFiles=null and reason retained', async () => {
    const { tmpDir, mainPath } = setupProject(false); // no cache → cache-miss
    const statsFile = path.join(tmpDir, 'stats.jsonl');

    const { vitest, project, projectConfig } = createMockContext(tmpDir);
    const original = [...projectConfig.include];

    await runHook(
      vitestAffected({ shadow: true, changedFiles: [mainPath], cache: true, statsFile }),
      { vitest, project },
    );

    expect(projectConfig.include).toEqual(original);

    const line = lastStat(statsFile);
    expect(line.action).toBe('shadow-full-suite');
    expect(line.selectedFiles).toBeNull();
    // Original reason must survive the shadow remap.
    expect(line.reason).toBe('cache-miss');
  });
});

// ---------------------------------------------------------------------------
// (c) shadow never mutates include — the "vitest list writes a line, executes
//     nothing" invariant (nothing is filtered out of the run)
// ---------------------------------------------------------------------------

describe('shadow mode — non-mutating invariant', () => {
  test('a would-be selective run still leaves the full include in place and writes exactly one line', async () => {
    const { tmpDir, mainPath } = setupProject(true);
    const statsFile = path.join(tmpDir, 'stats.jsonl');

    const { vitest, project, projectConfig } = createMockContext(tmpDir);
    const original = [...projectConfig.include];

    await runHook(
      vitestAffected({ shadow: true, changedFiles: [mainPath], cache: true, statsFile }),
      { vitest, project },
    );

    // Include unchanged → vitest list/run sees all tests → nothing is skipped.
    expect(projectConfig.include).toEqual(original);
    expect(readStats(statsFile)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// (d) shadow + VITEST_AFFECTED_DISABLED=1 — disabled wins, fully inert
// ---------------------------------------------------------------------------

describe('shadow mode — disabled wins', () => {
  test('disabled early-return emits NOTHING and does not mutate include, even with shadow + stats path', async () => {
    process.env.VITEST_AFFECTED_DISABLED = '1';
    const { tmpDir, mainPath } = setupProject(true);
    const statsFile = path.join(tmpDir, 'stats.jsonl');

    const { vitest, project, projectConfig } = createMockContext(tmpDir);
    const original = [...projectConfig.include];

    await runHook(
      vitestAffected({ shadow: true, changedFiles: [mainPath], cache: true, statsFile }),
      { vitest, project },
    );

    expect(projectConfig.include).toEqual(original);
    // Rollback switch must be fully inert — no stats line at all.
    expect(existsSync(statsFile)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (e) env overrides — SHADOW activates without config; STATS_FILE wins
// ---------------------------------------------------------------------------

describe('shadow mode — env overrides', () => {
  test('VITEST_AFFECTED_SHADOW=1 activates shadow with no config option', async () => {
    process.env.VITEST_AFFECTED_SHADOW = '1';
    const { tmpDir, mainPath } = setupProject(true);
    const statsFile = path.join(tmpDir, 'stats.jsonl');

    const { vitest, project, projectConfig } = createMockContext(tmpDir);
    const original = [...projectConfig.include];

    await runHook(
      // note: NO shadow option passed
      vitestAffected({ changedFiles: [mainPath], cache: true, statsFile }),
      { vitest, project },
    );

    expect(projectConfig.include).toEqual(original);
    expect(lastStat(statsFile).action).toBe('shadow-selective');
  });

  test('VITEST_AFFECTED_STATS_FILE wins over config statsFile', async () => {
    const { tmpDir, mainPath } = setupProject(true);
    const configStats = path.join(tmpDir, 'config-stats.jsonl');
    const envStats = path.join(tmpDir, 'env-stats.jsonl');
    process.env.VITEST_AFFECTED_STATS_FILE = envStats;

    const { vitest, project } = createMockContext(tmpDir);

    await runHook(
      vitestAffected({ shadow: true, changedFiles: [mainPath], cache: true, statsFile: configStats }),
      { vitest, project },
    );

    // Env path receives the line; config path is never written.
    expect(existsSync(envStats)).toBe(true);
    expect(existsSync(configStats)).toBe(false);
    expect(lastStat(envStats).action).toBe('shadow-selective');
  });
});

// ---------------------------------------------------------------------------
// (f) every-exit emission — each early return + catch-all writes exactly one
//     line when a stats path is known
// ---------------------------------------------------------------------------

describe('every-exit emission contract', () => {
  test('workspace guard (multiple projects) emits one line', async () => {
    const { tmpDir, mainPath } = setupProject(true);
    const statsFile = path.join(tmpDir, 'stats.jsonl');
    const { vitest, project } = createMockContext(tmpDir, {
      projects: [{}, {}], // length > 1
    });

    await runHook(
      vitestAffected({ changedFiles: [mainPath], cache: true, statsFile }),
      { vitest, project },
    );

    const lines = readStats(statsFile);
    expect(lines).toHaveLength(1);
    expect(lines[0].reason).toBe('workspace');
  });

  test('config-shape guard emits one line', async () => {
    const { tmpDir, mainPath } = setupProject(true);
    const statsFile = path.join(tmpDir, 'stats.jsonl');
    // root falsy → config-shape guard fires
    const { vitest, project } = createMockContext(tmpDir, { root: undefined });

    await runHook(
      vitestAffected({ changedFiles: [mainPath], cache: true, statsFile }),
      { vitest, project },
    );

    const lines = readStats(statsFile);
    expect(lines).toHaveLength(1);
    expect(lines[0].reason).toBe('config-shape');
  });

  test('no-include-patterns guard emits one line', async () => {
    const { tmpDir, mainPath } = setupProject(true);
    const statsFile = path.join(tmpDir, 'stats.jsonl');
    // Empty include array is truthy (passes config-shape) but yields no patterns.
    const { vitest, project } = createMockContext(tmpDir, { include: [] });

    await runHook(
      vitestAffected({ changedFiles: [mainPath], cache: true, statsFile }),
      { vitest, project },
    );

    const lines = readStats(statsFile);
    expect(lines).toHaveLength(1);
    expect(lines[0].reason).toBe('no-include-patterns');
  });

  test('no-test-files guard emits one line', async () => {
    const { tmpDir, mainPath } = setupProject(true);
    const statsFile = path.join(tmpDir, 'stats.jsonl');
    // Include pattern matches nothing on disk.
    const { vitest, project } = createMockContext(tmpDir, {
      include: ['does-not-exist/**/*.test.ts'],
    });

    await runHook(
      vitestAffected({ changedFiles: [mainPath], cache: true, statsFile }),
      { vitest, project },
    );

    const lines = readStats(statsFile);
    expect(lines).toHaveLength(1);
    expect(lines[0].reason).toBe('no-test-files');
  });

  test('alwaysRunTests missing-path guard emits one line', async () => {
    const { tmpDir, mainPath } = setupProject(true);
    const statsFile = path.join(tmpDir, 'stats.jsonl');
    const { vitest, project, projectConfig } = createMockContext(tmpDir);
    const original = [...projectConfig.include];

    await runHook(
      vitestAffected({
        changedFiles: [mainPath],
        cache: true,
        statsFile,
        alwaysRunTests: [path.join(tmpDir, 'tests', 'does-not-exist.test.ts')],
      }),
      { vitest, project },
    );

    // Full-suite fallback: include is left untouched.
    expect(projectConfig.include).toEqual(original);
    const lines = readStats(statsFile);
    expect(lines).toHaveLength(1);
    expect(lines[0].reason).toBe('always-run-config-error');
  });

  test('catch-all emits reason "error" (stats path resolved above the try)', async () => {
    const { tmpDir } = setupProject(true);
    const statsFile = path.join(tmpDir, 'stats.jsonl');

    // Make `vitest.projects` throw when read inside the try → forces the
    // catch-all. rootDir is never resolved, so the hoisted path uses cwd;
    // an absolute statsFile sidesteps cwd resolution.
    const { vitest, project } = createMockContext(tmpDir);
    Object.defineProperty(vitest, 'projects', {
      get() { throw new Error('boom'); },
    });

    await runHook(
      vitestAffected({ changedFiles: [], cache: true, statsFile }),
      { vitest, project },
    );

    const lines = readStats(statsFile);
    expect(lines).toHaveLength(1);
    expect(lines[0].reason).toBe('error');
  });
});
