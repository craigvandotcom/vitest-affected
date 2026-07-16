import { describe, test, expect, afterEach, vi } from 'vitest';
import path from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, utimesSync } from 'node:fs';
import { loadCachedReverseMap, saveCacheSync } from '../src/graph/cache.js';
import { makeTempDir as makeTempDirTracked, cleanupTempDirs } from './_helpers.js';

const tempDirs: string[] = [];

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

// loadCachedReverseMap canonicalizes keys/values on load, so fixture literals
// must be canonical or lookups by the raw alias fail — makeTempDir realpaths.
function makeTempDir(): string {
  return makeTempDirTracked(tempDirs, 'vitest-affected-v3-');
}

describe('v3 cache round-trip', () => {
  test('saveCacheSync + loadCachedReverseMap returns same data (identity)', () => {
    const rootDir = makeTempDir();
    const cacheDir = path.join(rootDir, '.vitest-affected');

    const reverse = new Map<string, Set<string>>();
    reverse.set(
      path.join(rootDir, 'src', 'a.ts'),
      new Set([path.join(rootDir, 'test', 'a.test.ts')]),
    );
    reverse.set(
      path.join(rootDir, 'src', 'b.ts'),
      new Set([
        path.join(rootDir, 'test', 'a.test.ts'),
        path.join(rootDir, 'test', 'b.test.ts'),
      ]),
    );

    saveCacheSync(cacheDir, reverse);
    const { reverse: loaded, hit } = loadCachedReverseMap(cacheDir, rootDir);

    expect(hit).toBe(true);
    expect(loaded.size).toBe(2);
    expect([...loaded.get(path.join(rootDir, 'src', 'a.ts'))!]).toEqual([
      path.join(rootDir, 'test', 'a.test.ts'),
    ]);
    expect(loaded.get(path.join(rootDir, 'src', 'b.ts'))!.size).toBe(2);
  });

  test('empty reverse map round-trips correctly', () => {
    const rootDir = makeTempDir();
    const cacheDir = path.join(rootDir, '.vitest-affected');

    saveCacheSync(cacheDir, new Map());
    const { reverse, hit } = loadCachedReverseMap(cacheDir, rootDir);

    expect(hit).toBe(true);
    expect(reverse.size).toBe(0);
  });

  test('writes valid JSON with version: 3, and paths on disk are rootDir-relative (not absolute)', () => {
    const rootDir = makeTempDir();
    const cacheDir = path.join(rootDir, '.vitest-affected');

    const reverse = new Map<string, Set<string>>();
    reverse.set(
      path.join(rootDir, 'src', 'a.ts'),
      new Set([path.join(rootDir, 'test', 'a.test.ts')]),
    );
    saveCacheSync(cacheDir, reverse);

    const raw = readFileSync(path.join(cacheDir, 'graph.json'), 'utf-8');
    const parsed = JSON.parse(raw);

    expect(parsed.version).toBe(3);
    expect(typeof parsed.builtAt).toBe('number');
    expect(typeof parsed.reverseMap).toBe('object');

    // The whole point of v3: keys/values are relative, so the absolute
    // rootDir must not appear anywhere in the persisted JSON.
    expect(raw.includes(rootDir)).toBe(false);
    const keys = Object.keys(parsed.reverseMap);
    expect(keys).toEqual(['src/a.ts']);
    expect(parsed.reverseMap['src/a.ts']).toEqual(['test/a.test.ts']);
  });
});

