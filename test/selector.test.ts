import { describe, test, expect } from 'vitest';
import { bfsAffectedTests } from '../src/selector.js';

const isTest = (f: string) => f.includes('.test.');

describe('bfsAffectedTests', () => {
  // 1. Linear chain: A→B→C, change C → finds test at A
  test('linear chain — change leaf finds test at root', () => {
    const reverse = new Map([
      ['/src/c.ts', new Set(['/src/b.ts'])],
      ['/src/b.ts', new Set(['/src/a.ts'])],
      ['/src/a.ts', new Set(['/tests/a.test.ts'])],
    ]);
    expect(bfsAffectedTests(['/src/c.ts'], reverse, isTest)).toEqual(['/tests/a.test.ts']);
  });

  // 2. Diamond dependency: change shared dep → finds both test paths
  test('diamond dependency — finds both test paths', () => {
    const reverse = new Map([
      ['/src/c.ts', new Set(['/src/b.ts', '/src/d.ts'])],
      ['/src/b.ts', new Set(['/tests/b.test.ts'])],
      ['/src/d.ts', new Set(['/tests/d.test.ts'])],
    ]);
    expect(bfsAffectedTests(['/src/c.ts'], reverse, isTest))
      .toEqual(['/tests/b.test.ts', '/tests/d.test.ts']);
  });

  // 3. Circular dependency: A→B→A, terminates without infinite loop
  test('circular dependency — terminates without infinite loop', () => {
    const reverse = new Map([
      ['/src/a.ts', new Set(['/src/b.ts'])],
      ['/src/b.ts', new Set(['/src/a.ts', '/tests/a.test.ts'])],
    ]);
    expect(bfsAffectedTests(['/src/a.ts'], reverse, isTest)).toEqual(['/tests/a.test.ts']);
  });

  // 4. Disjoint graph: changed file has no dependents → empty result
  test('disjoint graph — changed file not in graph returns empty', () => {
    const reverse = new Map([
      ['/src/x.ts', new Set(['/tests/x.test.ts'])],
    ]);
    expect(bfsAffectedTests(['/src/y.ts'], reverse, isTest)).toEqual([]);
  });

  // 5. Changed test file: test file itself is changed → included in output
  test('changed test file is included in output', () => {
    const reverse = new Map<string, Set<string>>();
    expect(bfsAffectedTests(['/tests/a.test.ts'], reverse, isTest)).toEqual(['/tests/a.test.ts']);
  });

  // 6. Multiple changed files: union of affected sets, no duplicates
  test('multiple changed files — union with no duplicates', () => {
    const reverse = new Map([
      ['/src/a.ts', new Set(['/tests/a.test.ts'])],
      ['/src/b.ts', new Set(['/tests/b.test.ts'])],
    ]);
    expect(bfsAffectedTests(['/src/a.ts', '/src/b.ts'], reverse, isTest))
      .toEqual(['/tests/a.test.ts', '/tests/b.test.ts']);
  });

  // 7. Empty input: no changed files → empty result
  test('empty input returns empty result', () => {
    const reverse = new Map([
      ['/src/a.ts', new Set(['/tests/a.test.ts'])],
    ]);
    expect(bfsAffectedTests([], reverse, isTest)).toEqual([]);
  });

  // 8. File not in graph: changed file has no entry in reverse map
  test('file not in graph — no dependents found', () => {
    const reverse = new Map<string, Set<string>>();
    expect(bfsAffectedTests(['/src/orphan.ts'], reverse, isTest)).toEqual([]);
  });

  // 9. Shared test helper propagation (from refinement Round 5)
  test('shared test helper — propagates to dependent test files', () => {
    const reverse = new Map([
      ['/tests/helpers.ts', new Set(['/tests/a.test.ts', '/tests/b.test.ts'])],
    ]);
    const isTestStrict = (f: string) => f.endsWith('.test.ts');
    expect(bfsAffectedTests(['/tests/helpers.ts'], reverse, isTestStrict))
      .toEqual(['/tests/a.test.ts', '/tests/b.test.ts']);
  });
});
