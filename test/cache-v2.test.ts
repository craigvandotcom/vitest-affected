import { describe, test, expect, afterEach, vi } from 'vitest';
import path from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
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
  const dir = mkdtempSync(path.join(tmpdir(), 'vitest-affected-v2-'));
  tempDirs.push(dir);
  return dir;
}

describe('v2 cache round-trip', () => {
  test('saveCacheSync + loadCachedReverseMap returns same data', () => {
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

  test('writes valid JSON with version: 2', () => {
    const rootDir = makeTempDir();
    const cacheDir = path.join(rootDir, '.vitest-affected');

    saveCacheSync(cacheDir, new Map());
    const raw = readFileSync(path.join(cacheDir, 'graph.json'), 'utf-8');
    const parsed = JSON.parse(raw);

    expect(parsed.version).toBe(2);
    expect(typeof parsed.builtAt).toBe('number');
    expect(typeof parsed.reverseMap).toBe('object');
  });
});

describe('v1 → v2 migration', () => {
  test('v1 cache with runtimeEdges is migrated to v2', () => {
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
    expect(reverse.get(path.join(rootDir, 'src', 'a.ts'))!.has(
      path.join(rootDir, 'test', 'a.test.ts'),
    )).toBe(true);
  });

  test('v1 cache without runtimeEdges is a cache miss', () => {
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

describe('corruption recovery', () => {
  test('corrupt JSON returns cache miss', () => {
    const rootDir = makeTempDir();
    const cacheDir = path.join(rootDir, '.vitest-affected');
    mkdirSync(cacheDir, { recursive: true });

    writeFileSync(path.join(cacheDir, 'graph.json'), '{corrupted!!!');

    const { reverse, hit } = loadCachedReverseMap(cacheDir, rootDir);
    expect(hit).toBe(false);
    expect(reverse.size).toBe(0);
  });

  test('missing cache file returns cache miss', () => {
    const rootDir = makeTempDir();
    const cacheDir = path.join(rootDir, '.vitest-affected');

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

  test('v2 with invalid reverseMap schema returns cache miss', () => {
    const rootDir = makeTempDir();
    const cacheDir = path.join(rootDir, '.vitest-affected');
    mkdirSync(cacheDir, { recursive: true });

    writeFileSync(
      path.join(cacheDir, 'graph.json'),
      JSON.stringify({ version: 2, builtAt: Date.now(), reverseMap: 'not-an-object' }),
    );

    const { reverse, hit } = loadCachedReverseMap(cacheDir, rootDir);
    expect(hit).toBe(false);
    expect(reverse.size).toBe(0);
  });
});

describe('path confinement', () => {
  test('entries outside rootDir are excluded', () => {
    const rootDir = makeTempDir();
    const otherDir = makeTempDir();
    const cacheDir = path.join(rootDir, '.vitest-affected');

    const reverse = new Map<string, Set<string>>();
    // Entry under rootDir
    reverse.set(
      path.join(rootDir, 'src', 'a.ts'),
      new Set([path.join(rootDir, 'test', 'a.test.ts')]),
    );
    // Entry outside rootDir
    reverse.set(
      path.join(otherDir, 'src', 'evil.ts'),
      new Set([path.join(otherDir, 'test', 'evil.test.ts')]),
    );

    saveCacheSync(cacheDir, reverse);
    const { reverse: loaded, hit } = loadCachedReverseMap(cacheDir, rootDir);

    expect(hit).toBe(true);
    // Only the entry under rootDir should be loaded
    expect(loaded.size).toBe(1);
    expect(loaded.has(path.join(rootDir, 'src', 'a.ts'))).toBe(true);
    expect(loaded.has(path.join(otherDir, 'src', 'evil.ts'))).toBe(false);
  });

  test('test paths outside rootDir in values are filtered out', () => {
    const rootDir = makeTempDir();
    const otherDir = makeTempDir();
    const cacheDir = path.join(rootDir, '.vitest-affected');

    const reverse = new Map<string, Set<string>>();
    reverse.set(
      path.join(rootDir, 'src', 'a.ts'),
      new Set([
        path.join(rootDir, 'test', 'a.test.ts'),
        path.join(otherDir, 'test', 'evil.test.ts'),
      ]),
    );

    saveCacheSync(cacheDir, reverse);
    const { reverse: loaded, hit } = loadCachedReverseMap(cacheDir, rootDir);

    expect(hit).toBe(true);
    const tests = loaded.get(path.join(rootDir, 'src', 'a.ts'))!;
    expect(tests.size).toBe(1);
    expect(tests.has(path.join(rootDir, 'test', 'a.test.ts'))).toBe(true);
  });
});

describe('proto-pollution protection', () => {
  test('__proto__ keys in cache are rejected', () => {
    const rootDir = makeTempDir();
    const cacheDir = path.join(rootDir, '.vitest-affected');
    mkdirSync(cacheDir, { recursive: true });

    // Craft a v2 cache with __proto__ key
    const malicious = JSON.stringify({
      version: 2,
      builtAt: Date.now(),
      reverseMap: {
        __proto__: [path.join(rootDir, 'test', 'a.test.ts')],
        [path.join(rootDir, 'src', 'a.ts')]: [path.join(rootDir, 'test', 'a.test.ts')],
      },
    });
    writeFileSync(path.join(cacheDir, 'graph.json'), malicious);

    const { reverse, hit } = loadCachedReverseMap(cacheDir, rootDir);
    expect(hit).toBe(true);
    // __proto__ key should have been removed by safeJsonReviver
    expect(reverse.size).toBe(1);
  });
});

describe('orphaned tmp cleanup', () => {
  test('cleans up .tmp- files on load', () => {
    const rootDir = makeTempDir();
    const cacheDir = path.join(rootDir, '.vitest-affected');
    mkdirSync(cacheDir, { recursive: true });

    // Create orphaned tmp files
    writeFileSync(path.join(cacheDir, '.tmp-abc123'), 'garbage');
    writeFileSync(path.join(cacheDir, '.tmp-def456'), 'garbage');

    loadCachedReverseMap(cacheDir, rootDir);

    // Should not throw and orphans should be cleaned
    const entries = readdirSync(cacheDir);
    expect(entries.filter((e: string) => e.startsWith('.tmp-'))).toEqual([]);
  });
});

describe('verbose logging', () => {
  test('logs v2 cache hit in verbose mode', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rootDir = makeTempDir();
    const cacheDir = path.join(rootDir, '.vitest-affected');

    saveCacheSync(cacheDir, new Map());
    loadCachedReverseMap(cacheDir, rootDir, true);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('v2 cache hit'),
    );
    warnSpy.mockRestore();
  });

  test('logs v1 migration in verbose mode', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rootDir = makeTempDir();
    const cacheDir = path.join(rootDir, '.vitest-affected');
    mkdirSync(cacheDir, { recursive: true });

    writeFileSync(
      path.join(cacheDir, 'graph.json'),
      JSON.stringify({
        version: 1,
        builtAt: Date.now(),
        files: {},
        runtimeEdges: {
          [path.join(rootDir, 'src', 'a.ts')]: [path.join(rootDir, 'test', 'a.test.ts')],
        },
      }),
    );

    loadCachedReverseMap(cacheDir, rootDir, true);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('v1→v2 migration'),
    );
    warnSpy.mockRestore();
  });
});