describe('v3 portability property', () => {
  test('a v3 cache produced at rootDir A loads correctly when restored at a different rootDir B', () => {
    const rootA = makeTempDir();
    const rootB = makeTempDir();
    const cacheDirA = path.join(rootA, '.vitest-affected');
    const cacheDirB = path.join(rootB, '.vitest-affected');

    // Identical relative structure under both roots.
    const reverseA = new Map<string, Set<string>>();
    reverseA.set(
      path.join(rootA, 'src', 'a.ts'),
      new Set([
        path.join(rootA, 'test', 'a.test.ts'),
        path.join(rootA, 'test', 'b.test.ts'),
      ]),
    );
    saveCacheSync(cacheDirA, reverseA);

    // Simulate a CI cache restore into a fresh checkout at a different path:
    // copy the raw graph.json produced at rootA into rootB's cache dir
    // untouched.
    mkdirSync(cacheDirB, { recursive: true });
    const raw = readFileSync(path.join(cacheDirA, 'graph.json'), 'utf-8');
    writeFileSync(path.join(cacheDirB, 'graph.json'), raw);

    const { reverse, hit } = loadCachedReverseMap(cacheDirB, rootB);

    expect(hit).toBe(true);
    expect(reverse.size).toBe(1);

    // Rejoined against rootB's absolute path, not rootA's.
    expect(reverse.has(path.join(rootB, 'src', 'a.ts'))).toBe(true);
    expect([...reverse.get(path.join(rootB, 'src', 'a.ts'))!].sort()).toEqual(
      [
        path.join(rootB, 'test', 'a.test.ts'),
        path.join(rootB, 'test', 'b.test.ts'),
      ].sort(),
    );

    // The rootA-specific absolute path must not leak into the rootB load.
    expect(reverse.has(path.join(rootA, 'src', 'a.ts'))).toBe(false);
  });
});

describe('v2 → v3 migration', () => {
  test('a v2 cache (absolute paths) auto-migrates on load', () => {
    const rootDir = makeTempDir();
    const cacheDir = path.join(rootDir, '.vitest-affected');
    mkdirSync(cacheDir, { recursive: true });

    const v2Cache = {
      version: 2,
      builtAt: Date.now(),
      reverseMap: {
        [path.join(rootDir, 'src', 'a.ts')]: [
          path.join(rootDir, 'test', 'a.test.ts'),
        ],
      },
    };
    writeFileSync(path.join(cacheDir, 'graph.json'), JSON.stringify(v2Cache));

    const { reverse, hit } = loadCachedReverseMap(cacheDir, rootDir);

    expect(hit).toBe(true);
    expect(reverse.size).toBe(1);
    expect(
      reverse.get(path.join(rootDir, 'src', 'a.ts'))!.has(
        path.join(rootDir, 'test', 'a.test.ts'),
      ),
    ).toBe(true);
  });

  test('logs "v2→v3 migration" in verbose mode', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rootDir = makeTempDir();
    const cacheDir = path.join(rootDir, '.vitest-affected');
    mkdirSync(cacheDir, { recursive: true });

    writeFileSync(
      path.join(cacheDir, 'graph.json'),
      JSON.stringify({
        version: 2,
        builtAt: Date.now(),
        reverseMap: {
          [path.join(rootDir, 'src', 'a.ts')]: [
            path.join(rootDir, 'test', 'a.test.ts'),
          ],
        },
      }),
    );

    loadCachedReverseMap(cacheDir, rootDir, true);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('v2→v3 migration'),
    );
    warnSpy.mockRestore();
  });

  test('v2 cache written by an older saveCacheSync (simulated) that has since been overwritten by a v3 save still round-trips going forward', () => {
    // Not a real prior release — just proves the migration path produces a
    // reverse map that, once re-saved, is persisted as v3.
    const rootDir = makeTempDir();
    const cacheDir = path.join(rootDir, '.vitest-affected');
    mkdirSync(cacheDir, { recursive: true });

    writeFileSync(
      path.join(cacheDir, 'graph.json'),
      JSON.stringify({
        version: 2,
        builtAt: Date.now(),
        reverseMap: {
          [path.join(rootDir, 'src', 'a.ts')]: [
            path.join(rootDir, 'test', 'a.test.ts'),
          ],
        },
      }),
    );

    const { reverse } = loadCachedReverseMap(cacheDir, rootDir);
    saveCacheSync(cacheDir, reverse);

    const raw = readFileSync(path.join(cacheDir, 'graph.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(3);
  });
});

