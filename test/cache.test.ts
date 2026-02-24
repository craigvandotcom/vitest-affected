import { describe, test, expect, vi, afterEach, beforeEach } from 'vitest';
import path from 'node:path';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { loadOrBuildGraph, saveGraph } from '../src/graph/cache.js';
import * as builder from '../src/graph/builder.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'vitest-cache-test-'));
  return dir;
}

/** Build a tiny in-memory forward graph for a set of file paths. */
function makeForward(entries: [string, string[]][]): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const [k, vs] of entries) {
    m.set(k, new Set(vs));
  }
  return m;
}

/** Derive a reverse graph from a forward graph (same logic as builder). */
function makeReverse(forward: Map<string, Set<string>>): Map<string, Set<string>> {
  const reverse = new Map<string, Set<string>>();
  for (const [file, deps] of forward) {
    if (!reverse.has(file)) reverse.set(file, new Set());
    for (const dep of deps) {
      if (!reverse.has(dep)) reverse.set(dep, new Set());
      reverse.get(dep)!.add(file);
    }
  }
  return reverse;
}

// ---------------------------------------------------------------------------
// Fixtures: write real files on disk so lstat works
// ---------------------------------------------------------------------------

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
// Tests
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

// ── 1. Cache round-trip ────────────────────────────────────────────────────

