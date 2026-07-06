/// <reference types="vitest/config" />
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { vitestAffected } from '../src/plugin.js';
import { saveCacheSync } from '../src/graph/cache.js';
import { createMockContext, runHook, cleanupTempDirs } from './_helpers.js';

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
  cleanupTempDirs(tempDirs);
});

const tempDirs: string[] = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('watch mode: pass-through filter', () => {
  test('filter callback is registered in watch mode after plugin init', async () => {
    const { tmpDir, mainTs, mainTestTs } = setupWatchFixture();
    const cacheDir = path.join(tmpDir, '.vitest-affected');

    // Write v2 cache so plugin has a hit
    const reverse = new Map<string, Set<string>>();
    reverse.set(mainTs, new Set([mainTestTs]));
    saveCacheSync(cacheDir, reverse);

    const { vitest, project, getFilterCallback } = createMockContext(tmpDir, { watch: true });

    const plugin = vitestAffected({
      changedFiles: [],
      cache: true,
    });

    await runHook(plugin, { vitest, project });

    // The callback should have been registered
    expect(getFilterCallback()).not.toBeNull();
    expect(typeof getFilterCallback()).toBe('function');
  });

  test('filter callback is NOT registered in non-watch mode', async () => {
    const { tmpDir, mainTs, mainTestTs } = setupWatchFixture();
    const cacheDir = path.join(tmpDir, '.vitest-affected');

    const reverse = new Map<string, Set<string>>();
    reverse.set(mainTs, new Set([mainTestTs]));
    saveCacheSync(cacheDir, reverse);

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
      reporters: [] as unknown[],
      onFilterWatchedSpecification: (_cb: (spec: { moduleId: string }) => boolean) => {
        filterCallbackRegistered = true;
      },
    };

    const plugin = vitestAffected({ changedFiles: [], cache: true });
    const hook = (plugin as unknown as Record<string, unknown>).configureVitest as (ctx: {
      vitest: typeof mockVitest;
      project: typeof mockProject;
    }) => Promise<void>;
    await hook({ vitest: mockVitest, project: mockProject });

    expect(filterCallbackRegistered).toBe(false);
  });

  test('pass-through filter returns true for all specs', async () => {
    const { tmpDir, mainTs, mainTestTs, orphanTs } = setupWatchFixture();
    const cacheDir = path.join(tmpDir, '.vitest-affected');

    const reverse = new Map<string, Set<string>>();
    reverse.set(mainTs, new Set([mainTestTs]));
    saveCacheSync(cacheDir, reverse);

    const { vitest, project, getFilterCallback } = createMockContext(tmpDir, { watch: true });

    const plugin = vitestAffected({ changedFiles: [], cache: true });
    await runHook(plugin, { vitest, project });

    const filter = getFilterCallback();
    expect(filter).not.toBeNull();

    // Pass-through: all specs return true
    expect(filter!({ moduleId: mainTestTs })).toBe(true);
    expect(filter!({ moduleId: orphanTs })).toBe(true);
    expect(filter!({ moduleId: '/nonexistent/path.ts' })).toBe(true);
  });
});
