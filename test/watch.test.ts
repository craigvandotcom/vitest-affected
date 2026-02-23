/// <reference types="vitest/config" />
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  lstatSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { vitestAffected } from '../src/plugin.js';
import { saveGraphSyncInternal } from '../src/graph/cache.js';

// ---------------------------------------------------------------------------
// Env save/restore (same pattern as plugin.test.ts)
// ---------------------------------------------------------------------------

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
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  tempDirs.length = 0;
});

const tempDirs: string[] = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal temp project:
 *   src/main.ts  (imports src/lib.ts)
 *   src/lib.ts
 *   src/orphan.ts (no importers)
 *   tests/main.test.ts (imports src/main.ts)
 *
 * Returns absolute paths to key files.
 */
function setupWatchFixture(): {
  tmpDir: string;
  mainTs: string;
  libTs: string;
  orphanTs: string;
  mainTestTs: string;
} {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'vitest-affected-watch-'));
  tempDirs.push(tmpDir);

  mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
  mkdirSync(path.join(tmpDir, 'tests'), { recursive: true });

  writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}');
  writeFileSync(
    path.join(tmpDir, 'src', 'lib.ts'),
    'export const lib = 42;\n',
  );
  writeFileSync(
    path.join(tmpDir, 'src', 'main.ts'),
    'import { lib } from "./lib";\nexport const main = lib + 1;\n',
  );
  writeFileSync(
    path.join(tmpDir, 'src', 'orphan.ts'),
    'export const orphan = 99;\n',
  );
  writeFileSync(
    path.join(tmpDir, 'tests', 'main.test.ts'),
    'import { main } from "../src/main";\nimport { test, expect } from "vitest";\ntest("main", () => expect(main).toBeDefined());\n',
  );

  return {
    tmpDir,
    mainTs: path.join(tmpDir, 'src', 'main.ts'),
    libTs: path.join(tmpDir, 'src', 'lib.ts'),
    orphanTs: path.join(tmpDir, 'src', 'orphan.ts'),
    mainTestTs: path.join(tmpDir, 'tests', 'main.test.ts'),
  };
}

/**
 * Create a watch-mode mock context.
 * Captures the onFilterWatchedSpecification callback.
 */
function createWatchMockContext(rootDir: string) {
  const projectConfig = {
    include: ['tests/**/*.test.ts'],
    exclude: [] as string[],
    setupFiles: [] as string[],
  };
  const mockProject = { config: projectConfig };

  let filterCallback: ((spec: { moduleId: string }) => boolean) | null = null;

  const mockVitest = {
    config: { root: rootDir, watch: true },
    projects: [mockProject],
    onFilterWatchedSpecification: (cb: (spec: { moduleId: string }) => boolean) => {
      filterCallback = cb;
    },
  };

  return {
    vitest: mockVitest,
    project: mockProject,
    projectConfig,
    getFilterCallback: () => filterCallback,
  };
}

/**
 * Helper to invoke the configureVitest hook.
 */
