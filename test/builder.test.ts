import { describe, test, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import { writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolveFileImports, createResolver, deltaParseNewImports } from '../src/graph/builder.js';
import { cleanupTempDirs } from './_helpers.js';

const fixtureDir = (name: string) => path.resolve(import.meta.dirname, 'fixtures', name);

const tempDirs: string[] = [];

afterEach(() => {
  cleanupTempDirs(tempDirs);
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

  test('bare .css import (no query suffix) is still excluded as binary', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'vitest-affected-bare-css-'));
    tempDirs.push(tmpDir);
    const entryFile = path.join(tmpDir, 'entry.ts');
    const source = `import './x.css';\nexport const a = 1;\n`;
    writeFileSync(entryFile, source);
    writeFileSync(path.join(tmpDir, 'x.css'), 'body { color: red; }\n');

    const resolver = createResolver(tmpDir);
    const results = resolveFileImports(entryFile, source, tmpDir, resolver);
    expect(results).toHaveLength(0);
  });

  test('query-suffixed specifiers (?raw, ?url) resolve to the real on-disk files, bypassing binary exclusion', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'vitest-affected-query-suffix-'));
    tempDirs.push(tmpDir);
    const entryFile = path.join(tmpDir, 'entry.ts');
    const cssFile = path.join(tmpDir, 'x.css');
    const tsFile = path.join(tmpDir, 'y.ts');
    const source = `import css from './x.css?raw';\nimport url from './y.ts?url';\nexport const a = 1;\n`;
    writeFileSync(entryFile, source);
    writeFileSync(cssFile, 'body { color: red; }\n');
    writeFileSync(tsFile, 'export const y = 1;\n');

    const resolver = createResolver(tmpDir);
    const results = resolveFileImports(entryFile, source, tmpDir, resolver);
    // '.css?raw' must resolve to the real x.css file — binary exclusion is
    // bypassed because the query suffix marks it as a genuine Vite module
    // import, and the query is stripped before resolution so oxc-resolver
    // can find the file on disk.
    expect(results.some(r => r.endsWith('x.css'))).toBe(true);
    // '.ts?url' must resolve to the real y.ts file — the query is stripped
    // before resolution (oxc-resolver cannot resolve a suffixed specifier).
    expect(results.some(r => r.endsWith('y.ts'))).toBe(true);
    expect(results).toHaveLength(2);
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

describe('resolve.alias plumbing (T2a)', () => {
  test('aliased specifier (string find) resolves to the stub path in delta-parse', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'vitest-affected-alias-string-'));
    tempDirs.push(tmpDir);
    const entryFile = path.join(tmpDir, 'entry.ts');
    const stubFile = path.join(tmpDir, 'stub-foo.ts');
    writeFileSync(entryFile, `import { thing } from '@stub/foo';\nexport const x = thing;\n`);
    writeFileSync(stubFile, 'export const thing = 1;\n');

    const cachedReverse = new Map<string, Set<string>>();
    const aliasEntries = [{ find: '@stub/foo', replacement: stubFile }];

    const newTargets = deltaParseNewImports(
      [entryFile],
      cachedReverse,
      tmpDir,
      false,
      aliasEntries,
    );
    expect(newTargets).toHaveLength(1);
    expect(newTargets[0].endsWith('stub-foo.ts')).toBe(true);
  });

  test('RegExp find is skipped with a startup warning; unaliased resolution still works', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'vitest-affected-alias-regexp-'));
    tempDirs.push(tmpDir);
    const entryFile = path.join(tmpDir, 'entry.ts');
    const bFile = path.join(tmpDir, 'b.ts');
    writeFileSync(entryFile, `import { b } from './b';\nexport const x = b;\n`);
    writeFileSync(bFile, 'export const b = 1;\n');

    const cachedReverse = new Map<string, Set<string>>();
    const aliasEntries = [
      { find: /^@bar\/(.*)$/, replacement: path.join(tmpDir, 'bar-$1.ts') },
    ];

    const newTargets = deltaParseNewImports(
      [entryFile],
      cachedReverse,
      tmpDir,
      false,
      aliasEntries,
    );

    // RegExp find skipped — documented via startup warning, not converted.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'resolve.alias has 1 RegExp find(s) that cannot be fed into the static delta-parser resolver',
      ),
    );
    // Unaliased relative-import resolution is otherwise intact.
    expect(newTargets).toHaveLength(1);
    expect(newTargets[0].endsWith('b.ts')).toBe(true);
    warnSpy.mockRestore();
  });

  test("Vite's built-in RegExp aliases (@vite/env, @vite/client) do not trigger the warning", () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'vitest-affected-alias-builtin-'));
    tempDirs.push(tmpDir);
    const entryFile = path.join(tmpDir, 'entry.ts');
    writeFileSync(entryFile, 'export const x = 1;\n');

    // The two aliases Vite unconditionally injects into every resolved config —
    // dev-client plumbing, irrelevant to selection; they must be silently ignored.
    const aliasEntries = [
      { find: /^\/?@vite\/env/, replacement: path.join(tmpDir, 'node_modules/vite/dist/client/env.mjs') },
      { find: /^\/?@vite\/client/, replacement: path.join(tmpDir, 'node_modules/vite/dist/client/client.mjs') },
    ];

    deltaParseNewImports([entryFile], new Map<string, Set<string>>(), tmpDir, false, aliasEntries);

    const regexpWarnings = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes('RegExp find(s)'),
    );
    expect(regexpWarnings).toHaveLength(0);
    warnSpy.mockRestore();
  });

  test('unaliased behavior is unchanged when no aliasEntries are passed', () => {
    const simpleDir = fixtureDir('simple');
    const aFile = path.join(simpleDir, 'src', 'a.ts');
    const cachedReverse = new Map<string, Set<string>>();

    const newTargets = deltaParseNewImports([aFile], cachedReverse, simpleDir);
    expect(newTargets.length).toBeGreaterThan(0);
    expect(newTargets.some(t => t.endsWith('b.ts'))).toBe(true);
  });
});

