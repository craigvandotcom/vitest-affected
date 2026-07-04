/// <reference types="vitest/config" />
import { describe, test, expect } from 'vitest';
import type { TestModule } from 'vitest/node';
import type { TestRunEndReason } from 'vitest/reporters';
import { createRuntimeReporter } from '../src/plugin.js';
import { mergeRuntimeEdges, type ReverseMap } from '../src/runtime-merge.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockTestModule(
  moduleId: string,
  importDurations: Record<string, { selfTime: number; totalTime: number }>,
): TestModule {
  return {
    moduleId,
    diagnostic: () => ({ importDurations }),
  } as unknown as TestModule;
}

// ---------------------------------------------------------------------------
// createRuntimeReporter
// ---------------------------------------------------------------------------

describe('createRuntimeReporter', () => {
  test('collects edges from mock TestModule and calls onEdgesCollected on run end', () => {
    const collected: Map<string, Set<string>>[] = [];
    const { reporter, setRootDir } = createRuntimeReporter((edges) => {
      collected.push(new Map(edges));
    });

    setRootDir('/project');

    const testPath = '/project/tests/a.test.ts';
    const depPath = '/project/src/a.ts';
    const mod = createMockTestModule(testPath, {
      [depPath]: { selfTime: 1, totalTime: 2 },
    });

    reporter.onTestModuleEnd!(mod);
    reporter.onTestRunEnd!(
      [],
      [],
      'passed' as TestRunEndReason,
    );

    expect(collected).toHaveLength(1);
    const edges = collected[0];
    expect(edges.get(depPath)).toEqual(new Set([testPath]));
  });

  test('filters out node_modules deps', () => {
    const collected: Map<string, Set<string>>[] = [];
    const { reporter, setRootDir } = createRuntimeReporter((edges) => {
      collected.push(new Map(edges));
    });

    setRootDir('/project');

    const testPath = '/project/tests/a.test.ts';
    const mod = createMockTestModule(testPath, {
      '/project/node_modules/lodash/index.js': { selfTime: 1, totalTime: 2 },
      '/project/src/a.ts': { selfTime: 1, totalTime: 2 },
    });

    reporter.onTestModuleEnd!(mod);
    reporter.onTestRunEnd!([], [], 'passed' as TestRunEndReason);

    expect(collected).toHaveLength(1);
    const edges = collected[0];
    // node_modules should NOT appear
    expect(edges.has('/project/node_modules/lodash/index.js')).toBe(false);
    // project source should appear
    expect(edges.has('/project/src/a.ts')).toBe(true);
  });

  test('filters out self-reference (testPath === depPath)', () => {
    const collected: Map<string, Set<string>>[] = [];
    const { reporter, setRootDir } = createRuntimeReporter((edges) => {
      collected.push(new Map(edges));
    });

    setRootDir('/project');

    const testPath = '/project/tests/a.test.ts';
    const mod = createMockTestModule(testPath, {
      [testPath]: { selfTime: 1, totalTime: 2 }, // self-reference
      '/project/src/a.ts': { selfTime: 1, totalTime: 2 },
    });

    reporter.onTestModuleEnd!(mod);
    reporter.onTestRunEnd!([], [], 'passed' as TestRunEndReason);

    expect(collected).toHaveLength(1);
    const edges = collected[0];
    expect(edges.has(testPath)).toBe(false);
    expect(edges.has('/project/src/a.ts')).toBe(true);
  });

  test('skips collection when rootDir not set (no callback called)', () => {
    const collected: Map<string, Set<string>>[] = [];
    const { reporter } = createRuntimeReporter((edges) => {
      collected.push(new Map(edges));
    });

    // Do NOT call setRootDir

    const testPath = '/project/tests/a.test.ts';
    const mod = createMockTestModule(testPath, {
      '/project/src/a.ts': { selfTime: 1, totalTime: 2 },
    });

    reporter.onTestModuleEnd!(mod);
    reporter.onTestRunEnd!([], [], 'passed' as TestRunEndReason);

    // onEdgesCollected should NOT be called because rootDir was never set
    expect(collected).toHaveLength(0);
  });

  test('interrupt skips callback and clear', () => {
    let callCount = 0;
    const { reporter, setRootDir } = createRuntimeReporter(() => {
      callCount++;
    });

    setRootDir('/project');

    const testPath = '/project/tests/a.test.ts';
    const mod = createMockTestModule(testPath, {
      '/project/src/a.ts': { selfTime: 1, totalTime: 2 },
    });

    reporter.onTestModuleEnd!(mod);
    // Interrupt — should skip callback
    reporter.onTestRunEnd!([], [], 'interrupted' as TestRunEndReason);

    expect(callCount).toBe(0);

    // Now do a normal run end — edges should still be present (not cleared by interrupt)
    reporter.onTestRunEnd!([], [], 'passed' as TestRunEndReason);
    expect(callCount).toBe(1);
  });

  test('filters out deps outside rootDir prefix', () => {
    const collected: Map<string, Set<string>>[] = [];
    const { reporter, setRootDir } = createRuntimeReporter((edges) => {
      collected.push(new Map(edges));
    });

    setRootDir('/project');

    const testPath = '/project/tests/a.test.ts';
    const mod = createMockTestModule(testPath, {
      '/other-project/src/a.ts': { selfTime: 1, totalTime: 2 }, // outside rootDir
      '/project/src/b.ts': { selfTime: 1, totalTime: 2 },       // inside rootDir
    });

    reporter.onTestModuleEnd!(mod);
    reporter.onTestRunEnd!([], [], 'passed' as TestRunEndReason);

    expect(collected).toHaveLength(1);
    const edges = collected[0];
    expect(edges.has('/other-project/src/a.ts')).toBe(false);
    expect(edges.has('/project/src/b.ts')).toBe(true);
  });

  test('filters out non-absolute module IDs (virtual modules)', () => {
    const collected: Map<string, Set<string>>[] = [];
    const { reporter, setRootDir } = createRuntimeReporter((edges) => {
      collected.push(new Map(edges));
    });

    setRootDir('/project');

    // Virtual module ID (does not start with /)
    const testPath = 'virtual:test-module';
    const mod = createMockTestModule(testPath, {
      '/project/src/a.ts': { selfTime: 1, totalTime: 2 },
    });

    reporter.onTestModuleEnd!(mod);
    reporter.onTestRunEnd!([], [], 'passed' as TestRunEndReason);

    // rootDir is set but testPath doesn't start with '/' — guard fires, no edges
    expect(collected).toHaveLength(0);
  });

  test('does not call onEdgesCollected when no edges collected', () => {
    const collected: Map<string, Set<string>>[] = [];
    const { reporter, setRootDir } = createRuntimeReporter((edges) => {
      collected.push(new Map(edges));
    });

    setRootDir('/project');

    // No onTestModuleEnd calls — empty runtimeReverse
    reporter.onTestRunEnd!([], [], 'passed' as TestRunEndReason);

    // Empty map — should NOT call onEdgesCollected
    expect(collected).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// mergeRuntimeEdges
// ---------------------------------------------------------------------------

/** Build a ReverseMap from a plain source→tests object literal. */
function rmap(obj: Record<string, string[]>): ReverseMap {
  const m: ReverseMap = new Map();
  for (const [file, tests] of Object.entries(obj)) {
    m.set(file, new Set(tests));
  }
  return m;
}

/** Serialize a ReverseMap to a comparable plain object (sets → sorted arrays). */
function plain(m: ReverseMap): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [file, tests] of m) out[file] = [...tests].sort();
  return out;
}

describe('mergeRuntimeEdges', () => {
  test("scope='all' replaces edges for every fresh test", () => {
    // src/a.ts used to be imported by a.test.ts; now a.test.ts imports src/b.ts
    // instead. scope='all' must strip the stale a.ts→a.test.ts edge.
    const base = rmap({
      '/p/src/a.ts': ['/p/a.test.ts'],
    });
    const fresh = rmap({
      '/p/src/b.ts': ['/p/a.test.ts'],
    });

    const merged = mergeRuntimeEdges(base, fresh, 'all');

    expect(plain(merged)).toEqual({
      '/p/src/b.ts': ['/p/a.test.ts'],
    });
    // a.ts had its only edge stripped → dropped entirely
    expect(merged.has('/p/src/a.ts')).toBe(false);
  });

  test("scope='all' preserves edges for tests that did not run this cycle", () => {
    // b.test.ts is not present in fresh, so its edge in base must survive.
    const base = rmap({
      '/p/src/shared.ts': ['/p/a.test.ts', '/p/b.test.ts'],
    });
    const fresh = rmap({
      '/p/src/shared.ts': ['/p/a.test.ts'],
    });

    const merged = mergeRuntimeEdges(base, fresh, 'all');

    // a.test.ts overwritten (still present), b.test.ts preserved untouched
    expect(plain(merged)).toEqual({
      '/p/src/shared.ts': ['/p/a.test.ts', '/p/b.test.ts'],
    });
  });

  test('scope=Set restricts the overwrite to listed tests', () => {
    // Only a.test.ts is in scope. Its stale edge (a.ts) is stripped and its
    // fresh edge (b.ts) applied. c.test.ts is NOT in scope: its base edge
    // survives and its fresh edge is ignored.
    const base = rmap({
      '/p/src/a.ts': ['/p/a.test.ts'],
      '/p/src/c.ts': ['/p/c.test.ts'],
    });
    const fresh = rmap({
      '/p/src/b.ts': ['/p/a.test.ts'],
      '/p/src/d.ts': ['/p/c.test.ts'],
    });

    const merged = mergeRuntimeEdges(base, fresh, new Set(['/p/a.test.ts']));

    expect(plain(merged)).toEqual({
      // a.test.ts overwrite applied: a.ts stripped, b.ts added
      '/p/src/b.ts': ['/p/a.test.ts'],
      // c.test.ts untouched: base edge preserved, fresh d.ts edge ignored
      '/p/src/c.ts': ['/p/c.test.ts'],
    });
    expect(merged.has('/p/src/a.ts')).toBe(false);
    expect(merged.has('/p/src/d.ts')).toBe(false);
  });

  test('does not mutate the base or fresh inputs (pure)', () => {
    const base = rmap({ '/p/src/a.ts': ['/p/a.test.ts'] });
    const fresh = rmap({ '/p/src/b.ts': ['/p/a.test.ts'] });
    const baseBefore = plain(base);
    const freshBefore = plain(fresh);

    mergeRuntimeEdges(base, fresh, 'all');

    expect(plain(base)).toEqual(baseBefore);
    expect(plain(fresh)).toEqual(freshBefore);
  });

  test('scope=Set with an empty set is a no-op copy of base', () => {
    const base = rmap({ '/p/src/a.ts': ['/p/a.test.ts'] });
    const fresh = rmap({ '/p/src/b.ts': ['/p/a.test.ts'] });

    const merged = mergeRuntimeEdges(base, fresh, new Set());

    expect(plain(merged)).toEqual(plain(base));
    // still a fresh map, not the same reference
    expect(merged).not.toBe(base);
  });
});
