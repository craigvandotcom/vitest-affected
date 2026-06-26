/// <reference types="vitest/config" />
import { describe, test, expect, afterEach, beforeEach } from 'vitest';
import path from 'node:path';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
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

describe('fullSuiteTriggers option', () => {
  /** Run the configureVitest hook for a plugin against a mock context. */
  async function run(
    plugin: ReturnType<typeof vitestAffected>,
    tmpDir: string,
  ) {
    const { vitest, project, projectConfig } = createMockContext(tmpDir);
    const hook = (plugin as Record<string, unknown>).configureVitest as (
      ctx: { vitest: typeof vitest; project: typeof project },
    ) => Promise<void>;
    await hook({ vitest, project });
    return projectConfig;
  }

  function lastStatsReason(statsFile: string): string {
    const lines = readFileSync(statsFile, 'utf-8').trim().split('\n');
    return JSON.parse(lines[lines.length - 1]).reason;
  }

  test('a matching trigger forces full suite even when allowNoTests would select zero', async () => {
    // Counterpart to the allowNoTests test above: there, orphan.ts → include []
    // (zero tests). Here the same change matches a trigger, so the suite runs in
    // full — include is left untouched.
    const { tmpDir, orphanPath } = setupOrphanFixture();
    const projectConfig = await run(
      vitestAffected({
        allowNoTests: true,
        changedFiles: [orphanPath],
        cache: true,
        fullSuiteTriggers: ['src/orphan.ts'],
      }),
      tmpDir,
    );
    expect(projectConfig.include).toEqual(['tests/**/*.test.ts']);
  });

  test('a .md fixture (dropped by the relevance filter) still fires the trigger', async () => {
    // .md isn't in the relevance allowlist, so WITHOUT a trigger this change is
    // filtered to nothing → full suite for reason "no-changes". WITH a trigger,
    // it must fire BEFORE the filter → reason "full-suite-trigger". The stats
    // reason is what distinguishes the two (include is unchanged either way).
    const { tmpDir } = setupOrphanFixture();
    const mdPath = path.join(tmpDir, 'tests', 'fixtures', 'data.md');

    const withTrigger = path.join(tmpDir, 'with-trigger.jsonl');
    await run(
      vitestAffected({
        changedFiles: [mdPath],
        cache: true,
        fullSuiteTriggers: [/\.md$/],
        statsFile: withTrigger,
      }),
      tmpDir,
    );
    expect(lastStatsReason(withTrigger)).toBe('full-suite-trigger');

    const withoutTrigger = path.join(tmpDir, 'without-trigger.jsonl');
    await run(
      vitestAffected({
        changedFiles: [mdPath],
        cache: true,
        statsFile: withoutTrigger,
      }),
      tmpDir,
    );
    expect(lastStatsReason(withoutTrigger)).toBe('no-changes');
  });

  test('no trigger match leaves normal selection intact', async () => {
    // A relevant changed file that matches no trigger must NOT be hijacked into
    // a full-suite run — orphan.ts has zero dependents, so allowNoTests → [].
    const { tmpDir, orphanPath } = setupOrphanFixture();
    const projectConfig = await run(
      vitestAffected({
        allowNoTests: true,
        changedFiles: [orphanPath],
        cache: true,
        fullSuiteTriggers: ['__tests__/fixtures'],
      }),
      tmpDir,
    );
    expect(projectConfig.include).toEqual([]);
  });
});