describe('new Worker(new URL(...)) extraction (T2b)', () => {
  test('Worker URL specifier yields an import edge in delta-parse', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'vitest-affected-worker-'));
    tempDirs.push(tmpDir);
    const entryFile = path.join(tmpDir, 'entry.ts');
    const workerFile = path.join(tmpDir, 'worker.ts');
    writeFileSync(
      entryFile,
      `const w = new Worker(new URL('./worker.ts', import.meta.url));\nexport const x = w;\n`,
    );
    writeFileSync(workerFile, 'export const handler = () => 1;\n');

    const newTargets = deltaParseNewImports([entryFile], new Map<string, Set<string>>(), tmpDir);
    expect(newTargets.some(t => t.endsWith('worker.ts'))).toBe(true);
  });

  test('SharedWorker URL specifier yields an import edge in delta-parse', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'vitest-affected-sharedworker-'));
    tempDirs.push(tmpDir);
    const entryFile = path.join(tmpDir, 'entry.ts');
    const workerFile = path.join(tmpDir, 'shared-worker.ts');
    writeFileSync(
      entryFile,
      `const w = new SharedWorker(new URL("./shared-worker.ts", import.meta.url));\nexport const x = w;\n`,
    );
    writeFileSync(workerFile, 'export const handler = () => 1;\n');

    const newTargets = deltaParseNewImports([entryFile], new Map<string, Set<string>>(), tmpDir);
    expect(newTargets.some(t => t.endsWith('shared-worker.ts'))).toBe(true);
  });

  test('template-literal / dynamic Worker URL specifier is skipped', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'vitest-affected-worker-template-'));
    tempDirs.push(tmpDir);
    const entryFile = path.join(tmpDir, 'entry.ts');
    writeFileSync(
      entryFile,
      'const name = "worker";\nconst w = new Worker(new URL(`./${name}.ts`, import.meta.url));\nexport const x = w;\n',
    );
    writeFileSync(path.join(tmpDir, 'worker.ts'), 'export const handler = () => 1;\n');

    const newTargets = deltaParseNewImports([entryFile], new Map<string, Set<string>>(), tmpDir);
    expect(newTargets.some(t => t.endsWith('worker.ts'))).toBe(false);
  });

  test('non-URL Worker argument is ignored', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'vitest-affected-worker-nonurl-'));
    tempDirs.push(tmpDir);
    const entryFile = path.join(tmpDir, 'entry.ts');
    writeFileSync(
      entryFile,
      `const w = new Worker('./worker.ts');\nexport const x = w;\n`,
    );
    writeFileSync(path.join(tmpDir, 'worker.ts'), 'export const handler = () => 1;\n');

    const newTargets = deltaParseNewImports([entryFile], new Map<string, Set<string>>(), tmpDir);
    expect(newTargets.some(t => t.endsWith('worker.ts'))).toBe(false);
  });
});
