import { describe, test, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  lstatSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  diffGraphMtimes,
  loadCachedMtimes,
  loadOrBuildGraphSync,
  saveGraphSyncInternal,
  statAllFiles,
} from '../src/graph/cache.js';
import { buildFullGraph, buildFullGraphSync } from '../src/graph/builder.js';
import * as builderModule from '../src/graph/builder.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fixtureDir = (name: string) =>
  path.resolve(import.meta.dirname, 'fixtures', name);

function makeTmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'vitest-cache-sync-test-'));
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
// 1. buildFullGraphSync produces identical graph to buildFullGraph
// ---------------------------------------------------------------------------

describe('buildFullGraphSync', () => {
  test('produces same forward/reverse structure as async buildFullGraph on simple fixture', async () => {
    const simpleDir = fixtureDir('simple');

    const asyncResult = await buildFullGraph(simpleDir);
    const syncResult = buildFullGraphSync(simpleDir);

    // Same keys (files)
    const asyncKeys = [...asyncResult.forward.keys()].sort();
    const syncKeys = [...syncResult.forward.keys()].sort();
    expect(syncKeys).toEqual(asyncKeys);

    // Same forward edges for each file
    for (const key of asyncKeys) {
      const asyncDeps = [...(asyncResult.forward.get(key) ?? new Set())].sort();
      const syncDeps = [...(syncResult.forward.get(key) ?? new Set())].sort();
      expect(syncDeps).toEqual(asyncDeps);
    }

    // Same reverse keys
    const asyncRevKeys = [...asyncResult.reverse.keys()].sort();
    const syncRevKeys = [...syncResult.reverse.keys()].sort();
    expect(syncRevKeys).toEqual(asyncRevKeys);
  });
});

// ---------------------------------------------------------------------------
// 2-5. diffGraphMtimes
// ---------------------------------------------------------------------------