describe('saveGraph + loadOrBuildGraph round-trip', () => {
  test('save then load returns equivalent forward and reverse maps', async () => {
    const rootDir = makeTmpDir();
    tempDirs.push(rootDir);
    const cacheDir = path.join(rootDir, '.vitest-affected');

    // Write real files so lstat works during loadOrBuildGraph
    const aFile = path.join(rootDir, 'src', 'a.ts');
    const bFile = path.join(rootDir, 'src', 'b.ts');
    writeProjectFiles(rootDir, {
      'src/a.ts': 'import { b } from "./b";\nexport const a = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
      'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    });

    const forward = makeForward([
      [aFile, [bFile]],
      [bFile, []],
    ]);

    // Spy on buildFullGraph to verify it is NOT called on cache hit
    const buildSpy = vi.spyOn(builder, 'buildFullGraph');

    // Save and reload
    await saveGraph(forward, cacheDir);
    const { forward: loadedForward, reverse: loadedReverse } =
      await loadOrBuildGraph(rootDir, cacheDir);

    // buildFullGraph should NOT have been called (cache hit)
    expect(buildSpy).not.toHaveBeenCalled();

    // Forward map keys should match
    expect([...loadedForward.keys()].sort()).toEqual([...forward.keys()].sort());

    // a.ts should still point to b.ts
    expect(loadedForward.get(aFile)?.has(bFile)).toBe(true);

    // Reverse: b.ts should point back to a.ts
    expect(loadedReverse.get(bFile)?.has(aFile)).toBe(true);
  });
});

// ── 2. ENOENT recovery ───────────────────────────────────────────────────

describe('ENOENT recovery', () => {
  test('missing graph.json triggers full rebuild via buildFullGraph', async () => {
    const rootDir = makeTmpDir();
    tempDirs.push(rootDir);
    const cacheDir = path.join(rootDir, '.vitest-affected');
    // Do NOT create cacheDir or graph.json

    writeProjectFiles(rootDir, {
      'src/a.ts': 'export const a = 1;\n',
      'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    });

    const buildSpy = vi.spyOn(builder, 'buildFullGraph');
    // buildFullGraph will be called — let it run for real
    const result = await loadOrBuildGraph(rootDir, cacheDir);

    expect(buildSpy).toHaveBeenCalledOnce();
    expect(result.forward).toBeDefined();
    expect(result.reverse).toBeDefined();
  });
});

// ── 3. Corrupt cache recovery (JSON.parse error) ─────────────────────────

describe('corrupt cache recovery', () => {
  test('truncated JSON triggers full rebuild', async () => {
    const rootDir = makeTmpDir();
    tempDirs.push(rootDir);
    const cacheDir = path.join(rootDir, '.vitest-affected');
    mkdirSync(cacheDir, { recursive: true });
    // Write truncated JSON
    writeFileSync(path.join(cacheDir, 'graph.json'), '{ "version": 1, "files": {', 'utf-8');

    writeProjectFiles(rootDir, {
      'src/a.ts': 'export const a = 1;\n',
      'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    });

    const buildSpy = vi.spyOn(builder, 'buildFullGraph');
    const result = await loadOrBuildGraph(rootDir, cacheDir);

    expect(buildSpy).toHaveBeenCalledOnce();
    expect(result.forward).toBeDefined();
  });
});

// ── 4. Unknown version recovery ──────────────────────────────────────────

describe('unknown version recovery', () => {
  test('version !== 1 triggers full rebuild', async () => {
    const rootDir = makeTmpDir();
    tempDirs.push(rootDir);
    const cacheDir = path.join(rootDir, '.vitest-affected');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      path.join(cacheDir, 'graph.json'),
      JSON.stringify({ version: 99, builtAt: Date.now(), files: {} }),
      'utf-8',
    );

    writeProjectFiles(rootDir, {
      'src/a.ts': 'export const a = 1;\n',
      'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    });

    const buildSpy = vi.spyOn(builder, 'buildFullGraph');
    const result = await loadOrBuildGraph(rootDir, cacheDir);

    expect(buildSpy).toHaveBeenCalledOnce();
    expect(result.forward).toBeDefined();
  });
});

// ── 5. Cache hit with NO mtime changes ───────────────────────────────────

describe('cache hit: no stale files', () => {
  test('buildFullGraph is NOT called when all mtimes are current', async () => {
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

    const forward = makeForward([
      [aFile, [bFile]],
      [bFile, []],
    ]);

    // Save first to create a cache
    await saveGraph(forward, cacheDir);

    const buildSpy = vi.spyOn(builder, 'buildFullGraph');
    const resolveImportsSpy = vi.spyOn(builder, 'resolveFileImports');

    // Load — mtimes should match, no rebuild needed
    const { forward: loaded } = await loadOrBuildGraph(rootDir, cacheDir);

    expect(buildSpy).not.toHaveBeenCalled();
    expect(resolveImportsSpy).not.toHaveBeenCalled();
    expect(loaded.has(aFile)).toBe(true);
    expect(loaded.has(bFile)).toBe(true);
  });
});

// ── 6. Mtime invalidation: stale file reparsed ───────────────────────────

describe('mtime invalidation', () => {
  test('only the stale file is reparsed (resolveFileImports called once per stale file)', async () => {
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

    // Save a forward graph
    const forward = makeForward([
      [aFile, [bFile]],
      [bFile, []],
    ]);
    await saveGraph(forward, cacheDir);

    // Wait a tick then update b.ts to change its mtime
    await new Promise((r) => setTimeout(r, 50));
    writeFileSync(bFile, 'export const b = 99;\n', 'utf-8');

    const buildSpy = vi.spyOn(builder, 'buildFullGraph');
    const resolveImportsSpy = vi
      .spyOn(builder, 'resolveFileImports')
      .mockReturnValue([]); // don't need real resolution

    await loadOrBuildGraph(rootDir, cacheDir);

    // Full rebuild should NOT be called
    expect(buildSpy).not.toHaveBeenCalled();

    // resolveFileImports should be called for the stale file (b.ts) only, not a.ts
    const calledFiles = resolveImportsSpy.mock.calls.map((c) => c[0]);
    expect(calledFiles).toContain(bFile);
    expect(calledFiles).not.toContain(aFile);
  });
});

// ── 7. Orphaned .tmp-* cleanup ───────────────────────────────────────────

describe('orphaned .tmp-* cleanup', () => {
  test('stale .tmp-* files in cacheDir are removed on loadOrBuildGraph', async () => {
    const rootDir = makeTmpDir();
    tempDirs.push(rootDir);
    const cacheDir = path.join(rootDir, '.vitest-affected');
    mkdirSync(cacheDir, { recursive: true });

    // Create an orphaned temp file
    const orphan = path.join(cacheDir, '.tmp-orphan123');
    writeFileSync(orphan, 'garbage', 'utf-8');

    writeProjectFiles(rootDir, {
      'src/a.ts': 'export const a = 1;\n',
      'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    });

    await loadOrBuildGraph(rootDir, cacheDir);

    const remaining = readdirSync(cacheDir);
    expect(remaining.some((f) => f.startsWith('.tmp-'))).toBe(false);
  });
});

// ── 8. Atomic write: temp-then-rename ────────────────────────────────────

describe('atomic write', () => {
  test('saveGraph writes graph.json and no leftover .tmp files', async () => {
    const rootDir = makeTmpDir();
    tempDirs.push(rootDir);
    const cacheDir = path.join(rootDir, '.vitest-affected');

    const aFile = path.join(rootDir, 'src', 'a.ts');
    const bFile = path.join(rootDir, 'src', 'b.ts');
    writeProjectFiles(rootDir, {
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
    });

    const forward = makeForward([
      [aFile, [bFile]],
      [bFile, []],
    ]);
    await saveGraph(forward, cacheDir);

    const files = readdirSync(cacheDir);
    expect(files).toContain('graph.json');
    expect(files.some((f) => f.startsWith('.tmp-'))).toBe(false);
  });

  test('graph.json is valid JSON with version=1', async () => {
    const rootDir = makeTmpDir();
    tempDirs.push(rootDir);
    const cacheDir = path.join(rootDir, '.vitest-affected');

    const aFile = path.join(rootDir, 'src', 'a.ts');
    writeProjectFiles(rootDir, {
      'src/a.ts': 'export const a = 1;\n',
    });

    const forward = makeForward([[aFile, []]]);
    await saveGraph(forward, cacheDir);

    const raw = readFileSync(path.join(cacheDir, 'graph.json'), 'utf-8');
    const parsed = JSON.parse(raw) as {
      version: number;
      builtAt: number;
      files: Record<string, { mtime: number; imports: string[] }>;
    };
    expect(parsed.version).toBe(1);
    expect(typeof parsed.builtAt).toBe('number');
    expect(parsed.files[aFile]).toBeDefined();
    expect(Array.isArray(parsed.files[aFile]!.imports)).toBe(true);
  });
});

// ── 9. Deleted file handling: removed from cache on reload ───────────────

describe('deleted file handling', () => {
  test('file deleted between runs is not included in loaded graph', async () => {
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

    const forward = makeForward([
      [aFile, [bFile]],
      [bFile, []],
    ]);
    await saveGraph(forward, cacheDir);

    // Delete b.ts
    rmSync(bFile);

    const { forward: loaded } = await loadOrBuildGraph(rootDir, cacheDir);

    // b.ts (deleted) should not be in forward map
    expect(loaded.has(bFile)).toBe(false);
  });
});