describe('v1 → v3 migration (chain unbroken)', () => {
  test('v1 cache with runtimeEdges still migrates', () => {
    const rootDir = makeTempDir();
    const cacheDir = path.join(rootDir, '.vitest-affected');
    mkdirSync(cacheDir, { recursive: true });

    const v1Cache = {
      version: 1,
      builtAt: Date.now(),
      files: {
        [path.join(rootDir, 'src', 'a.ts')]: { mtime: 1000, imports: [] },
      },
      runtimeEdges: {
        [path.join(rootDir, 'src', 'a.ts')]: [
          path.join(rootDir, 'test', 'a.test.ts'),
        ],
      },
    };

    writeFileSync(path.join(cacheDir, 'graph.json'), JSON.stringify(v1Cache));

    const { reverse, hit } = loadCachedReverseMap(cacheDir, rootDir);
    expect(hit).toBe(true);
    expect(reverse.size).toBe(1);
    expect(
      reverse.get(path.join(rootDir, 'src', 'a.ts'))!.has(
        path.join(rootDir, 'test', 'a.test.ts'),
      ),
    ).toBe(true);
  });

  test('v1 cache without runtimeEdges is still a cache miss', () => {
    const rootDir = makeTempDir();
    const cacheDir = path.join(rootDir, '.vitest-affected');
    mkdirSync(cacheDir, { recursive: true });

    const v1Cache = {
      version: 1,
      builtAt: Date.now(),
      files: {
        [path.join(rootDir, 'src', 'a.ts')]: { mtime: 1000, imports: [] },
      },
    };

    writeFileSync(path.join(cacheDir, 'graph.json'), JSON.stringify(v1Cache));

    const { reverse, hit } = loadCachedReverseMap(cacheDir, rootDir);
    expect(hit).toBe(false);
    expect(reverse.size).toBe(0);
  });
});

describe('corruption / unknown version safety', () => {
  test('corrupt JSON returns cache miss', () => {
    const rootDir = makeTempDir();
    const cacheDir = path.join(rootDir, '.vitest-affected');
    mkdirSync(cacheDir, { recursive: true });

    writeFileSync(path.join(cacheDir, 'graph.json'), '{corrupted!!!');

    const { reverse, hit } = loadCachedReverseMap(cacheDir, rootDir);
    expect(hit).toBe(false);
    expect(reverse.size).toBe(0);
  });

  test('unknown version returns cache miss', () => {
    const rootDir = makeTempDir();
    const cacheDir = path.join(rootDir, '.vitest-affected');
    mkdirSync(cacheDir, { recursive: true });

    writeFileSync(
      path.join(cacheDir, 'graph.json'),
      JSON.stringify({ version: 99, data: {} }),
    );

    const { reverse, hit } = loadCachedReverseMap(cacheDir, rootDir);
    expect(hit).toBe(false);
    expect(reverse.size).toBe(0);
  });

  test('v3 with invalid reverseMap schema returns cache miss', () => {
    const rootDir = makeTempDir();
    const cacheDir = path.join(rootDir, '.vitest-affected');
    mkdirSync(cacheDir, { recursive: true });

    writeFileSync(
      path.join(cacheDir, 'graph.json'),
      JSON.stringify({ version: 3, builtAt: Date.now(), reverseMap: 'not-an-object' }),
    );

    const { reverse, hit } = loadCachedReverseMap(cacheDir, rootDir);
    expect(hit).toBe(false);
    expect(reverse.size).toBe(0);
  });

  test('a relative path crafted with ../ segments to escape rootDir is confined out', () => {
    const rootDir = makeTempDir();
    const cacheDir = path.join(rootDir, '.vitest-affected');
    mkdirSync(cacheDir, { recursive: true });

    // A malicious/corrupt v3 cache with a traversal-escaping relative key.
    writeFileSync(
      path.join(cacheDir, 'graph.json'),
      JSON.stringify({
        version: 3,
        builtAt: Date.now(),
        reverseMap: {
          '../../etc/evil.ts': ['test/a.test.ts'],
          'src/a.ts': ['test/a.test.ts'],
        },
      }),
    );

    const { reverse, hit } = loadCachedReverseMap(cacheDir, rootDir);
    expect(hit).toBe(true);
    // Only the confined, non-escaping entry survives.
    expect(reverse.size).toBe(1);
    expect(reverse.has(path.join(rootDir, 'src', 'a.ts'))).toBe(true);
  });
});

describe('v3 verbose logging', () => {
  test('logs "v3 cache hit" in verbose mode', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rootDir = makeTempDir();
    const cacheDir = path.join(rootDir, '.vitest-affected');

    saveCacheSync(cacheDir, new Map());
    loadCachedReverseMap(cacheDir, rootDir, true);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('v3 cache hit'),
    );
    warnSpy.mockRestore();
  });
});