describe('diffGraphMtimes', () => {
  test('detects changed files (same key, different mtime)', () => {
    const cached = new Map([
      ['/project/a.ts', 1000],
      ['/project/b.ts', 2000],
    ]);
    const current = new Map([
      ['/project/a.ts', 1000],
      ['/project/b.ts', 9999], // changed
    ]);

    const result = diffGraphMtimes(cached, current);

    expect(result.changed).toContain('/project/b.ts');
    expect(result.changed).not.toContain('/project/a.ts');
    expect(result.added).toHaveLength(0);
    expect(result.deleted).toHaveLength(0);
  });

  test('detects added files (key only in current)', () => {
    const cached = new Map([['/project/a.ts', 1000]]);
    const current = new Map([
      ['/project/a.ts', 1000],
      ['/project/b.ts', 2000], // new file
    ]);

    const result = diffGraphMtimes(cached, current);

    expect(result.added).toContain('/project/b.ts');
    expect(result.added).not.toContain('/project/a.ts');
    expect(result.changed).toHaveLength(0);
    expect(result.deleted).toHaveLength(0);
  });

  test('detects deleted files (key only in cached)', () => {
    const cached = new Map([
      ['/project/a.ts', 1000],
      ['/project/b.ts', 2000], // will be deleted
    ]);
    const current = new Map([['/project/a.ts', 1000]]);

    const result = diffGraphMtimes(cached, current);

    expect(result.deleted).toContain('/project/b.ts');
    expect(result.deleted).not.toContain('/project/a.ts');
    expect(result.changed).toHaveLength(0);
    expect(result.added).toHaveLength(0);
  });

  test('empty maps produce no changes', () => {
    const result = diffGraphMtimes(new Map(), new Map());

    expect(result.changed).toHaveLength(0);
    expect(result.added).toHaveLength(0);
    expect(result.deleted).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6-7. loadCachedMtimes
// ---------------------------------------------------------------------------

describe('loadCachedMtimes', () => {
  test('returns empty Map when cache file is missing (ENOENT)', () => {
    const cacheDir = makeTmpDir();
    tempDirs.push(cacheDir);
    // Do NOT create graph.json inside — just use the dir itself as cacheDir
    // but write no graph.json
    const nestedCacheDir = path.join(cacheDir, '.vitest-affected');
    // nestedCacheDir does not exist

    const result = loadCachedMtimes(nestedCacheDir);

    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  test('returns empty Map when cache file is corrupt (JSON parse error)', () => {
    const cacheDir = makeTmpDir();
    tempDirs.push(cacheDir);
    writeFileSync(path.join(cacheDir, 'graph.json'), '{ corrupt json {{{{', 'utf-8');

    const result = loadCachedMtimes(cacheDir);

    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  test('returns mtime map from valid cache file', () => {
    const cacheDir = makeTmpDir();
    tempDirs.push(cacheDir);

    const cacheData = {
      version: 1,
      builtAt: Date.now(),
      files: {
        '/project/a.ts': { mtime: 1234567890, imports: [] },
        '/project/b.ts': { mtime: 9876543210, imports: ['/project/a.ts'] },
      },
    };
    writeFileSync(
      path.join(cacheDir, 'graph.json'),
      JSON.stringify(cacheData),
      'utf-8',
    );

    const result = loadCachedMtimes(cacheDir);

    expect(result.get('/project/a.ts')).toBe(1234567890);
    expect(result.get('/project/b.ts')).toBe(9876543210);
  });
});

// ---------------------------------------------------------------------------
// 8-9. statAllFiles
// ---------------------------------------------------------------------------

describe('statAllFiles', () => {
  test('skips files that throw ENOENT (graceful handling)', () => {
    const nonExistentFile = '/nonexistent/path/that/does/not/exist/file.ts';
    const result = statAllFiles([nonExistentFile]);

    // Should not throw; should skip the missing file
    expect(result).toBeInstanceOf(Map);
    expect(result.has(nonExistentFile)).toBe(false);
  });

  test('returns correct mtime map for existing files', () => {
    const tmpDir = makeTmpDir();
    tempDirs.push(tmpDir);

    const fileA = path.join(tmpDir, 'a.ts');
    const fileB = path.join(tmpDir, 'b.ts');
    writeFileSync(fileA, 'export const a = 1;\n', 'utf-8');
    writeFileSync(fileB, 'export const b = 2;\n', 'utf-8');

    const result = statAllFiles([fileA, fileB]);

    expect(result.has(fileA)).toBe(true);
    expect(result.has(fileB)).toBe(true);

    const actualMtimeA = lstatSync(fileA).mtimeMs;
    const actualMtimeB = lstatSync(fileB).mtimeMs;
    expect(result.get(fileA)).toBe(actualMtimeA);
    expect(result.get(fileB)).toBe(actualMtimeB);
  });
});

// ---------------------------------------------------------------------------
// 10. loadOrBuildGraphSync cache hit with no mtime changes
// ---------------------------------------------------------------------------

describe('loadOrBuildGraphSync', () => {
  test('cache hit with valid cache and no mtime changes: returns graph without calling buildFullGraphSync', () => {
    const rootDir = makeTmpDir();
    tempDirs.push(rootDir);
    const cacheDir = path.join(rootDir, '.vitest-affected');

    const aFile = path.join(rootDir, 'src', 'a.ts');
    const bFile = path.join(rootDir, 'src', 'b.ts');
    writeProjectFiles(rootDir, {
      'src/a.ts': 'import { b } from "./b";\nexport const a = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
      'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    });

    // Build forward map with real mtimes
    const mtimes = new Map([
      [aFile, lstatSync(aFile).mtimeMs],
      [bFile, lstatSync(bFile).mtimeMs],
    ]);
    const forward = new Map<string, Set<string>>([
      [aFile, new Set([bFile])],
      [bFile, new Set()],
    ]);

    // Save using sync save with provided mtimes
    saveGraphSyncInternal(forward, cacheDir, mtimes);

    // Spy on buildFullGraphSync to verify it is NOT called on cache hit
    const buildSyncSpy = vi.spyOn(builderModule, 'buildFullGraphSync');

    const { forward: loaded } = loadOrBuildGraphSync(rootDir, cacheDir);

    expect(buildSyncSpy).not.toHaveBeenCalled();
    expect(loaded.has(aFile)).toBe(true);
    expect(loaded.has(bFile)).toBe(true);
    expect(loaded.get(aFile)?.has(bFile)).toBe(true);
  });

  test('full rebuild when cache is missing', () => {
    const rootDir = makeTmpDir();
    tempDirs.push(rootDir);
    const cacheDir = path.join(rootDir, '.vitest-affected');

    writeProjectFiles(rootDir, {
      'src/a.ts': 'export const a = 1;\n',
      'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    });

    const buildSyncSpy = vi.spyOn(builderModule, 'buildFullGraphSync');

    const result = loadOrBuildGraphSync(rootDir, cacheDir);

    expect(buildSyncSpy).toHaveBeenCalledOnce();
    expect(result.forward).toBeDefined();
    expect(result.reverse).toBeDefined();
  });

  test('full rebuild when any file is stale (mtime changed)', () => {
    const rootDir = makeTmpDir();
    tempDirs.push(rootDir);
    const cacheDir = path.join(rootDir, '.vitest-affected');

    const aFile = path.join(rootDir, 'src', 'a.ts');
    const bFile = path.join(rootDir, 'src', 'b.ts');
    writeProjectFiles(rootDir, {
      'src/a.ts': 'import { b } from "./b";\nexport const a = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
      'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    });

    // Save with stale mtime (0) for bFile so it triggers rebuild
    const staleMtimes = new Map([
      [aFile, lstatSync(aFile).mtimeMs],
      [bFile, 0], // stale — doesn't match real mtime
    ]);
    const forward = new Map<string, Set<string>>([
      [aFile, new Set([bFile])],
      [bFile, new Set()],
    ]);
    saveGraphSyncInternal(forward, cacheDir, staleMtimes);

    const buildSyncSpy = vi.spyOn(builderModule, 'buildFullGraphSync');

    loadOrBuildGraphSync(rootDir, cacheDir);

    expect(buildSyncSpy).toHaveBeenCalledOnce();
  });

  // ── bd-q0g: expanded return type ──────────────────────────────────────────

  test('bd-q0g: returns oldMtimes and currentMtimes fields on cache hit (no-staleness)', () => {
    const rootDir = makeTmpDir();
    tempDirs.push(rootDir);
    const cacheDir = path.join(rootDir, '.vitest-affected');

    const aFile = path.join(rootDir, 'src', 'a.ts');
    const bFile = path.join(rootDir, 'src', 'b.ts');
    writeProjectFiles(rootDir, {
      'src/a.ts': 'import { b } from "./b";\nexport const a = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
      'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    });

    const realMtimeA = lstatSync(aFile).mtimeMs;
    const realMtimeB = lstatSync(bFile).mtimeMs;
    const mtimes = new Map([
      [aFile, realMtimeA],
      [bFile, realMtimeB],
    ]);
    const forward = new Map<string, Set<string>>([
      [aFile, new Set([bFile])],
      [bFile, new Set()],
    ]);
    saveGraphSyncInternal(forward, cacheDir, mtimes);

    const result = loadOrBuildGraphSync(rootDir, cacheDir);

    // Must expose both mtime maps
    expect(result).toHaveProperty('oldMtimes');
    expect(result).toHaveProperty('currentMtimes');
    expect(result.oldMtimes).toBeInstanceOf(Map);
    expect(result.currentMtimes).toBeInstanceOf(Map);
  });

  test('bd-q0g: cache hit — oldMtimes matches what was saved and currentMtimes matches real disk mtimes', () => {
    const rootDir = makeTmpDir();
    tempDirs.push(rootDir);
    const cacheDir = path.join(rootDir, '.vitest-affected');

    const aFile = path.join(rootDir, 'src', 'a.ts');
    const bFile = path.join(rootDir, 'src', 'b.ts');
    writeProjectFiles(rootDir, {
      'src/a.ts': 'import { b } from "./b";\nexport const a = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
      'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    });

    const savedMtimeA = lstatSync(aFile).mtimeMs;
    const savedMtimeB = lstatSync(bFile).mtimeMs;
    const savedMtimes = new Map([
      [aFile, savedMtimeA],
      [bFile, savedMtimeB],
    ]);
    const forward = new Map<string, Set<string>>([
      [aFile, new Set([bFile])],
      [bFile, new Set()],
    ]);
    saveGraphSyncInternal(forward, cacheDir, savedMtimes);

    const result = loadOrBuildGraphSync(rootDir, cacheDir);

    // oldMtimes should reflect the values saved in the cache file
    expect(result.oldMtimes.get(aFile)).toBe(savedMtimeA);
    expect(result.oldMtimes.get(bFile)).toBe(savedMtimeB);

    // currentMtimes should reflect real disk mtimes (same here, since files not changed)
    const diskMtimeA = lstatSync(aFile).mtimeMs;
    const diskMtimeB = lstatSync(bFile).mtimeMs;
    expect(result.currentMtimes.get(aFile)).toBe(diskMtimeA);
    expect(result.currentMtimes.get(bFile)).toBe(diskMtimeB);
  });

  test('bd-q0g: cache miss (no graph.json) — oldMtimes and currentMtimes are empty Maps', () => {
    const rootDir = makeTmpDir();
    tempDirs.push(rootDir);
    const cacheDir = path.join(rootDir, '.vitest-affected');

    writeProjectFiles(rootDir, {
      'src/a.ts': 'export const a = 1;\n',
      'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    });

    // No cache file exists — triggers full rebuild
    const result = loadOrBuildGraphSync(rootDir, cacheDir);

    expect(result.oldMtimes).toBeInstanceOf(Map);
    expect(result.currentMtimes).toBeInstanceOf(Map);
    expect(result.oldMtimes.size).toBe(0);
    expect(result.currentMtimes.size).toBe(0);
  });

  test('bd-q0g: stale cache (mtime changed) — oldMtimes and currentMtimes are empty Maps (full rebuild path)', () => {
    const rootDir = makeTmpDir();
    tempDirs.push(rootDir);
    const cacheDir = path.join(rootDir, '.vitest-affected');

    const aFile = path.join(rootDir, 'src', 'a.ts');
    const bFile = path.join(rootDir, 'src', 'b.ts');
    writeProjectFiles(rootDir, {
      'src/a.ts': 'import { b } from "./b";\nexport const a = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
      'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    });

    // Save with a stale mtime — this will trigger full rebuild
    const staleMtimes = new Map([
      [aFile, lstatSync(aFile).mtimeMs],
      [bFile, 0], // stale
    ]);
    const forward = new Map<string, Set<string>>([
      [aFile, new Set([bFile])],
      [bFile, new Set()],
    ]);
    saveGraphSyncInternal(forward, cacheDir, staleMtimes);

    const result = loadOrBuildGraphSync(rootDir, cacheDir);

    // Full rebuild path returns empty mtime maps
    expect(result.oldMtimes).toBeInstanceOf(Map);
    expect(result.currentMtimes).toBeInstanceOf(Map);
    expect(result.oldMtimes.size).toBe(0);
    expect(result.currentMtimes.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// bd-3hg: runtimeEdges persistence
// ---------------------------------------------------------------------------

describe('runtimeEdges persistence', () => {
  test('round-trip: saveGraphSyncInternal with runtimeEdges, loadOrBuildGraphSync returns them in reverse', () => {
    const rootDir = makeTmpDir();
    tempDirs.push(rootDir);
    const cacheDir = path.join(rootDir, '.vitest-affected');

    // srcFile must be under rootDir (path confinement) and in forward map (stale pruning)
    const srcFile = path.join(rootDir, 'src', 'utils.ts');
    const testFile = path.join(rootDir, 'tests', 'utils.test.ts');

    // Write testFile to disk so it passes existsSync check during pruning
    writeProjectFiles(rootDir, {
      'src/utils.ts': 'export const utils = 1;\n',
      'tests/utils.test.ts': 'import { utils } from "../src/utils";\n',
    });

    // Use forward map with srcFile (required to survive stale pruning)
    const forward = new Map<string, Set<string>>([[srcFile, new Set()]]);
    const mtimes = new Map<string, number>();

    // Define runtime edges: source file -> set of test files that loaded it
    const runtimeEdges = new Map<string, Set<string>>([[srcFile, new Set([testFile])]]);

    saveGraphSyncInternal(forward, cacheDir, mtimes, runtimeEdges);

    const { reverse } = loadOrBuildGraphSync(rootDir, cacheDir);

    // Runtime edge should be in the reverse map
    expect(reverse.has(srcFile)).toBe(true);
    expect(reverse.get(srcFile)?.has(testFile)).toBe(true);
  });

  test('save without runtimeEdges preserves existing runtimeEdges (read-merge-write)', () => {
    const rootDir = makeTmpDir();
    tempDirs.push(rootDir);
    const cacheDir = path.join(rootDir, '.vitest-affected');

    // srcFile must be under rootDir and in forward map; testFile must exist on disk
    const srcFile = path.join(rootDir, 'src', 'lib.ts');
    const testFile = path.join(rootDir, 'tests', 'lib.test.ts');

    writeProjectFiles(rootDir, {
      'src/lib.ts': 'export const lib = 1;\n',
      'tests/lib.test.ts': 'import { lib } from "../src/lib";\n',
    });

    const forward = new Map<string, Set<string>>([[srcFile, new Set()]]);
    const mtimes = new Map<string, number>();

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

  test('ENOENT on fresh install: saveGraphSyncInternal without runtimeEdges does not throw', () => {
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

  test('full rebuild discards runtimeEdges: loadOrBuildGraphSync on stale cache does not include them', () => {
    const rootDir = fixtureDir('simple');
    const cacheDir = makeTmpDir();
    tempDirs.push(cacheDir);

    // Write a cache with a real fixture file at stale mtime=0 and runtimeEdges
    // diffGraphMtimes detects the mtime mismatch → full rebuild is triggered
    const realFile = path.join(rootDir, 'src', 'a.ts');
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

    // loadOrBuildGraphSync detects the stale mtime and calls buildFullGraphSync
    // buildFullGraphSync starts fresh — runtime edges from old cache are NOT merged
    const { reverse } = loadOrBuildGraphSync(rootDir, cacheDir);

    // The previously persisted runtime edges must NOT appear
    expect(reverse.has(srcFile)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// saveGraphSyncInternal
// ---------------------------------------------------------------------------

describe('saveGraphSyncInternal', () => {
  test('writes graph.json with no leftover .tmp files', () => {
    const rootDir = makeTmpDir();
    tempDirs.push(rootDir);
    const cacheDir = path.join(rootDir, '.vitest-affected');

    const aFile = path.join(rootDir, 'a.ts');
    writeFileSync(aFile, 'export const a = 1;\n', 'utf-8');

    const forward = new Map<string, Set<string>>([[aFile, new Set()]]);
    const mtimes = new Map([[aFile, lstatSync(aFile).mtimeMs]]);

    saveGraphSyncInternal(forward, cacheDir, mtimes);

    const files = readdirSync(cacheDir);
    expect(files).toContain('graph.json');
    expect(files.some((f) => f.startsWith('.tmp-'))).toBe(false);
  });

  test('written graph.json is valid JSON with version=1', () => {
    const rootDir = makeTmpDir();
    tempDirs.push(rootDir);
    const cacheDir = path.join(rootDir, '.vitest-affected');

    const aFile = path.join(rootDir, 'a.ts');
    writeFileSync(aFile, 'export const a = 1;\n', 'utf-8');

    const forward = new Map<string, Set<string>>([[aFile, new Set()]]);
    saveGraphSyncInternal(forward, cacheDir);

    const raw = readFileSync(path.join(cacheDir, 'graph.json'), 'utf-8');
    const parsed = JSON.parse(raw) as {
      version: number;
      builtAt: number;
      files: Record<string, { mtime: number; imports: string[] }>;
    };

    expect(parsed.version).toBe(1);
    expect(typeof parsed.builtAt).toBe('number');
    expect(parsed.files[aFile]).toBeDefined();
  });
});
