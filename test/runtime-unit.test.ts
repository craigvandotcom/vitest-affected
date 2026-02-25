/// <reference types="vitest/config" />
import { describe, test, expect } from 'vitest';
import type { TestModule } from 'vitest/node';
import type { TestRunEndReason } from 'vitest/reporters';
import { createRuntimeReporter } from '../src/plugin.js';

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
