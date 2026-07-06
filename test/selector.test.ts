import { describe, test, expect } from 'vitest';
import { bfsAffectedTests, bfsAffectedTestsWithProvenance } from '../src/selector.js';

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

  // 10. High-fan-in regression: a single node is a dependent of MANY seeds.
  // The enqueue guard must admit it exactly once (was O(E) duplicate enqueues)
  // while keeping selection + first-recorded-trail provenance byte-identical.
  test('high fan-in node — deduped enqueue, first-edge-wins provenance preserved', () => {
    // s1..s50 each have the SAME dependent T (T imports all of them). In the
    // reverse map that is 50 incoming edges into T.
    const seeds = Array.from({ length: 50 }, (_, i) => `/src/s${i}.ts`);
    const reverse = new Map<string, Set<string>>(
      seeds.map((s) => [s, new Set(['/tests/t.test.ts'])]),
    );

    // Selection: T is found exactly once, no duplicates.
    expect(bfsAffectedTests(seeds, reverse, isTest)).toEqual(['/tests/t.test.ts']);

    // Provenance: first seed in encounter order (s0) wins the trail.
    const { tests, provenance } = bfsAffectedTestsWithProvenance(seeds, reverse, isTest);
    expect(tests).toEqual(['/tests/t.test.ts']);
    const trail = provenance.get('/tests/t.test.ts');
    expect(trail).toBeDefined();
    expect(trail!.seed).toBe('/src/s0.ts');
    expect(trail!.chain).toEqual(['/src/s0.ts', '/tests/t.test.ts']);
  });
});
