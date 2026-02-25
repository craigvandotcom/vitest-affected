/// <reference types="vitest/config" />
import { describe, test, expect, afterEach, beforeEach } from 'vitest';
import path from 'node:path';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { vitestAffected } from '../src/plugin.js';
import { saveCacheSync } from '../src/graph/cache.js';

const tempDirs: string[] = [];

// The plugin checks VITEST_AFFECTED_DISABLED env var. When the outer test runner
// uses VITEST_AFFECTED_DISABLED=1 to run the full suite, it leaks into the child
// test process and disables the plugin under test. Save and restore it.
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env.VITEST_AFFECTED_DISABLED;
  delete process.env.VITEST_AFFECTED_DISABLED;
});

afterEach(() => {
  if (savedEnv !== undefined) {
    process.env.VITEST_AFFECTED_DISABLED = savedEnv;
  } else {
    delete process.env.VITEST_AFFECTED_DISABLED;
  }
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  tempDirs.length = 0;
});

/**
 * Create a temp project with a real test file and an orphan source file.
 * The orphan file is NOT in any test's dependency chain — changing it
 * produces zero affected tests.
 *
 * Also writes a v2 cache that maps main.ts → main.test.ts (but NOT orphan.ts).
 */
function setupOrphanFixture(): { tmpDir: string; orphanPath: string } {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'vitest-affected-plugin-'));
  tempDirs.push(tmpDir);

  mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
  mkdirSync(path.join(tmpDir, 'tests'), { recursive: true });

  writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}');
  writeFileSync(path.join(tmpDir, 'src', 'main.ts'), 'export const main = 1;\n');
  writeFileSync(path.join(tmpDir, 'src', 'orphan.ts'), 'export const orphan = 1;\n');
  writeFileSync(
    path.join(tmpDir, 'tests', 'main.test.ts'),
    'import { main } from "../src/main";\nimport { test, expect } from "vitest";\ntest("main", () => expect(main).toBe(1));\n',
  );

  // Write a v2 cache: main.ts → main.test.ts (orphan.ts not in cache)
  const cacheDir = path.join(tmpDir, '.vitest-affected');
  const reverse = new Map<string, Set<string>>();
  reverse.set(
    path.join(tmpDir, 'src', 'main.ts'),
    new Set([path.join(tmpDir, 'tests', 'main.test.ts')]),
  );
  saveCacheSync(cacheDir, reverse);

  return { tmpDir, orphanPath: path.join(tmpDir, 'src', 'orphan.ts') };
}

/**
 * Create a mock vitest/project context for direct plugin testing.
 * Returns the project.config object so tests can assert mutations.
 */
function createMockContext(rootDir: string) {
  const projectConfig = {
    include: ['tests/**/*.test.ts'],
    exclude: [] as string[],
    setupFiles: [] as string[],
  };
  const mockProject = { config: projectConfig };
  const mockVitest = {
    config: { root: rootDir, watch: false },
    projects: [mockProject],
    reporters: [] as unknown[],
    onFilterWatchedSpecification: () => {},
  };
  return { vitest: mockVitest, project: mockProject, projectConfig };
}

describe('allowNoTests option', () => {
  test('zero affected tests with allowNoTests: true sets include to empty array', async () => {
    const { tmpDir, orphanPath } = setupOrphanFixture();

    const plugin = vitestAffected({
      allowNoTests: true,
      changedFiles: [orphanPath],
      cache: true,
    });

    const { vitest, project, projectConfig } = createMockContext(tmpDir);

    const hook = (plugin as Record<string, unknown>).configureVitest as (
      ctx: { vitest: typeof vitest; project: typeof project },
    ) => Promise<void>;

    await hook({ vitest, project });

    // With allowNoTests=true and 0 affected tests, include should be empty array
    expect(projectConfig.include).toEqual([]);
  });

  test('zero affected tests with allowNoTests: false/default warns and keeps full suite', async () => {
    const { tmpDir, orphanPath } = setupOrphanFixture();

    const plugin = vitestAffected({
      changedFiles: [orphanPath],
      cache: true,
    });

    const { vitest, project, projectConfig } = createMockContext(tmpDir);
    const originalInclude = [...projectConfig.include];

    const hook = (plugin as Record<string, unknown>).configureVitest as (
      ctx: { vitest: typeof vitest; project: typeof project },
    ) => Promise<void>;

    await hook({ vitest, project });

    // Without allowNoTests, include should remain unchanged (full suite fallback)
    expect(projectConfig.include).toEqual(originalInclude);
  });
});