async function runHook(
  plugin: ReturnType<typeof vitestAffected>,
  vitest: ReturnType<typeof createWatchMockContext>['vitest'],
  project: ReturnType<typeof createWatchMockContext>['project'],
): Promise<void> {
  const hook = (plugin as Record<string, unknown>).configureVitest as (ctx: {
    vitest: typeof vitest;
    project: typeof project;
  }) => Promise<void>;
  await hook({ vitest, project });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('watch mode filter registration', () => {
  test('filter callback is registered in watch mode after plugin init', async () => {
    const { tmpDir } = setupWatchFixture();
    const { vitest, project, getFilterCallback } = createWatchMockContext(tmpDir);

    const plugin = vitestAffected({
      changedFiles: [],
      cache: true,
    });

    await runHook(plugin, vitest, project);

    // The callback should have been registered
    expect(getFilterCallback()).not.toBeNull();
    expect(typeof getFilterCallback()).toBe('function');
  });

  test('filter callback is NOT registered in non-watch mode', async () => {
    const { tmpDir } = setupWatchFixture();
    const projectConfig = {
      include: ['tests/**/*.test.ts'],
      exclude: [] as string[],
      setupFiles: [] as string[],
    };
    const mockProject = { config: projectConfig };

    let filterCallbackRegistered = false;
    const mockVitest = {
      config: { root: tmpDir, watch: false },
      projects: [mockProject],
      onFilterWatchedSpecification: (_cb: (spec: { moduleId: string }) => boolean) => {
        filterCallbackRegistered = true;
      },
    };

    const plugin = vitestAffected({ changedFiles: [], cache: false });
    const hook = (plugin as Record<string, unknown>).configureVitest as (ctx: {
      vitest: typeof mockVitest;
      project: typeof mockProject;
    }) => Promise<void>;
    await hook({ vitest: mockVitest, project: mockProject });

    expect(filterCallbackRegistered).toBe(false);
  });
});

describe('watch filter callback behavior', () => {
  test('unknown spec (not in forward graph) returns true (conservative fallback)', async () => {
    const { tmpDir } = setupWatchFixture();
    const { vitest, project, getFilterCallback } = createWatchMockContext(tmpDir);

    const plugin = vitestAffected({ changedFiles: [], cache: true });
    await runHook(plugin, vitest, project);

    const filter = getFilterCallback();
    expect(filter).not.toBeNull();

    // A moduleId not in our graph should pass through
    const result = filter!({ moduleId: '/nonexistent/path/that/is/not/in/graph.ts' });
    expect(result).toBe(true);
  });

  test('affected spec (in changed dependency chain) returns true', async () => {
    const { tmpDir, libTs, mainTestTs } = setupWatchFixture();
    const { vitest, project, getFilterCallback } = createWatchMockContext(tmpDir);

    const cacheDir = path.join(tmpDir, '.vitest-affected');
    const mainTs = path.join(tmpDir, 'src', 'main.ts');
    const orphanTs = path.join(tmpDir, 'src', 'orphan.ts');

    // Run the plugin to get the filter registered (also writes current-mtime cache)
    const plugin = vitestAffected({ changedFiles: [], cache: true });
    await runHook(plugin, vitest, project);

    // NOW overwrite the cache with a stale mtime for libTs.
    // The filter reads the cache lazily when invoked, so this stale cache will
    // be read on the first filter call, making libTs appear "changed".
    const forward = new Map<string, Set<string>>([
      [mainTestTs, new Set([mainTs])],
      [mainTs, new Set([libTs])],
      [libTs, new Set()],
      [orphanTs, new Set()],
    ]);
    const staleMtimes = new Map([
      [mainTestTs, lstatSync(mainTestTs).mtimeMs],
      [mainTs, lstatSync(mainTs).mtimeMs],
      [libTs, 0], // stale — will appear "changed" when compared to real mtime
      [orphanTs, lstatSync(orphanTs).mtimeMs],
    ]);
    saveGraphSyncInternal(forward, cacheDir, staleMtimes);

    const filter = getFilterCallback();
    expect(filter).not.toBeNull();

    // mainTestTs imports mainTs which imports libTs (the "changed" file)
    // So mainTestTs should be in the affected set → filter returns true
    const result = filter!({ moduleId: mainTestTs });
    expect(result).toBe(true);
  });

  test('unaffected spec (not in changed dependency chain) returns false', async () => {
    const { tmpDir, libTs, mainTestTs } = setupWatchFixture();

    const cacheDir = path.join(tmpDir, '.vitest-affected');
    const mainTs = path.join(tmpDir, 'src', 'main.ts');
    const orphanTs = path.join(tmpDir, 'src', 'orphan.ts');

    const { vitest, project, getFilterCallback } = createWatchMockContext(tmpDir);
    const plugin = vitestAffected({ changedFiles: [], cache: true });
    await runHook(plugin, vitest, project);

    // Overwrite cache with stale mtime for libTs (post-hook, before filter fires)
    const forward = new Map<string, Set<string>>([
      [mainTestTs, new Set([mainTs])],
      [mainTs, new Set([libTs])],
      [libTs, new Set()],
      [orphanTs, new Set()],
    ]);
    const staleMtimes = new Map([
      [mainTestTs, lstatSync(mainTestTs).mtimeMs],
      [mainTs, lstatSync(mainTs).mtimeMs],
      [libTs, 0], // stale → libTs "changed"
      [orphanTs, lstatSync(orphanTs).mtimeMs],
    ]);
    saveGraphSyncInternal(forward, cacheDir, staleMtimes);

    const filter = getFilterCallback();
    expect(filter).not.toBeNull();

    // orphanTs is in the forward graph but NOT in the changed chain
    // (libTs changed, which only affects mainTs → mainTestTs)
    // So orphanTs should be filtered OUT → false
    const result = filter!({ moduleId: orphanTs });
    expect(result).toBe(false);
  });

  test('batch reset: currentAffectedSet is recomputed after 500ms', async () => {
    const { tmpDir, libTs, mainTestTs } = setupWatchFixture();
    const cacheDir = path.join(tmpDir, '.vitest-affected');
    const mainTs = path.join(tmpDir, 'src', 'main.ts');
    const orphanTs = path.join(tmpDir, 'src', 'orphan.ts');

    const { vitest, project, getFilterCallback } = createWatchMockContext(tmpDir);
    const plugin = vitestAffected({ changedFiles: [], cache: true });
    await runHook(plugin, vitest, project);

    // Overwrite cache with stale mtime for libTs (post-hook, before filter fires)
    const forward = new Map<string, Set<string>>([
      [mainTestTs, new Set([mainTs])],
      [mainTs, new Set([libTs])],
      [libTs, new Set()],
      [orphanTs, new Set()],
    ]);
    const staleMtimes = new Map([
      [mainTestTs, lstatSync(mainTestTs).mtimeMs],
      [mainTs, lstatSync(mainTs).mtimeMs],
      [libTs, 0], // stale → libTs "changed"
      [orphanTs, lstatSync(orphanTs).mtimeMs],
    ]);
    saveGraphSyncInternal(forward, cacheDir, staleMtimes);

    const filter = getFilterCallback();
    expect(filter).not.toBeNull();

    // First call: libTs is stale → mainTestTs affected → true
    const firstResult = filter!({ moduleId: mainTestTs });
    expect(firstResult).toBe(true);

    // Second call within same batch (<500ms): currentAffectedSet is reused.
    // orphanTs is in forward graph but not in affected chain → false
    const secondResult = filter!({ moduleId: orphanTs });
    expect(secondResult).toBe(false);

    // Third call also within same batch: mainTestTs still in cached affected set → true
    const thirdResult = filter!({ moduleId: mainTestTs });
    expect(thirdResult).toBe(true);
  });
});
