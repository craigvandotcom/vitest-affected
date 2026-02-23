import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { buildFullGraph, resolveFileImports, createResolver } from '../src/graph/builder.js';

const fixtureDir = (name: string) => path.resolve(import.meta.dirname, 'fixtures', name);

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
    const simpleDir = fixtureDir('simple');
    const resolver = createResolver(simpleDir);

    const tmpDir = mkdtempSync(path.join(tmpdir(), 'vitest-affected-test-'));
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

describe('buildFullGraph - simple fixture (A→B→C)', () => {
  test('forward map has entries for all source files and test file', async () => {
    const simpleDir = fixtureDir('simple');
    const { forward } = await buildFullGraph(simpleDir);

    const keys = Array.from(forward.keys());
    const aTs = keys.find(k => k.endsWith('src/a.ts'));
    const bTs = keys.find(k => k.endsWith('src/b.ts'));
    const cTs = keys.find(k => k.endsWith('src/c.ts'));
    const testA = keys.find(k => k.endsWith('tests/a.test.ts'));

    expect(aTs).toBeDefined();
    expect(bTs).toBeDefined();
    expect(cTs).toBeDefined();
    expect(testA).toBeDefined();
  });

  test('a.ts → {b.ts}', async () => {
    const simpleDir = fixtureDir('simple');
    const { forward } = await buildFullGraph(simpleDir);

    const keys = Array.from(forward.keys());
    const aTs = keys.find(k => k.endsWith('src/a.ts'))!;
    const bTs = keys.find(k => k.endsWith('src/b.ts'))!;

    expect(forward.get(aTs)).toBeDefined();
    const aDeps = forward.get(aTs)!;
    expect(aDeps.has(bTs)).toBe(true);
    expect(aDeps.size).toBe(1);
  });

  test('b.ts → {c.ts}', async () => {
    const simpleDir = fixtureDir('simple');
    const { forward } = await buildFullGraph(simpleDir);

    const keys = Array.from(forward.keys());
    const bTs = keys.find(k => k.endsWith('src/b.ts'))!;
    const cTs = keys.find(k => k.endsWith('src/c.ts'))!;

    const bDeps = forward.get(bTs)!;
    expect(bDeps.has(cTs)).toBe(true);
    expect(bDeps.size).toBe(1);
  });

  test('c.ts → {} (empty set)', async () => {
    const simpleDir = fixtureDir('simple');
    const { forward } = await buildFullGraph(simpleDir);

    const keys = Array.from(forward.keys());
    const cTs = keys.find(k => k.endsWith('src/c.ts'))!;

    const cDeps = forward.get(cTs)!;
    expect(cDeps.size).toBe(0);
  });

  test('tests/a.test.ts → {a.ts}', async () => {
    const simpleDir = fixtureDir('simple');
    const { forward } = await buildFullGraph(simpleDir);

    const keys = Array.from(forward.keys());
    const aTs = keys.find(k => k.endsWith('src/a.ts'))!;
    const testA = keys.find(k => k.endsWith('tests/a.test.ts'))!;

    const testDeps = forward.get(testA)!;
    expect(testDeps.has(aTs)).toBe(true);
  });

  test('reverse: c.ts → {b.ts}', async () => {
    const simpleDir = fixtureDir('simple');
    const { reverse } = await buildFullGraph(simpleDir);

    const keys = Array.from(reverse.keys());
    const bTs = keys.find(k => k.endsWith('src/b.ts'))!;
    const cTs = keys.find(k => k.endsWith('src/c.ts'))!;

    expect(reverse.get(cTs)).toBeDefined();
    expect(reverse.get(cTs)!.has(bTs)).toBe(true);
  });

  test('reverse: b.ts → {a.ts}', async () => {
    const simpleDir = fixtureDir('simple');
    const { reverse } = await buildFullGraph(simpleDir);

    const keys = Array.from(reverse.keys());
    const aTs = keys.find(k => k.endsWith('src/a.ts'))!;
    const bTs = keys.find(k => k.endsWith('src/b.ts'))!;

    expect(reverse.get(bTs)!.has(aTs)).toBe(true);
  });

  test('reverse: a.ts → {tests/a.test.ts}', async () => {
    const simpleDir = fixtureDir('simple');
    const { reverse } = await buildFullGraph(simpleDir);

    const keys = Array.from(reverse.keys());
    const aTs = keys.find(k => k.endsWith('src/a.ts'))!;
    const testA = keys.find(k => k.endsWith('tests/a.test.ts'))!;

    expect(reverse.get(aTs)!.has(testA)).toBe(true);
  });
});

describe('buildFullGraph - diamond fixture (A→B→C, A→D→C)', () => {
  test('reverse of c.ts includes both b.ts and d.ts', async () => {
    const diamondDir = fixtureDir('diamond');
    const { reverse } = await buildFullGraph(diamondDir);

    const keys = Array.from(reverse.keys());
    const bTs = keys.find(k => k.endsWith('src/b.ts'))!;
    const cTs = keys.find(k => k.endsWith('src/c.ts'))!;
    const dTs = keys.find(k => k.endsWith('src/d.ts'))!;

    expect(bTs).toBeDefined();
    expect(cTs).toBeDefined();
    expect(dTs).toBeDefined();

    const cReverse = reverse.get(cTs)!;
    expect(cReverse.has(bTs)).toBe(true);
    expect(cReverse.has(dTs)).toBe(true);
  });

  test('forward map includes all diamond nodes', async () => {
    const diamondDir = fixtureDir('diamond');
    const { forward } = await buildFullGraph(diamondDir);

    const keys = Array.from(forward.keys());
    expect(keys.some(k => k.endsWith('src/a.ts'))).toBe(true);
    expect(keys.some(k => k.endsWith('src/b.ts'))).toBe(true);
    expect(keys.some(k => k.endsWith('src/c.ts'))).toBe(true);
    expect(keys.some(k => k.endsWith('src/d.ts'))).toBe(true);
  });
});

describe('buildFullGraph - circular fixture (A→B→A)', () => {
  test('terminates without infinite loop', async () => {
    const circularDir = fixtureDir('circular');
    // Should resolve without hanging
    const result = await buildFullGraph(circularDir);
    expect(result).toBeDefined();
    expect(result.forward).toBeDefined();
    expect(result.reverse).toBeDefined();
  });

  test('both files appear in the graph', async () => {
    const circularDir = fixtureDir('circular');
    const { forward } = await buildFullGraph(circularDir);

    const keys = Array.from(forward.keys());
    expect(keys.some(k => k.endsWith('src/a.ts'))).toBe(true);
    expect(keys.some(k => k.endsWith('src/b.ts'))).toBe(true);
  });
});