describe('mtime-guarded orphaned tmp cleanup', () => {
  test('spares a fresh .tmp- file and reaps an aged one', () => {
    const rootDir = makeTempDir();
    const cacheDir = path.join(rootDir, '.vitest-affected');
    mkdirSync(cacheDir, { recursive: true });

    const freshTmp = path.join(cacheDir, '.tmp-fresh');
    const agedTmp = path.join(cacheDir, '.tmp-aged');
    writeFileSync(freshTmp, 'garbage');
    writeFileSync(agedTmp, 'garbage');

    // Backdate the aged file well past the 60s mtime-guard threshold; leave
    // the fresh file at its natural (just-written) mtime.
    const oldTime = new Date(Date.now() - 120_000);
    utimesSync(agedTmp, oldTime, oldTime);

    loadCachedReverseMap(cacheDir, rootDir);

    const entries = readdirSync(cacheDir);
    expect(entries).toContain('.tmp-fresh');
    expect(entries).not.toContain('.tmp-aged');
  });
});

describe('saveCacheSync concurrency union (observedTests)', () => {
  test('CONCURRENT-WRITER: unions in disk edges for tests this run did not observe', () => {
    const rootDir = makeTempDir();
    const cacheDir = path.join(rootDir, '.vitest-affected');

    const sourceX = path.join(rootDir, 'src', 'x.ts');
    const testB = path.join(rootDir, 'test', 'b.test.ts');
    const sourceY = path.join(rootDir, 'src', 'y.ts');
    const testA = path.join(rootDir, 'test', 'a.test.ts');

    // Simulate a concurrent writer: on-disk graph has test B importing source X.
    saveCacheSync(cacheDir, new Map([[sourceX, new Set([testB])]]));

    // This run observed only test A, recording A -> Y (source Y imported by A).
    saveCacheSync(
      cacheDir,
      new Map([[sourceY, new Set([testA])]]),
      {},
      { observedTests: new Set([testA]) },
    );

    const { reverse } = loadCachedReverseMap(cacheDir, rootDir);
    expect(reverse.get(sourceX)?.has(testB)).toBe(true);
    expect(reverse.get(sourceY)?.has(testA)).toBe(true);
  });

  test('REMOVAL-REGRESSION: does not resurrect an edge stripped from an observed test', () => {
    const rootDir = makeTempDir();
    const cacheDir = path.join(rootDir, '.vitest-affected');

    const sourceX = path.join(rootDir, 'src', 'x.ts');
    const testA = path.join(rootDir, 'test', 'a.test.ts');

    // On-disk: A imports X.
    saveCacheSync(cacheDir, new Map([[sourceX, new Set([testA])]]));

    // This run observed A, but A no longer imports X (the edge was already
    // stripped upstream by mergeRuntimeEdges before saveCacheSync is called —
    // simulated here by a map with no entry for A at all).
    saveCacheSync(cacheDir, new Map(), {}, { observedTests: new Set([testA]) });

    const { reverse } = loadCachedReverseMap(cacheDir, rootDir);
    expect(reverse.has(sourceX)).toBe(false);
  });

  test('observedTests absent skips the union entirely (plain overwrite)', () => {
    const rootDir = makeTempDir();
    const cacheDir = path.join(rootDir, '.vitest-affected');

    const sourceX = path.join(rootDir, 'src', 'x.ts');
    const testB = path.join(rootDir, 'test', 'b.test.ts');

    saveCacheSync(cacheDir, new Map([[sourceX, new Set([testB])]]));
    // No observedTests supplied — today's behavior: a plain overwrite that
    // does not read or union disk state at all.
    saveCacheSync(cacheDir, new Map());

    const { reverse } = loadCachedReverseMap(cacheDir, rootDir);
    expect(reverse.size).toBe(0);
  });
});

