/// <reference types="vitest/config" />
import { describe, test, expect, afterEach, beforeEach, vi } from 'vitest';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Reporter, TestRunEndReason } from 'vitest/reporters';
import {
  bfsAffectedTests,
  bfsAffectedTestsWithProvenance,
} from '../src/selector.js';
import { explainSelection } from '../src/explain-core.js';
import { vitestAffected } from '../src/plugin.js';
import { loadCachedReverseMap, saveCacheSync } from '../src/graph/cache.js';
import {
  createMockContext,
  runHook,
  readStats,
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

const isTest = (f: string) => f.includes('.test.');

// ===========================================================================
// (1) BFS PROVENANCE — seed → chain correctness.
// ===========================================================================

describe('bfsAffectedTestsWithProvenance', () => {
  test('multi-hop linear chain records the full seed → … → test path', () => {
    const reverse = new Map([
      ['/src/c.ts', new Set(['/src/b.ts'])],
      ['/src/b.ts', new Set(['/src/a.ts'])],
      ['/src/a.ts', new Set(['/tests/a.test.ts'])],
    ]);
    const { tests, provenance } = bfsAffectedTestsWithProvenance(
      ['/src/c.ts'],
      reverse,
      isTest,
    );
    expect(tests).toEqual(['/tests/a.test.ts']);
    const trail = provenance.get('/tests/a.test.ts');
    expect(trail).toBeDefined();
    expect(trail!.seed).toBe('/src/c.ts');
    expect(trail!.chain).toEqual([
      '/src/c.ts',
      '/src/b.ts',
      '/src/a.ts',
      '/tests/a.test.ts',
    ]);
  });

  test('diamond dependency — each selected test carries its own chain', () => {
    const reverse = new Map([
      ['/src/c.ts', new Set(['/src/b.ts', '/src/d.ts'])],
      ['/src/b.ts', new Set(['/tests/b.test.ts'])],
      ['/src/d.ts', new Set(['/tests/d.test.ts'])],
    ]);
    const { tests, provenance } = bfsAffectedTestsWithProvenance(
      ['/src/c.ts'],
      reverse,
      isTest,
    );
    expect(tests).toEqual(['/tests/b.test.ts', '/tests/d.test.ts']);
    expect(provenance.get('/tests/b.test.ts')!.chain).toEqual([
      '/src/c.ts', '/src/b.ts', '/tests/b.test.ts',
    ]);
    expect(provenance.get('/tests/d.test.ts')!.chain).toEqual([
      '/src/c.ts', '/src/d.ts', '/tests/d.test.ts',
    ]);
  });

  test('test-file-as-seed self-selection — chain is [test], seed is the test itself', () => {
    const { tests, provenance } = bfsAffectedTestsWithProvenance(
      ['/tests/a.test.ts'],
      new Map(),
      isTest,
    );
    expect(tests).toEqual(['/tests/a.test.ts']);
    const trail = provenance.get('/tests/a.test.ts');
    expect(trail!.seed).toBe('/tests/a.test.ts');
    expect(trail!.chain).toEqual(['/tests/a.test.ts']);
  });

  test('multiple seeds — each test is attributed to its originating seed', () => {
    const reverse = new Map([
      ['/src/a.ts', new Set(['/tests/a.test.ts'])],
      ['/src/b.ts', new Set(['/tests/b.test.ts'])],
    ]);
    const { provenance } = bfsAffectedTestsWithProvenance(
      ['/src/a.ts', '/src/b.ts'],
      reverse,
      isTest,
    );
    expect(provenance.get('/tests/a.test.ts')!.seed).toBe('/src/a.ts');
    expect(provenance.get('/tests/b.test.ts')!.seed).toBe('/src/b.ts');
  });

  test('unreachable test is absent from the provenance map', () => {
    const reverse = new Map([['/src/x.ts', new Set(['/tests/x.test.ts'])]]);
    const { tests, provenance } = bfsAffectedTestsWithProvenance(
      ['/src/y.ts'],
      reverse,
      isTest,
    );
    expect(tests).toEqual([]);
    expect(provenance.has('/tests/x.test.ts')).toBe(false);
  });

  test('tests list is identical to the plain bfsAffectedTests (wrapper parity)', () => {
    const reverse = new Map([
      ['/src/c.ts', new Set(['/src/b.ts', '/src/d.ts'])],
      ['/src/b.ts', new Set(['/tests/b.test.ts'])],
      ['/src/d.ts', new Set(['/tests/d.test.ts'])],
    ]);
    const plain = bfsAffectedTests(['/src/c.ts'], reverse, isTest);
    const { tests } = bfsAffectedTestsWithProvenance(['/src/c.ts'], reverse, isTest);
    expect(tests).toEqual(plain);
  });
});

// ===========================================================================
// (2) explainSelection CORE — why / why-not.
// ===========================================================================

describe('explainSelection (CLI core)', () => {
  test('selected: reports seed + chain', () => {
    const reverse = new Map([['/src/main.ts', new Set(['/tests/main.test.ts'])]]);
    const r = explainSelection('/tests/main.test.ts', ['/src/main.ts'], reverse);
    expect(r.selected).toBe(true);
    expect(r.seed).toBe('/src/main.ts');
    expect(r.chain).toEqual(['/src/main.ts', '/tests/main.test.ts']);
    expect(r.reason).toContain('reached from changed file');
  });

  test('not reachable: explains the missing chain', () => {
    const reverse = new Map([['/src/main.ts', new Set(['/tests/main.test.ts'])]]);
    const r = explainSelection('/tests/other.test.ts', ['/src/main.ts'], reverse);
    expect(r.selected).toBe(false);
    expect(r.reason).toContain('not reachable');
  });

  test('not a test file: rejected before graph walk', () => {
    const r = explainSelection('/src/main.ts', ['/src/main.ts'], new Map());
    expect(r.selected).toBe(false);
    expect(r.reason).toContain('not a test file');
  });

  test('no changed files: full suite would run', () => {
    const r = explainSelection('/tests/main.test.ts', [], new Map());
    expect(r.selected).toBe(false);
    expect(r.reason).toContain('no changed files');
  });

  test('test-file-as-seed: selected with a self chain', () => {
    const r = explainSelection(
      '/tests/main.test.ts',
      ['/tests/main.test.ts'],
      new Map(),
    );
    expect(r.selected).toBe(true);
    expect(r.chain).toEqual(['/tests/main.test.ts']);
  });
});

// ===========================================================================
// Shared plugin harness
// ===========================================================================

function lineWithReason(statsFile: string, reason: string): Record<string, unknown> | undefined {
  return readStats(statsFile).find((l) => l.reason === reason);
}

/** Temp project main.ts → main.test.ts + a warm (fresh) v3 cache. */
function setupProject(): { tmpDir: string; mainPath: string; testPath: string } {
  const tmpDir = makeTempDir(tempDirs, 'vitest-affected-explain-');
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

/** Overwrite the fixture's cache with an explicit metadata (aged / high-run). */
function writeCacheWithMeta(
  tmpDir: string,
  meta: { lastFullRebuild: number; runCount: number },
): void {
  writeFileSync(
    path.join(tmpDir, '.vitest-affected', 'graph.json'),
    JSON.stringify({
      version: 3,
      builtAt: Date.now(),
      lastFullRebuild: meta.lastFullRebuild,
      runCount: meta.runCount,
      reverseMap: { 'src/main.ts': ['tests/main.test.ts'] },
    }),
  );
}

function wiredReporter(vitest: { reporters: unknown[] }): Reporter {
  const r = (vitest.reporters as Reporter[]).find(
    (x) => typeof x.onTestRunEnd === 'function',
  );
  if (!r) throw new Error('no reporter wired');
  return r;
}


// ===========================================================================
// (3) PLUGIN EXPLAIN STATS FIELD — present when enabled, absent by default.
// ===========================================================================

describe('plugin explain stats field', () => {
  test('explain: true attaches the trail to the selective decision line', async () => {
    const { tmpDir, mainPath, testPath } = setupProject();
    const statsFile = path.join(tmpDir, 'stats.jsonl');
    const { vitest, project } = createMockContext(tmpDir);

    await runHook(
      vitestAffected({ changedFiles: [mainPath], cache: true, statsFile, explain: true }),
      { vitest, project },
    );

    const selective = readStats(statsFile).find((l) => l.action === 'selective');
    expect(selective).toBeDefined();
    const explain = selective!.explain as Record<string, { seed: string; chain: string[] }>;
    expect(explain).toBeDefined();
    expect(explain[testPath]).toBeDefined();
    expect(explain[testPath]!.seed).toBe(mainPath);
    expect(explain[testPath]!.chain).toEqual([mainPath, testPath]);
  });

  test('explain is ABSENT by default (keeps default lines small)', async () => {
    const { tmpDir, mainPath } = setupProject();
    const statsFile = path.join(tmpDir, 'stats.jsonl');
    const { vitest, project } = createMockContext(tmpDir);

    await runHook(
      vitestAffected({ changedFiles: [mainPath], cache: true, statsFile }),
      { vitest, project },
    );

    const selective = readStats(statsFile).find((l) => l.action === 'selective');
    expect(selective).toBeDefined();
    expect('explain' in selective!).toBe(false);
  });
});

// ===========================================================================
// (4) CACHE STALENESS METADATA — round-trip + defaults.
// ===========================================================================

describe('cache staleness metadata', () => {
  test('saveCacheSync persists meta; load returns it', () => {
    const tmpDir = makeTempDir(tempDirs, 'vitest-affected-meta-');
    const cacheDir = path.join(tmpDir, '.vitest-affected');
    const reverse = new Map([[path.join(tmpDir, 'src', 'a.ts'), new Set([path.join(tmpDir, 'test', 'a.test.ts')])]]);

    saveCacheSync(cacheDir, reverse, { lastFullRebuild: 123456, runCount: 7 });
    const { hit, meta } = loadCachedReverseMap(cacheDir, tmpDir);

    expect(hit).toBe(true);
    expect(meta.lastFullRebuild).toBe(123456);
    expect(meta.runCount).toBe(7);
  });

  test('default (2-arg) save writes a FRESH baseline (lastFullRebuild≈now, runCount 0)', () => {
    const tmpDir = makeTempDir(tempDirs, 'vitest-affected-meta-');
    const cacheDir = path.join(tmpDir, '.vitest-affected');
    const before = Date.now();

    saveCacheSync(cacheDir, new Map());
    const { meta } = loadCachedReverseMap(cacheDir, tmpDir);

    expect(meta.runCount).toBe(0);
    expect(meta.lastFullRebuild).toBeGreaterThanOrEqual(before);
  });

  test('a v3 cache WITHOUT metadata fields still hits, with zeroed meta (no baseline)', () => {
    const tmpDir = makeTempDir(tempDirs, 'vitest-affected-meta-');
    const cacheDir = path.join(tmpDir, '.vitest-affected');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      path.join(cacheDir, 'graph.json'),
      JSON.stringify({ version: 3, builtAt: Date.now(), reverseMap: { 'src/a.ts': ['test/a.test.ts'] } }),
    );

    const { hit, meta } = loadCachedReverseMap(cacheDir, tmpDir);
    expect(hit).toBe(true);
    expect(meta.lastFullRebuild).toBe(0);
    expect(meta.runCount).toBe(0);
  });
});

// ===========================================================================
// (5) PLUGIN STALENESS RECONCILIATION.
// ===========================================================================

describe('plugin staleness reconciliation', () => {
  test('fresh cache → no cache-stale warning or stats line', async () => {
    const { tmpDir, mainPath } = setupProject(); // fresh save → lastFullRebuild = now
    const statsFile = path.join(tmpDir, 'stats.jsonl');
    const { vitest, project } = createMockContext(tmpDir);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runHook(
      vitestAffected({ changedFiles: [mainPath], cache: true, statsFile }),
      { vitest, project },
    );

    expect(lineWithReason(statsFile, 'cache-stale')).toBeUndefined();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('CACHE STALE'))).toBe(false);
  });

  test('aged cache (older than staleCacheDays) → loud warn + cache-stale stats line', async () => {
    const { tmpDir, mainPath } = setupProject();
    const statsFile = path.join(tmpDir, 'stats.jsonl');
    // 30 days old, default threshold 14.
    writeCacheWithMeta(tmpDir, { lastFullRebuild: Date.now() - 30 * 24 * 60 * 60 * 1000, runCount: 0 });
    const { vitest, project } = createMockContext(tmpDir);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runHook(
      vitestAffected({ changedFiles: [mainPath], cache: true, statsFile }),
      { vitest, project },
    );

    const line = lineWithReason(statsFile, 'cache-stale');
    expect(line).toBeDefined();
    expect(line!.action).toBe('heartbeat');
    expect(line!.staleCacheDays).toBe(14);
    expect(typeof line!.cacheAgeDays).toBe('number');
    expect(warn.mock.calls.some((c) => String(c[0]).includes('CACHE STALE'))).toBe(true);
  });

  test('high selective-run count (over maxSelectiveRuns) → cache-stale stats line', async () => {
    const { tmpDir, mainPath } = setupProject();
    const statsFile = path.join(tmpDir, 'stats.jsonl');
    // Recent rebuild but 99 selective runs since (default threshold 50).
    writeCacheWithMeta(tmpDir, { lastFullRebuild: Date.now() - 1000, runCount: 99 });
    const { vitest, project } = createMockContext(tmpDir);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runHook(
      vitestAffected({ changedFiles: [mainPath], cache: true, statsFile }),
      { vitest, project },
    );

    const line = lineWithReason(statsFile, 'cache-stale');
    expect(line).toBeDefined();
    expect(line!.selectiveRunCount).toBe(99);
  });

  test('a full-suite run resets the metadata (fresh lastFullRebuild, runCount 0)', async () => {
    const { tmpDir, mainPath, testPath } = setupProject();
    const cacheDir = path.join(tmpDir, '.vitest-affected');
    const statsFile = path.join(tmpDir, 'stats.jsonl');
    // Aged + high-run metadata to prove it gets reset.
    writeCacheWithMeta(tmpDir, { lastFullRebuild: Date.now() - 40 * 24 * 60 * 60 * 1000, runCount: 99 });
    // A config-file change forces a FULL suite (selectedTests stays null).
    const pkgPath = path.join(tmpDir, 'package.json');
    writeFileSync(pkgPath, '{"name":"fixture"}\n');
    const { vitest, project, projectConfig } = createMockContext(tmpDir);

    await runHook(
      vitestAffected({ changedFiles: [pkgPath], cache: true, statsFile }),
      { vitest, project },
    );
    // Full suite: include untouched.
    expect(projectConfig.include).toEqual(['tests/**/*.test.ts']);

    // Simulate the completed full-suite run collecting a real edge.
    const reporter = wiredReporter(vitest);
    const mod = mockModule(testPath, { [mainPath]: { selfTime: 1, totalTime: 2 } });
    reporter.onTestModuleEnd!(mod);
    const before = Date.now();
    reporter.onTestRunEnd!([mod], [], 'passed' as TestRunEndReason);

    // Metadata on disk is now reset to a fresh baseline.
    const { meta } = loadCachedReverseMap(cacheDir, tmpDir);
    expect(meta.runCount).toBe(0);
    expect(meta.lastFullRebuild).toBeGreaterThanOrEqual(before);
  });

  test('a selective run ages the metadata (runCount++ , lastFullRebuild preserved)', async () => {
    const { tmpDir, mainPath, testPath } = setupProject();
    const cacheDir = path.join(tmpDir, '.vitest-affected');
    const statsFile = path.join(tmpDir, 'stats.jsonl');
    const baseline = Date.now() - 60 * 60 * 1000; // 1h ago, not yet stale
    writeCacheWithMeta(tmpDir, { lastFullRebuild: baseline, runCount: 3 });
    const { vitest, project, projectConfig } = createMockContext(tmpDir);

    await runHook(
      vitestAffected({ changedFiles: [mainPath], cache: true, statsFile }),
      { vitest, project },
    );
    // Selective decision applied.
    expect(projectConfig.include).toEqual([testPath]);

    const reporter = wiredReporter(vitest);
    const mod = mockModule(testPath, { [mainPath]: { selfTime: 1, totalTime: 2 } });
    reporter.onTestModuleEnd!(mod);
    reporter.onTestRunEnd!([mod], [], 'passed' as TestRunEndReason);

    const { meta } = loadCachedReverseMap(cacheDir, tmpDir);
    expect(meta.runCount).toBe(4); // 3 + 1
    expect(meta.lastFullRebuild).toBe(baseline); // preserved
  });
});
