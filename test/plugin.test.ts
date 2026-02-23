/// <reference types="vitest/config" />
import { describe, test, expect, afterEach } from 'vitest';
import path from 'node:path';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { vitestAffected } from '../src/plugin.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  tempDirs.length = 0;
});

/**
 * Create a temp project with a real test file and an orphan source file.
 * The orphan file is NOT in any test's dependency chain — changing it
 * produces zero affected tests.
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
  };
  return { vitest: mockVitest, project: mockProject, projectConfig };
}

describe('allowNoTests option', () => {
  test('zero affected tests with allowNoTests: true sets include to empty array', async () => {
    const { tmpDir, orphanPath } = setupOrphanFixture();

    const plugin = vitestAffected({
      allowNoTests: true,
      changedFiles: [orphanPath],
      cache: false,
    });

    const { vitest, project, projectConfig } = createMockContext(tmpDir);

    // The plugin's configureVitest hook is on the returned object
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
      cache: false,
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
