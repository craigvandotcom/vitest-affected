import { describe, test, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolveFileImports, createResolver, deltaParseNewImports } from '../src/graph/builder.js';

const fixtureDir = (name: string) => path.resolve(import.meta.dirname, 'fixtures', name);

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  tempDirs.length = 0;
});

describe('createResolver', () => {
  test('returns a working resolver instance', () => {
    const resolver = createResolver(fixtureDir('simple'));
    expect(resolver).toBeDefined();
  });

  test('resolves known paths within fixture', () => {
    const simpleDir = fixtureDir('simple');
    const resolver = createResolver(simpleDir);
    const result = resolver.sync(path.join(simpleDir, 'src'), './a');
    expect(result.error).toBeUndefined();
    expect(result.path).toBeDefined();
    expect(result.path!.endsWith('a.ts')).toBe(true);
  });

  test('warns when tsconfig.json is absent', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const noTsconfigDir = mkdtempSync(path.join(tmpdir(), 'vitest-affected-no-tsconfig-'));
    tempDirs.push(noTsconfigDir);
    createResolver(noTsconfigDir);
    expect(warnSpy).toHaveBeenCalledWith(
      '[vitest-affected] No tsconfig.json found — path aliases will not resolve'
    );
    warnSpy.mockRestore();
  });
});

describe('resolveFileImports', () => {
  test('returns resolved paths for static imports', () => {
    const simpleDir = fixtureDir('simple');
    const resolver = createResolver(simpleDir);
    const aFile = path.join(simpleDir, 'src', 'a.ts');
    const source = `import { b } from './b';\nexport const a = b + 1;\n`;
    const results = resolveFileImports(aFile, source, simpleDir, resolver);
    expect(results).toHaveLength(1);
    expect(results[0].endsWith('b.ts')).toBe(true);
  });

  test('type-only imports are NOT in graph edges', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'vitest-affected-test-'));
    tempDirs.push(tmpDir);
    const fooFile = path.join(tmpDir, 'foo.ts');
    const barFile = path.join(tmpDir, 'bar.ts');
    writeFileSync(fooFile, 'export type Foo = { x: number };\n');
    writeFileSync(barFile, "import type { Foo } from './foo';\nexport const bar: Foo = { x: 1 };\n");

    // Use a resolver that can handle this temp dir
    const tmpResolver = createResolver(tmpDir);
    const results = resolveFileImports(barFile, "import type { Foo } from './foo';\nexport const bar = 1;\n", tmpDir, tmpResolver);
    expect(results).toHaveLength(0);
  });

  test('binary asset imports are not in graph edges', () => {
    const simpleDir = fixtureDir('simple');
    const resolver = createResolver(simpleDir);
    const aFile = path.join(simpleDir, 'src', 'a.ts');
    const source = `import logo from './logo.svg';\nimport img from './photo.png';\nexport const a = 1;\n`;
    const results = resolveFileImports(aFile, source, simpleDir, resolver);
    expect(results).toHaveLength(0);
  });

  test('.js extension imports resolve to .ts files (ESM convention)', () => {
    const simpleDir = fixtureDir('simple');
    const resolver = createResolver(simpleDir);
    const aFile = path.join(simpleDir, 'src', 'a.ts');
    // ESM TypeScript convention: import with .js extension, resolver maps to .ts
    const source = `import { b } from './b.js';\nexport const a = b + 1;\n`;
    const results = resolveFileImports(aFile, source, simpleDir, resolver);
    expect(results).toHaveLength(1);
    expect(results[0].endsWith('b.ts')).toBe(true);
  });

  test('backtick dynamic import (no expressions) is included in graph', () => {
    const simpleDir = fixtureDir('simple');
    const resolver = createResolver(simpleDir);
    const aFile = path.join(simpleDir, 'src', 'a.ts');
    // Backtick with no template expressions - should be treated as static string
    const source = 'const mod = import(`./b`);\nexport const a = 1;\n';
    const results = resolveFileImports(aFile, source, simpleDir, resolver);
    expect(results).toHaveLength(1);
    expect(results[0].endsWith('b.ts')).toBe(true);
  });
});