describe('git identity persistence', () => {
  test('saveCacheSync persists headSha/branch and loadCachedReverseMap surfaces them', () => {
    const rootDir = makeTempDir();
    const cacheDir = path.join(rootDir, '.vitest-affected');

    saveCacheSync(cacheDir, new Map(), { headSha: 'abc123def456', branch: 'main' });
    const { meta } = loadCachedReverseMap(cacheDir, rootDir);

    expect(meta.headSha).toBe('abc123def456');
    expect(meta.branch).toBe('main');
  });

  test('a v3 cache lacking headSha/branch read-migrates with undefined (no baseline)', () => {
    const rootDir = makeTempDir();
    const cacheDir = path.join(rootDir, '.vitest-affected');
    mkdirSync(cacheDir, { recursive: true });

    writeFileSync(
      path.join(cacheDir, 'graph.json'),
      JSON.stringify({
        version: 3,
        builtAt: Date.now(),
        lastFullRebuild: 0,
        runCount: 0,
        reverseMap: {},
      }),
    );

    const { meta } = loadCachedReverseMap(cacheDir, rootDir);
    expect(meta.headSha).toBeUndefined();
    expect(meta.branch).toBeUndefined();
  });
});

describe('growth prune (full-suite saves only)', () => {
  test('a full-suite save prunes a deleted source key and a dangling deleted-test value', () => {
    const rootDir = makeTempDir();
    const cacheDir = path.join(rootDir, '.vitest-affected');

    const deletedSource = path.join(rootDir, 'src', 'gone.ts');
    const deletedTest = path.join(rootDir, 'test', 'gone.test.ts');
    const liveSource = path.join(rootDir, 'src', 'a.ts');
    const liveTest = path.join(rootDir, 'test', 'a.test.ts');

    mkdirSync(path.dirname(liveSource), { recursive: true });
    writeFileSync(liveSource, '');
    mkdirSync(path.dirname(liveTest), { recursive: true });
    writeFileSync(liveTest, '');

    const reverse = new Map<string, Set<string>>([
      [deletedSource, new Set([liveTest])],
      [liveSource, new Set([liveTest, deletedTest])],
    ]);

    saveCacheSync(cacheDir, reverse, {}, { fullSuite: true });

    const { reverse: loaded } = loadCachedReverseMap(cacheDir, rootDir);
    expect(loaded.has(deletedSource)).toBe(false);
    expect(loaded.get(liveSource)?.has(deletedTest)).toBe(false);
    expect(loaded.get(liveSource)?.has(liveTest)).toBe(true);
  });

  test('prune sweeps a dead entry re-introduced by the step-2 disk union', () => {
    const rootDir = makeTempDir();
    const cacheDir = path.join(rootDir, '.vitest-affected');

    const deletedSource = path.join(rootDir, 'src', 'gone.ts');
    const liveTest = path.join(rootDir, 'test', 'a.test.ts');
    mkdirSync(path.dirname(liveTest), { recursive: true });
    writeFileSync(liveTest, '');

    // A concurrent writer's on-disk state has a dead source key that step 2's
    // union would otherwise carry forward untouched.
    saveCacheSync(cacheDir, new Map([[deletedSource, new Set([liveTest])]]));

    // Full-suite run observes nothing new, but the union (observedTests: {})
    // still re-admits the disk entry — the prune step must still sweep it.
    saveCacheSync(
      cacheDir,
      new Map(),
      {},
      { observedTests: new Set(), fullSuite: true },
    );

    const { reverse: loaded } = loadCachedReverseMap(cacheDir, rootDir);
    expect(loaded.has(deletedSource)).toBe(false);
  });

  test('a selective save does NOT sweep dead entries', () => {
    const rootDir = makeTempDir();
    const cacheDir = path.join(rootDir, '.vitest-affected');

    const deletedSource = path.join(rootDir, 'src', 'gone.ts');
    const liveTest = path.join(rootDir, 'test', 'a.test.ts');
    mkdirSync(path.dirname(liveTest), { recursive: true });
    writeFileSync(liveTest, '');

    const reverse = new Map<string, Set<string>>([[deletedSource, new Set([liveTest])]]);
    saveCacheSync(cacheDir, reverse); // no fullSuite flag — no sweep

    const { reverse: loaded } = loadCachedReverseMap(cacheDir, rootDir);
    expect(loaded.has(deletedSource)).toBe(true);
  });
});
