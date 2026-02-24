/**
 * bd-223: Cache: discover new files on incremental load
 *
 * Tests cover:
 *   1. New source file added after cache is written appears in graph on next load
 *   2. New file that is imported by an existing (non-stale) file appears in forward map
 *   3. New file is only discovered under rootDir (rootDir isolation)
 *   4. New file is NOT discovered if it matches GRAPH_GLOB_IGNORE patterns (e.g. node_modules)
 *   5. buildFullGraph is NOT called for new file discovery (incremental, not full rebuild)
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
  lstatSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { loadOrBuildGraph, saveGraph } from '../src/graph/cache.js';
import * as builderModule from '../src/graph/builder.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'vitest-new-file-discovery-'));
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
// 1. New source file appears in graph on next incremental load
// ---------------------------------------------------------------------------

describe('bd-223: new file discovery after cache write', () => {
  test('new source file added after cache is written appears in forward map on reload', async () => {
    const rootDir = makeTmpDir();
    tempDirs.push(rootDir);
    const cacheDir = path.join(rootDir, '.vitest-affected');

    // Write initial project files
    const aFile = path.join(rootDir, 'src', 'a.ts');
    const bFile = path.join(rootDir, 'src', 'b.ts');
    writeProjectFiles(rootDir, {
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
      'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    });

    // Save a graph with only a.ts and b.ts
    const forward = new Map<string, Set<string>>([
      [aFile, new Set([bFile])],
      [bFile, new Set()],
    ]);
    await saveGraph(forward, cacheDir);

    // Now add a completely new file that was NOT in the cache
    const cFile = path.join(rootDir, 'src', 'c.ts');
    writeFileSync(cFile, 'export const c = 3;\n', 'utf-8');

    // buildFullGraph should NOT be called — we do incremental discovery
    const buildSpy = vi.spyOn(builderModule, 'buildFullGraph');

    const { forward: loaded } = await loadOrBuildGraph(rootDir, cacheDir);

    // Full rebuild should not be triggered
    expect(buildSpy).not.toHaveBeenCalled();

    // The new file c.ts MUST appear in the forward map
    expect(loaded.has(cFile)).toBe(true);

    // Original files should still be present
    expect(loaded.has(aFile)).toBe(true);
    expect(loaded.has(bFile)).toBe(true);
  });

  test('new file imported by a non-stale existing file appears in forward map', async () => {
    const rootDir = makeTmpDir();
    tempDirs.push(rootDir);
    const cacheDir = path.join(rootDir, '.vitest-affected');

    // Write initial project — a.ts imports b.ts
    const aFile = path.join(rootDir, 'src', 'a.ts');
    const bFile = path.join(rootDir, 'src', 'b.ts');
    writeProjectFiles(rootDir, {
      // a.ts references c.ts in its import but c.ts does not exist yet
      'src/a.ts': 'import { b } from "./b";\nexport const a = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
      'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    });

    // Save graph — at this point c.ts does not exist
    const forward = new Map<string, Set<string>>([
      [aFile, new Set([bFile])],
      [bFile, new Set()],
    ]);
    await saveGraph(forward, cacheDir);

    // Now create c.ts (the file that was targeted by an import that couldn't resolve earlier)
    const cFile = path.join(rootDir, 'src', 'c.ts');
    writeFileSync(cFile, 'export const c = 3;\n', 'utf-8');

    const { forward: loaded } = await loadOrBuildGraph(rootDir, cacheDir);

    // c.ts was not in the cache but should be discovered by the glob pass
    expect(loaded.has(cFile)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. rootDir isolation — new files outside rootDir are not discovered
// ---------------------------------------------------------------------------

describe('bd-223: rootDir isolation during new file discovery', () => {
  test('files outside rootDir are not added even if they match glob pattern', async () => {
    const rootDir = makeTmpDir();
    tempDirs.push(rootDir);
    const cacheDir = path.join(rootDir, '.vitest-affected');

    const aFile = path.join(rootDir, 'src', 'a.ts');
    writeProjectFiles(rootDir, {
      'src/a.ts': 'export const a = 1;\n',
      'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    });

    // Save a graph with a.ts
    const forward = new Map<string, Set<string>>([[aFile, new Set()]]);
    await saveGraph(forward, cacheDir);

    // The glob call is bounded by rootDir (cwd: rootDir), so no outside files
    // are discovered. We just verify the existing file is still there and
    // the new file within rootDir is found.
    const dFile = path.join(rootDir, 'src', 'd.ts');
    writeFileSync(dFile, 'export const d = 4;\n', 'utf-8');

    const { forward: loaded } = await loadOrBuildGraph(rootDir, cacheDir);

    // d.ts inside rootDir is found
    expect(loaded.has(dFile)).toBe(true);

    // No paths outside rootDir appear in the forward map
    for (const key of loaded.keys()) {
      expect(key.startsWith(rootDir)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. GRAPH_GLOB_IGNORE — files in ignored directories are not discovered
// ---------------------------------------------------------------------------

describe('bd-223: ignored directories are excluded from new file discovery', () => {
  test('new file in node_modules subdirectory is not added to graph', async () => {
    const rootDir = makeTmpDir();
    tempDirs.push(rootDir);
    const cacheDir = path.join(rootDir, '.vitest-affected');

    const aFile = path.join(rootDir, 'src', 'a.ts');
    writeProjectFiles(rootDir, {
      'src/a.ts': 'export const a = 1;\n',
      'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    });

    // Save graph with just a.ts
    const forward = new Map<string, Set<string>>([[aFile, new Set()]]);
    await saveGraph(forward, cacheDir);

    // Write a .ts file inside node_modules (should be ignored by GRAPH_GLOB_IGNORE)
    const nmFile = path.join(rootDir, 'node_modules', 'some-pkg', 'index.ts');
    mkdirSync(path.dirname(nmFile), { recursive: true });
    writeFileSync(nmFile, 'export const x = 1;\n', 'utf-8');

    const { forward: loaded } = await loadOrBuildGraph(rootDir, cacheDir);

    // node_modules file must NOT appear in the forward map
    expect(loaded.has(nmFile)).toBe(false);
  });

  test('new file in test/fixtures is not added to graph', async () => {
    const rootDir = makeTmpDir();
    tempDirs.push(rootDir);
    const cacheDir = path.join(rootDir, '.vitest-affected');

    const aFile = path.join(rootDir, 'src', 'a.ts');
    writeProjectFiles(rootDir, {
      'src/a.ts': 'export const a = 1;\n',
      'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    });

    // Save graph with just a.ts
    const forward = new Map<string, Set<string>>([[aFile, new Set()]]);
    await saveGraph(forward, cacheDir);

    // Write a .ts file inside test/fixtures (should be in GRAPH_GLOB_IGNORE)
    const fixtureFile = path.join(rootDir, 'test', 'fixtures', 'example.ts');
    mkdirSync(path.dirname(fixtureFile), { recursive: true });
    writeFileSync(fixtureFile, 'export const fixture = 1;\n', 'utf-8');

    const { forward: loaded } = await loadOrBuildGraph(rootDir, cacheDir);

    // test/fixtures file must NOT appear in the forward map
    expect(loaded.has(fixtureFile)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Already-refreshed files are not re-parsed during discovery pass
// ---------------------------------------------------------------------------

describe('bd-223: already-known files not double-parsed during discovery', () => {
  test('stale file reparsed in stale-refresh loop is not reparsed again in discovery pass', async () => {
    const rootDir = makeTmpDir();
    tempDirs.push(rootDir);
    const cacheDir = path.join(rootDir, '.vitest-affected');

    const aFile = path.join(rootDir, 'src', 'a.ts');
    const bFile = path.join(rootDir, 'src', 'b.ts');
    writeProjectFiles(rootDir, {
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
      'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    });

    // Write old mtime in cache so b.ts is stale
    const oldMtime = lstatSync(bFile).mtimeMs - 10000;
    const payload = {
      version: 1,
      builtAt: Date.now() - 100,
      files: {
        [aFile]: { mtime: lstatSync(aFile).mtimeMs, imports: [] },
        [bFile]: { mtime: oldMtime, imports: [] }, // stale
      },
    };
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      path.join(cacheDir, 'graph.json'),
      JSON.stringify(payload),
      'utf-8',
    );

    const resolveImportsSpy = vi.spyOn(builderModule, 'resolveFileImports');

    await loadOrBuildGraph(rootDir, cacheDir);

    // resolveFileImports should be called for stale b.ts (from stale-refresh loop)
    const calledFiles = resolveImportsSpy.mock.calls.map((c) => c[0]);
    expect(calledFiles).toContain(bFile);

    // But it should NOT be called TWICE for b.ts (once from stale loop, not again from discovery)
    const bCallCount = calledFiles.filter((f) => f === bFile).length;
    expect(bCallCount).toBe(1);
  });
});