describe('builder.ts bug fixes', () => {
  test('path boundary rejects sibling directories with shared prefix', () => {
    // Create two sibling dirs: /tmp/foo and /tmp/foo-bar
    const base = mkdtempSync(path.join(tmpdir(), 'vitest-affected-boundary-'));
    tempDirs.push(base);
    const projectDir = path.join(base, 'myproject');
    const siblingDir = path.join(base, 'myproject-other');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(path.join(projectDir, 'src'), { recursive: true });
    mkdirSync(siblingDir, { recursive: true });
    mkdirSync(path.join(siblingDir, 'src'), { recursive: true });

    // Create source files
    writeFileSync(path.join(projectDir, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(path.join(siblingDir, 'src', 'b.ts'), 'export const b = 1;\n');

    // resolveFileImports should NOT include sibling dir file when rootDir is projectDir
    const resolver = createResolver(projectDir);
    const source = `import { b } from '${path.join(siblingDir, 'src', 'b')}';\n`;
    const results = resolveFileImports(
      path.join(projectDir, 'src', 'a.ts'),
      source,
      projectDir,
      resolver,
    );
    // The sibling file should be excluded by the path boundary check
    expect(results.every(r => r.startsWith(projectDir + path.sep))).toBe(true);
  });

  test('parse errors are logged with console.warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const simpleDir = fixtureDir('simple');
    const resolver = createResolver(simpleDir);

    // Feed malformed source to trigger parse errors
    const malformed = 'import { from;\nexport const x = {\n';
    resolveFileImports(
      path.join(simpleDir, 'src', 'a.ts'),
      malformed,
      simpleDir,
      resolver,
    );

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[vitest-affected] Parse errors in')
    );
    warnSpy.mockRestore();
  });

});

describe('deltaParseNewImports', () => {
  test('returns empty array when all imports are already in cachedReverse', () => {
    const simpleDir = fixtureDir('simple');
    const aFile = path.join(simpleDir, 'src', 'a.ts');
    const bFile = path.join(simpleDir, 'src', 'b.ts');

    // cachedReverse already knows about b.ts
    const cachedReverse = new Map<string, Set<string>>();
    cachedReverse.set(bFile, new Set([aFile]));

    const newTargets = deltaParseNewImports([aFile], cachedReverse, simpleDir);
    expect(newTargets).toEqual([]);
  });

  test('returns new import targets not in cachedReverse', () => {
    const simpleDir = fixtureDir('simple');
    const aFile = path.join(simpleDir, 'src', 'a.ts');

    // cachedReverse is empty — b.ts is "new"
    const cachedReverse = new Map<string, Set<string>>();

    const newTargets = deltaParseNewImports([aFile], cachedReverse, simpleDir);
    expect(newTargets.length).toBeGreaterThan(0);
    expect(newTargets.some(t => t.endsWith('b.ts'))).toBe(true);
  });

  test('skips files that cannot be read', () => {
    const simpleDir = fixtureDir('simple');
    const nonexistent = path.join(simpleDir, 'src', 'does-not-exist.ts');
    const cachedReverse = new Map<string, Set<string>>();

    const newTargets = deltaParseNewImports([nonexistent], cachedReverse, simpleDir);
    expect(newTargets).toEqual([]);
  });

  test('handles multiple changed files', () => {
    const simpleDir = fixtureDir('simple');
    const aFile = path.join(simpleDir, 'src', 'a.ts');
    const bFile = path.join(simpleDir, 'src', 'b.ts');

    // cachedReverse is empty
    const cachedReverse = new Map<string, Set<string>>();

    const newTargets = deltaParseNewImports([aFile, bFile], cachedReverse, simpleDir);
    // a.ts imports b.ts, b.ts imports c.ts — both should be new
    expect(newTargets.some(t => t.endsWith('b.ts'))).toBe(true);
    expect(newTargets.some(t => t.endsWith('c.ts'))).toBe(true);
  });

  test('verbose mode logs new targets', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const simpleDir = fixtureDir('simple');
    const aFile = path.join(simpleDir, 'src', 'a.ts');
    const cachedReverse = new Map<string, Set<string>>();

    deltaParseNewImports([aFile], cachedReverse, simpleDir, true);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[vitest-affected] Delta parse: new import target')
    );
    warnSpy.mockRestore();
  });
});
