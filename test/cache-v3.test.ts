import { describe, test, expect, afterEach, vi } from 'vitest';
import path from 'node:path';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { loadCachedReverseMap, saveCacheSync } from '../src/graph/cache.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  tempDirs.length = 0;
});

function makeTempDir(): string {
  // realpathSync: os.tmpdir() sits behind a symlink on macOS (/var -> /private/var);
  // loadCachedReverseMap canonicalizes keys/values on load, so fixture literals
  // must be canonical or lookups by the raw alias fail.
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'vitest-affected-v3-')));
  tempDirs.push(dir);
  return dir;
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
