/**
 * bd-sx0: Cache robustness — schema validation, path confinement, stale pruning
 *
 * Tests cover:
 *   1. Schema validation: invalid disk.files entries trigger full rebuild
 *   2. Schema validation: invalid runtimeEdges skips merge only (no full rebuild)
 *   3. Path confinement: disk.files key outside rootDir is skipped, valid entries preserved
 *   4. Path confinement: runtimeEdges key outside rootDir is skipped
 *   5. Stale pruning: saveGraphSyncInternal prunes runtimeEdges keys not in forward map
 *
 * TDD: tests written BEFORE implementation (RED → GREEN)
 */
import { describe, test, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  lstatSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  loadOrBuildGraph,
  loadOrBuildGraphSync,
  saveGraphSyncInternal,
} from '../src/graph/cache.js';
import * as builderModule from '../src/graph/builder.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'vitest-robustness-test-'));
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

function writeCacheFile(cacheDir: string, content: unknown): void {
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    path.join(cacheDir, 'graph.json'),
    JSON.stringify(content),
    'utf-8',
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
// 1. Schema Validation — disk.files invalid → full rebuild (async path)
// ---------------------------------------------------------------------------

describe('bd-sx0: schema validation — loadOrBuildGraph (async)', () => {
  test('mtime as string (not number) triggers full rebuild — no exception thrown', async () => {
    const rootDir = makeTmpDir();
    tempDirs.push(rootDir);
    const cacheDir = path.join(rootDir, '.vitest-affected');

    writeProjectFiles(rootDir, {
      'src/a.ts': 'export const a = 1;\n',
      'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    });

    // Schema-invalid: mtime is a string instead of number
    writeCacheFile(cacheDir, {
      version: 1,
      builtAt: Date.now(),
      files: {
        [path.join(rootDir, 'src/a.ts')]: {
          mtime: 'not-a-number', // INVALID
          imports: [],
        },
      },
    });

    const buildSpy = vi.spyOn(builderModule, 'buildFullGraph');

    // Direct call — any throw will fail the test naturally
    const result = await loadOrBuildGraph(rootDir, cacheDir);

    // Full rebuild triggered due to schema violation
    expect(buildSpy).toHaveBeenCalledOnce();
    expect(result.forward).toBeDefined();
    expect(result.reverse).toBeDefined();
  });

  test('imports array containing numbers triggers full rebuild — no exception', async () => {
    const rootDir = makeTmpDir();
    tempDirs.push(rootDir);
    const cacheDir = path.join(rootDir, '.vitest-affected');

    writeProjectFiles(rootDir, {
      'src/a.ts': 'export const a = 1;\n',
      'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    });

    const aFile = path.join(rootDir, 'src', 'a.ts');

    // Schema-invalid: imports contains a number
    writeCacheFile(cacheDir, {
      version: 1,
      builtAt: Date.now(),
      files: {
        [aFile]: {
          mtime: lstatSync(aFile).mtimeMs,
          imports: [42, 'some-string'], // INVALID: contains number
        },
      },
    });

    const buildSpy = vi.spyOn(builderModule, 'buildFullGraph');

    const result = await loadOrBuildGraph(rootDir, cacheDir);

    expect(buildSpy).toHaveBeenCalledOnce();
    expect(result.forward).toBeDefined();
  });

  test('disk.files not a plain object triggers full rebuild', async () => {
    const rootDir = makeTmpDir();
    tempDirs.push(rootDir);
    const cacheDir = path.join(rootDir, '.vitest-affected');

    writeProjectFiles(rootDir, {
      'src/a.ts': 'export const a = 1;\n',
      'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    });

    // Schema-invalid: files is an array instead of object
    writeCacheFile(cacheDir, {
      version: 1,
      builtAt: Date.now(),
      files: [{ mtime: 1, imports: [] }], // INVALID: array
    });

    const buildSpy = vi.spyOn(builderModule, 'buildFullGraph');

    await loadOrBuildGraph(rootDir, cacheDir);

    expect(buildSpy).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// 2. Schema Validation — disk.files invalid → full rebuild (sync path)
// ---------------------------------------------------------------------------

describe('bd-sx0: schema validation — loadOrBuildGraphSync', () => {
  test('mtime as string (not number) triggers full rebuild — no exception thrown', () => {
    const rootDir = makeTmpDir();
    tempDirs.push(rootDir);
    const cacheDir = path.join(rootDir, '.vitest-affected');

    writeProjectFiles(rootDir, {
      'src/a.ts': 'export const a = 1;\n',
      'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    });

    // Schema-invalid: mtime is a string
    writeCacheFile(cacheDir, {
      version: 1,
      builtAt: Date.now(),
      files: {
        [path.join(rootDir, 'src/a.ts')]: {
          mtime: 'not-a-number', // INVALID
          imports: [],
        },
      },
    });

    const buildSyncSpy = vi.spyOn(builderModule, 'buildFullGraphSync');

    const result = loadOrBuildGraphSync(rootDir, cacheDir);

    expect(buildSyncSpy).toHaveBeenCalledOnce();
    expect(result.forward).toBeDefined();
    expect(result.reverse).toBeDefined();
  });

  test('imports array containing non-string elements triggers full rebuild', () => {
    const rootDir = makeTmpDir();
    tempDirs.push(rootDir);
    const cacheDir = path.join(rootDir, '.vitest-affected');

    writeProjectFiles(rootDir, {
      'src/a.ts': 'export const a = 1;\n',
      'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    });

    const aFile = path.join(rootDir, 'src', 'a.ts');

    writeCacheFile(cacheDir, {
      version: 1,
      builtAt: Date.now(),
      files: {
        [aFile]: {
          mtime: lstatSync(aFile).mtimeMs,
          imports: [true, 'valid-string'], // INVALID: contains boolean
        },
      },
    });

    const buildSyncSpy = vi.spyOn(builderModule, 'buildFullGraphSync');

    loadOrBuildGraphSync(rootDir, cacheDir);

    expect(buildSyncSpy).toHaveBeenCalledOnce();
  });

  test('disk.files not a plain object triggers full rebuild', () => {
    const rootDir = makeTmpDir();
    tempDirs.push(rootDir);
    const cacheDir = path.join(rootDir, '.vitest-affected');

    writeProjectFiles(rootDir, {
      'src/a.ts': 'export const a = 1;\n',
      'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    });

    // files is null — not a plain object
    writeCacheFile(cacheDir, {
      version: 1,
      builtAt: Date.now(),
      files: null, // INVALID
    });

    const buildSyncSpy = vi.spyOn(builderModule, 'buildFullGraphSync');

    loadOrBuildGraphSync(rootDir, cacheDir);

    expect(buildSyncSpy).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// 3. Schema Validation — runtimeEdges invalid → skip merge, NOT full rebuild
// ---------------------------------------------------------------------------

describe('bd-sx0: schema validation — runtimeEdges invalid → skip merge, no full rebuild', () => {
  test('runtimeEdges not a plain object: skip merge, continue with static graph (async)', async () => {
    const rootDir = makeTmpDir();
    tempDirs.push(rootDir);
    const cacheDir = path.join(rootDir, '.vitest-affected');

    const aFile = path.join(rootDir, 'src', 'a.ts');
    writeProjectFiles(rootDir, {
      'src/a.ts': 'export const a = 1;\n',
      'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    });

    const validMtime = lstatSync(aFile).mtimeMs;

    writeCacheFile(cacheDir, {
      version: 1,
      builtAt: Date.now(),
      files: {
        [aFile]: { mtime: validMtime, imports: [] },
      },
      runtimeEdges: 'not-an-object', // INVALID
    });

    const buildSpy = vi.spyOn(builderModule, 'buildFullGraph');

    const result = await loadOrBuildGraph(rootDir, cacheDir);

    // Full rebuild should NOT be triggered (only runtimeEdges is invalid)
    expect(buildSpy).not.toHaveBeenCalled();

    // Static graph should still be loaded
    expect(result.forward.has(aFile)).toBe(true);
  });

  test('runtimeEdges values not string[] arrays: skip merge, continue with static graph (async)', async () => {
    const rootDir = makeTmpDir();
    tempDirs.push(rootDir);
    const cacheDir = path.join(rootDir, '.vitest-affected');

    const aFile = path.join(rootDir, 'src', 'a.ts');
    writeProjectFiles(rootDir, {
      'src/a.ts': 'export const a = 1;\n',
      'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    });

    const validMtime = lstatSync(aFile).mtimeMs;

    writeCacheFile(cacheDir, {
      version: 1,
      builtAt: Date.now(),
      files: {
        [aFile]: { mtime: validMtime, imports: [] },
      },
      runtimeEdges: {
        '/some/src.ts': 'not-an-array', // INVALID: value is a string, not string[]
      },
    });

    const buildSpy = vi.spyOn(builderModule, 'buildFullGraph');

    const result = await loadOrBuildGraph(rootDir, cacheDir);

    expect(buildSpy).not.toHaveBeenCalled();
    expect(result.forward.has(aFile)).toBe(true);
  });

  test('runtimeEdges invalid: skip merge, no full rebuild (sync path)', () => {
    const rootDir = makeTmpDir();
    tempDirs.push(rootDir);
    const cacheDir = path.join(rootDir, '.vitest-affected');

    const aFile = path.join(rootDir, 'src', 'a.ts');
    writeProjectFiles(rootDir, {
      'src/a.ts': 'export const a = 1;\n',
      'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    });

    const validMtime = lstatSync(aFile).mtimeMs;

    writeCacheFile(cacheDir, {
      version: 1,
      builtAt: Date.now(),
      files: {
        [aFile]: { mtime: validMtime, imports: [] },
      },
      runtimeEdges: ['invalid-array-form'], // INVALID: array not object
    });

    const buildSyncSpy = vi.spyOn(builderModule, 'buildFullGraphSync');

    const result = loadOrBuildGraphSync(rootDir, cacheDir);

    // No full rebuild
    expect(buildSyncSpy).not.toHaveBeenCalled();
    // Static graph is present
    expect(result.forward.has(aFile)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Path Confinement — disk.files key outside rootDir is skipped
// ---------------------------------------------------------------------------

describe('bd-sx0: path confinement — disk.files key outside rootDir', () => {
  test('key outside rootDir is skipped; valid entries are preserved (async)', async () => {
    const rootDir = makeTmpDir();
    tempDirs.push(rootDir);
    const cacheDir = path.join(rootDir, '.vitest-affected');

    const aFile = path.join(rootDir, 'src', 'a.ts');
    writeProjectFiles(rootDir, {
      'src/a.ts': 'export const a = 1;\n',
      'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    });

    const validMtime = lstatSync(aFile).mtimeMs;

    writeCacheFile(cacheDir, {
      version: 1,
      builtAt: Date.now(),
      files: {
        '/etc/passwd': { mtime: 12345, imports: [] }, // OUT OF rootDir
        [aFile]: { mtime: validMtime, imports: [] }, // valid
      },
    });

    const buildSpy = vi.spyOn(builderModule, 'buildFullGraph');

    const result = await loadOrBuildGraph(rootDir, cacheDir);

    // Full rebuild NOT triggered — only skip offending entry
    expect(buildSpy).not.toHaveBeenCalled();

    // Valid entry is preserved
    expect(result.forward.has(aFile)).toBe(true);

    // Confined path not in graph
    expect(result.forward.has('/etc/passwd')).toBe(false);
  });

  test('key outside rootDir is skipped; valid entries are preserved (sync)', () => {
    const rootDir = makeTmpDir();
    tempDirs.push(rootDir);
    const cacheDir = path.join(rootDir, '.vitest-affected');

    const aFile = path.join(rootDir, 'src', 'a.ts');
    writeProjectFiles(rootDir, {
      'src/a.ts': 'export const a = 1;\n',
      'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    });

    const validMtime = lstatSync(aFile).mtimeMs;

    writeCacheFile(cacheDir, {
      version: 1,
      builtAt: Date.now(),
      files: {
        '/etc/shadow': { mtime: 9999, imports: [] }, // OUT OF rootDir
        [aFile]: { mtime: validMtime, imports: [] }, // valid
      },
    });

    const buildSyncSpy = vi.spyOn(builderModule, 'buildFullGraphSync');

    const result = loadOrBuildGraphSync(rootDir, cacheDir);

    expect(buildSyncSpy).not.toHaveBeenCalled();
    expect(result.forward.has(aFile)).toBe(true);
    expect(result.forward.has('/etc/shadow')).toBe(false);
  });

  test('all disk.files entries outside rootDir — no rebuild, empty graph returned', async () => {
    const rootDir = makeTmpDir();
    tempDirs.push(rootDir);
    const cacheDir = path.join(rootDir, '.vitest-affected');

    writeProjectFiles(rootDir, {
      'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    });

    writeCacheFile(cacheDir, {
      version: 1,
      builtAt: Date.now(),
      files: {
        '/etc/passwd': { mtime: 12345, imports: [] },
        '/tmp/evil.ts': { mtime: 11111, imports: [] },
      },
    });

    const buildSpy = vi.spyOn(builderModule, 'buildFullGraph');

    const result = await loadOrBuildGraph(rootDir, cacheDir);

    // No full rebuild — skipping entries is not a hard failure
    expect(buildSpy).not.toHaveBeenCalled();
    expect(result.forward.has('/etc/passwd')).toBe(false);
    expect(result.forward.has('/tmp/evil.ts')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Path Confinement — runtimeEdges key outside rootDir is skipped
// ---------------------------------------------------------------------------

describe('bd-sx0: path confinement — runtimeEdges outside rootDir', () => {
  test('runtimeEdges key outside rootDir is skipped, valid ones remain (async)', async () => {
    const rootDir = makeTmpDir();
    tempDirs.push(rootDir);
    const cacheDir = path.join(rootDir, '.vitest-affected');

    const aFile = path.join(rootDir, 'src', 'a.ts');
    const testFile = path.join(rootDir, 'test', 'a.test.ts');
    writeProjectFiles(rootDir, {
      'src/a.ts': 'export const a = 1;\n',
      'test/a.test.ts': 'import { a } from "../src/a";\n',
      'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    });

    const mtimeA = lstatSync(aFile).mtimeMs;
    const mtimeTest = lstatSync(testFile).mtimeMs;

    writeCacheFile(cacheDir, {
      version: 1,
      builtAt: Date.now(),
      files: {
        [aFile]: { mtime: mtimeA, imports: [] },
        [testFile]: { mtime: mtimeTest, imports: [] },
      },
      runtimeEdges: {
        '/etc/passwd': [testFile], // OUT OF rootDir
        [aFile]: [testFile], // valid
      },
    });

    const buildSpy = vi.spyOn(builderModule, 'buildFullGraph');

    const result = await loadOrBuildGraph(rootDir, cacheDir);

    expect(buildSpy).not.toHaveBeenCalled();

    // The valid runtime edge IS in reverse map
    expect(result.reverse.has(aFile)).toBe(true);

    // The out-of-rootDir edge is NOT in reverse map
    expect(result.reverse.has('/etc/passwd')).toBe(false);
  });

  test('runtimeEdges value path outside rootDir is filtered (sync)', () => {
    const rootDir = makeTmpDir();
    tempDirs.push(rootDir);
    const cacheDir = path.join(rootDir, '.vitest-affected');

    const aFile = path.join(rootDir, 'src', 'a.ts');
    const testFile = path.join(rootDir, 'test', 'a.test.ts');
    writeProjectFiles(rootDir, {
      'src/a.ts': 'export const a = 1;\n',
      'test/a.test.ts': 'import { a } from "../src/a";\n',
      'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    });

    const mtimeA = lstatSync(aFile).mtimeMs;
    const mtimeTest = lstatSync(testFile).mtimeMs;

    writeCacheFile(cacheDir, {
      version: 1,
      builtAt: Date.now(),
      files: {
        [aFile]: { mtime: mtimeA, imports: [] },
        [testFile]: { mtime: mtimeTest, imports: [] },
      },
      runtimeEdges: {
        [aFile]: [testFile, '/etc/passwd'], // second value is outside rootDir
      },
    });

    const buildSyncSpy = vi.spyOn(builderModule, 'buildFullGraphSync');

    const result = loadOrBuildGraphSync(rootDir, cacheDir);

    expect(buildSyncSpy).not.toHaveBeenCalled();

    // Valid test path is present
    const reverseSet = result.reverse.get(aFile);
    expect(reverseSet?.has(testFile)).toBe(true);
    // Out-of-rootDir value is NOT in the reverse set
    expect(reverseSet?.has('/etc/passwd')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. Stale Pruning — saveGraphSyncInternal prunes stale runtimeEdges
// ---------------------------------------------------------------------------

describe('bd-sx0: stale runtimeEdges pruning in saveGraphSyncInternal', () => {
  test('key not in forward map is pruned from runtimeEdges on save (explicit edges branch)', () => {
    const rootDir = makeTmpDir();
    tempDirs.push(rootDir);
    const cacheDir = path.join(rootDir, '.vitest-affected');

    const validSrc = path.join(rootDir, 'src', 'valid.ts');
    const staleSrc = path.join(rootDir, 'src', 'stale.ts'); // NOT in forward map
    const testFile = path.join(rootDir, 'test', 'valid.test.ts');

    writeProjectFiles(rootDir, {
      'src/valid.ts': 'export const valid = 1;\n',
      'test/valid.test.ts': 'import { valid } from "../src/valid";\n', // on disk so value is preserved
    });

    // forward only contains validSrc
    const forward = new Map<string, Set<string>>([
      [validSrc, new Set()],
    ]);

    const runtimeEdges = new Map<string, Set<string>>([
      [validSrc, new Set([testFile])], // valid key — in forward; testFile exists on disk
      [staleSrc, new Set([testFile])], // stale key — NOT in forward
    ]);

    saveGraphSyncInternal(forward, cacheDir, undefined, runtimeEdges);

    const raw = readFileSync(path.join(cacheDir, 'graph.json'), 'utf-8');
    const parsed = JSON.parse(raw) as {
      runtimeEdges?: Record<string, string[]>;
    };

    // Stale key should be pruned
    expect(parsed.runtimeEdges).toBeDefined();
    expect(parsed.runtimeEdges![staleSrc]).toBeUndefined();
    // Valid key should remain (testFile exists on disk)
    expect(parsed.runtimeEdges![validSrc]).toEqual([testFile]);
  });

  test('value paths not in forward and not on disk are pruned from runtimeEdges (explicit edges branch)', () => {
    const rootDir = makeTmpDir();
    tempDirs.push(rootDir);
    const cacheDir = path.join(rootDir, '.vitest-affected');

    const srcFile = path.join(rootDir, 'src', 'a.ts');
    const existingTestFile = path.join(rootDir, 'test', 'a.test.ts');
    const nonExistentTestFile = path.join(rootDir, 'test', 'deleted.test.ts'); // not on disk

    writeProjectFiles(rootDir, {
      'src/a.ts': 'export const a = 1;\n',
      'test/a.test.ts': 'import { a } from "../src/a";\n',
    });

    const forward = new Map<string, Set<string>>([
      [srcFile, new Set()],
      [existingTestFile, new Set()], // existingTestFile IS in forward
    ]);

    const runtimeEdges = new Map<string, Set<string>>([
      [srcFile, new Set([existingTestFile, nonExistentTestFile])],
    ]);

    saveGraphSyncInternal(forward, cacheDir, undefined, runtimeEdges);

    const raw = readFileSync(path.join(cacheDir, 'graph.json'), 'utf-8');
    const parsed = JSON.parse(raw) as {
      runtimeEdges?: Record<string, string[]>;
    };

    expect(parsed.runtimeEdges).toBeDefined();
    const values = parsed.runtimeEdges![srcFile];
    expect(values).toContain(existingTestFile);
    // nonExistentTestFile is not in forward AND not on disk → pruned
    expect(values).not.toContain(nonExistentTestFile);
  });

  test('stale key not in forward is pruned in read-merge-write branch (no explicit edges)', () => {
    const rootDir = makeTmpDir();
    tempDirs.push(rootDir);
    const cacheDir = path.join(rootDir, '.vitest-affected');

    const validSrc = path.join(rootDir, 'src', 'valid.ts');
    const staleSrc = '/abs/stale/source.ts'; // will not be in forward map on second save
    const testFile = path.join(rootDir, 'test', 'valid.test.ts');

    writeProjectFiles(rootDir, {
      'src/valid.ts': 'export const valid = 1;\n',
      'test/valid.test.ts': 'import { valid } from "../src/valid";\n', // on disk so value preserved
    });

    // First save: include runtime edges with both valid and stale key
    const forward1 = new Map<string, Set<string>>([
      [validSrc, new Set()],
    ]);
    const initialRuntimeEdges = new Map<string, Set<string>>([
      [validSrc, new Set([testFile])],
      [staleSrc, new Set([testFile])],
    ]);
    saveGraphSyncInternal(forward1, cacheDir, undefined, initialRuntimeEdges);

    // Second save: NO explicit runtime edges — uses read-merge-write
    // forward still has only validSrc
    const forward2 = new Map<string, Set<string>>([
      [validSrc, new Set()],
    ]);
    saveGraphSyncInternal(forward2, cacheDir); // no runtimeEdges arg

    const raw = readFileSync(path.join(cacheDir, 'graph.json'), 'utf-8');
    const parsed = JSON.parse(raw) as {
      runtimeEdges?: Record<string, string[]>;
    };

    // staleSrc should be pruned (not in forward2)
    expect(parsed.runtimeEdges).toBeDefined();
    expect(parsed.runtimeEdges![staleSrc]).toBeUndefined();
    // validSrc should survive (in forward2) with testFile preserved (exists on disk)
    expect(parsed.runtimeEdges![validSrc]).toBeDefined();
  });

  test('reload after save: stale runtime edge key is not in the loaded graph', () => {
    const rootDir = makeTmpDir();
    tempDirs.push(rootDir);
    const cacheDir = path.join(rootDir, '.vitest-affected');

    const validSrc = path.join(rootDir, 'src', 'valid.ts');
    const staleSrc = path.join(rootDir, 'src', 'stale-deleted.ts'); // not in forward, simulating deleted file
    const testFile = path.join(rootDir, 'test', 'valid.test.ts');

    writeProjectFiles(rootDir, {
      'src/valid.ts': 'export const valid = 1;\n',
    });

    // valid src in forward, stale src NOT in forward
    const forward = new Map<string, Set<string>>([
      [validSrc, new Set()],
    ]);
    const mtimes = new Map([[validSrc, lstatSync(validSrc).mtimeMs]]);

    const runtimeEdges = new Map<string, Set<string>>([
      [validSrc, new Set([testFile])],
      [staleSrc, new Set([testFile])], // stale — should be pruned
    ]);

    saveGraphSyncInternal(forward, cacheDir, mtimes, runtimeEdges);

    // Reload: staleSrc must not appear in reverse map
    const { reverse } = loadOrBuildGraphSync(rootDir, cacheDir);

    expect(reverse.has(staleSrc)).toBe(false);
    // validSrc's runtime edge should still be visible (testFile exists on disk or is in forward)
    // Note: testFile does NOT exist on disk and is NOT in forward → it will also be pruned
    // So we just verify staleSrc is gone
  });
});
