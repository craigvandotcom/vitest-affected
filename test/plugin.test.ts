/// <reference types="vitest/config" />
import { describe, test, expect, afterEach, beforeEach } from 'vitest';
import path from 'node:path';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { vitestAffected } from '../src/plugin.js';
import { saveCacheSync } from '../src/graph/cache.js';
import { createMockContext, cleanupTempDirs } from './_helpers.js';

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
  cleanupTempDirs(tempDirs);
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

describe('allowNoTests option', () => {
  test('zero affected tests with allowNoTests: true sets include to empty array', async () => {
    const { tmpDir, orphanPath } = setupOrphanFixture();

    const plugin = vitestAffected({
      allowNoTests: true,
      changedFiles: [orphanPath],
      cache: true,
    });

    const { vitest, project, projectConfig } = createMockContext(tmpDir);

    const hook = (plugin as unknown as Record<string, unknown>).configureVitest as (
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

    const hook = (plugin as unknown as Record<string, unknown>).configureVitest as (
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
    const hook = (plugin as unknown as Record<string, unknown>).configureVitest as (
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

describe('env-drift recipe (T2c decision): fullSuiteTriggers, not CONFIG_BASENAMES', () => {
  // DECISION: env-drift (external .env/.env.local edits — 74 BCA test files read
  // process.env with zero trigger today) is handled as a documented, OPT-IN
  // fullSuiteTriggers recipe, not an always-on CONFIG_BASENAMES entry. Two
  // reasons: (1) corpus evidence (A4 walk, 99 commits) showed zero observed
  // misses via any channel, including env-adjacent commits — nothing forces
  // the always-on form; (2) .env is gitignored in the common case, so
  // src/git.ts's `ls-files --others --modified --exclude-standard` never
  // surfaces it as "changed" at all (see test/git.test.ts) — an always-on
  // CONFIG_BASENAMES entry would be dead code for that path and would only
  // ever fire for the unusual repo that tracks .env in git.
  //
  // The recipe below is for consumers who compute `changedFiles` themselves
  // (e.g. a CI step that diffs deployed env vars against the previous deploy,
  // or a repo that intentionally tracks .env) and pass it in explicitly —
  // that's the one channel where a git-diff-blind file can still reach the
  // plugin.
  async function run(
    plugin: ReturnType<typeof vitestAffected>,
    tmpDir: string,
  ) {
    const { vitest, project, projectConfig } = createMockContext(tmpDir);
    const hook = (plugin as unknown as Record<string, unknown>).configureVitest as (
      ctx: { vitest: typeof vitest; project: typeof project },
    ) => Promise<void>;
    await hook({ vitest, project });
    return projectConfig;
  }

  function lastStatsReason(statsFile: string): string {
    const lines = readFileSync(statsFile, 'utf-8').trim().split('\n');
    return JSON.parse(lines[lines.length - 1]).reason;
  }

  test('recipe: fullSuiteTriggers: [/^\\.env/] forces full suite for an explicitly-provided .env change', async () => {
    const { tmpDir } = setupOrphanFixture();
    const envPath = path.join(tmpDir, '.env');
    writeFileSync(envPath, 'SECRET=1\n');
    const statsFile = path.join(tmpDir, 'stats.jsonl');

    const projectConfig = await run(
      vitestAffected({
        changedFiles: [envPath],
        cache: true,
        fullSuiteTriggers: [/^\.env/],
        statsFile,
      }),
      tmpDir,
    );

    expect(projectConfig.include).toEqual(['tests/**/*.test.ts']);
    expect(lastStatsReason(statsFile)).toBe('full-suite-trigger');
  });

  test('the documented gap: WITHOUT the recipe, the same .env change is silently dropped (reason=no-changes)', async () => {
    const { tmpDir } = setupOrphanFixture();
    const envPath = path.join(tmpDir, '.env');
    writeFileSync(envPath, 'SECRET=1\n');
    const statsFile = path.join(tmpDir, 'stats.jsonl');

    const projectConfig = await run(
      vitestAffected({
        changedFiles: [envPath],
        cache: true,
        statsFile,
      }),
      tmpDir,
    );

    // No trigger configured → .env has no matching extension and isn't a
    // config basename → filtered to nothing → full suite via "no-changes",
    // NOT via a targeted env-aware decision. This is the gap the README
    // caveat documents.
    expect(projectConfig.include).toEqual(['tests/**/*.test.ts']);
    expect(lastStatsReason(statsFile)).toBe('no-changes');
  });
});

describe('globalSetup full-suite trigger', () => {
  /** Run the configureVitest hook against a mock context whose project.config.globalSetup is set. */
  async function run(
    plugin: ReturnType<typeof vitestAffected>,
    tmpDir: string,
    globalSetup: string | string[],
  ) {
    const { vitest, project, projectConfig } = createMockContext(tmpDir, { globalSetup });
    const hook = (plugin as unknown as Record<string, unknown>).configureVitest as (
      ctx: { vitest: typeof vitest; project: typeof project },
    ) => Promise<void>;
    await hook({ vitest, project });
    return projectConfig;
  }

  function lastStatsReason(statsFile: string): string {
    const lines = readFileSync(statsFile, 'utf-8').trim().split('\n');
    return JSON.parse(lines[lines.length - 1]).reason;
  }

  test('a changed globalSetup file (string form) forces full suite, reason=global-setup-change', async () => {
    const { tmpDir } = setupOrphanFixture();
    const globalSetupPath = path.join(tmpDir, 'global-setup.ts');
    writeFileSync(globalSetupPath, 'export function setup() {}\n');
    const statsFile = path.join(tmpDir, 'stats.jsonl');

    const projectConfig = await run(
      vitestAffected({ changedFiles: [globalSetupPath], cache: true, statsFile }),
      tmpDir,
      globalSetupPath,
    );

    // Full suite: include is left untouched (never narrowed to a subset).
    expect(projectConfig.include).toEqual(['tests/**/*.test.ts']);
    expect(lastStatsReason(statsFile)).toBe('global-setup-change');
  });

  test('a changed globalSetup file (array form) forces full suite, reason=global-setup-change', async () => {
    const { tmpDir } = setupOrphanFixture();
    const globalSetupA = path.join(tmpDir, 'global-setup-a.ts');
    const globalSetupB = path.join(tmpDir, 'global-setup-b.ts');
    writeFileSync(globalSetupA, 'export function setupA() {}\n');
    writeFileSync(globalSetupB, 'export function setupB() {}\n');
    const statsFile = path.join(tmpDir, 'stats.jsonl');

    const projectConfig = await run(
      vitestAffected({ changedFiles: [globalSetupB], cache: true, statsFile }),
      tmpDir,
      [globalSetupA, globalSetupB],
    );

    expect(projectConfig.include).toEqual(['tests/**/*.test.ts']);
    expect(lastStatsReason(statsFile)).toBe('global-setup-change');
  });

  test('a globalSetup declared as a relative path still matches the resolved absolute changed file', async () => {
    // Regression guard for the setupFiles relative-path bug from 0.4.1: a
    // resolved config's globalSetup can be relative to rootDir. If the plugin
    // compared it as-is against absolute changed-file paths, it would never
    // match and the trigger would silently miss.
    const { tmpDir } = setupOrphanFixture();
    const globalSetupPath = path.join(tmpDir, 'global-setup.ts');
    writeFileSync(globalSetupPath, 'export function setup() {}\n');
    const statsFile = path.join(tmpDir, 'stats.jsonl');

    const projectConfig = await run(
      vitestAffected({ changedFiles: [globalSetupPath], cache: true, statsFile }),
      tmpDir,
      'global-setup.ts', // relative to rootDir
    );

    expect(projectConfig.include).toEqual(['tests/**/*.test.ts']);
    expect(lastStatsReason(statsFile)).toBe('global-setup-change');
  });

  test('a change unrelated to globalSetup does not fire the trigger', async () => {
    const { tmpDir, orphanPath } = setupOrphanFixture();
    const globalSetupPath = path.join(tmpDir, 'global-setup.ts');
    writeFileSync(globalSetupPath, 'export function setup() {}\n');
    const statsFile = path.join(tmpDir, 'stats.jsonl');

    await run(
      vitestAffected({ changedFiles: [orphanPath], cache: true, statsFile }),
      tmpDir,
      globalSetupPath,
    );

    expect(lastStatsReason(statsFile)).not.toBe('global-setup-change');
  });
});

describe('setup/globalSetup triggers evaluate the RAW changed set (pre-filter)', () => {
  function lastStatsReason(statsFile: string): string {
    const lines = readFileSync(statsFile, 'utf-8').trim().split('\n');
    return JSON.parse(lines[lines.length - 1]).reason;
  }

  /** Build a context with explicit setupFiles / globalSetup and run the hook. */
  async function run(
    plugin: ReturnType<typeof vitestAffected>,
    tmpDir: string,
    extra: { setupFiles?: string[]; globalSetup?: string | string[] },
  ) {
    const projectConfig = {
      include: ['tests/**/*.test.ts'],
      exclude: [] as string[],
      setupFiles: extra.setupFiles ?? [],
      globalSetup: extra.globalSetup,
    };
    const project = { config: projectConfig };
    const vitest = {
      config: { root: tmpDir, watch: false },
      projects: [project],
      reporters: [] as unknown[],
      onFilterWatchedSpecification: () => {},
    };
    const hook = (plugin as unknown as Record<string, unknown>).configureVitest as (
      ctx: { vitest: typeof vitest; project: typeof project },
    ) => Promise<void>;
    await hook({ vitest, project });
    return projectConfig;
  }

  test('a setupFiles entry listed in ignoreChangedFiles STILL forces full suite (reason=setup-file-change)', async () => {
    // Before the fix, the setup check ran on the relevance-FILTERED set, so an
    // ignoreChangedFiles rule matching the setup file dropped it → under-select.
    // Now the check runs on the raw set, so it fires regardless of the ignore.
    const { tmpDir } = setupOrphanFixture();
    const setupPath = path.join(tmpDir, 'setup.ts');
    writeFileSync(setupPath, 'export function setup() {}\n');
    const statsFile = path.join(tmpDir, 'stats.jsonl');

    const projectConfig = await run(
      vitestAffected({
        changedFiles: [setupPath],
        cache: true,
        statsFile,
        ignoreChangedFiles: ['setup.ts'], // would otherwise filter it out
      }),
      tmpDir,
      { setupFiles: [setupPath] },
    );

    expect(projectConfig.include).toEqual(['tests/**/*.test.ts']);
    expect(lastStatsReason(statsFile)).toBe('setup-file-change');
  });

  test('a globalSetup entry listed in ignoreChangedFiles STILL forces full suite (reason=global-setup-change)', async () => {
    const { tmpDir } = setupOrphanFixture();
    const globalSetupPath = path.join(tmpDir, 'global-setup.ts');
    writeFileSync(globalSetupPath, 'export function setup() {}\n');
    const statsFile = path.join(tmpDir, 'stats.jsonl');

    const projectConfig = await run(
      vitestAffected({
        changedFiles: [globalSetupPath],
        cache: true,
        statsFile,
        ignoreChangedFiles: ['global-setup.ts'],
      }),
      tmpDir,
      { globalSetup: globalSetupPath },
    );

    expect(projectConfig.include).toEqual(['tests/**/*.test.ts']);
    expect(lastStatsReason(statsFile)).toBe('global-setup-change');
  });
});

describe('symlinked rootDir canonicalization', () => {
  test('selective selection converges when rootDir and changed files arrive through a symlink alias', async () => {
    // The production scenario behind boundary canonicalization: the project
    // lives at a real path, but Vitest is invoked through a symlink alias
    // (symlinked checkout dir, macOS /var temp alias, etc). The cache is keyed
    // by CANONICAL paths (what the runtime reporter writes), while rootDir and
    // the changed file arrive via the ALIAS. Without canonicalization at both
    // boundaries the alias-path seed misses the canonical graph key -> zero
    // affected tests -> silent full-suite fallback. With it, selection works.
    const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'vitest-affected-symlink-root-')));
    tempDirs.push(base);

    const realDir = path.join(base, 'real-project');
    mkdirSync(path.join(realDir, 'src'), { recursive: true });
    mkdirSync(path.join(realDir, 'tests'), { recursive: true });
    writeFileSync(path.join(realDir, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}');
    writeFileSync(path.join(realDir, 'src', 'main.ts'), 'export const main = 1;\n');
    const canonicalTest = path.join(realDir, 'tests', 'main.test.ts');
    writeFileSync(
      canonicalTest,
      'import { main } from "../src/main";\nimport { test, expect } from "vitest";\ntest("main", () => expect(main).toBe(1));\n',
    );

    // Cache keyed by canonical paths, as the runtime reporter records them.
    const reverse = new Map<string, Set<string>>();
    reverse.set(
      path.join(realDir, 'src', 'main.ts'),
      new Set([canonicalTest]),
    );
    saveCacheSync(path.join(realDir, '.vitest-affected'), reverse);

    // Everything the plugin RECEIVES goes through the alias.
    const aliasDir = path.join(base, 'alias');
    symlinkSync(realDir, aliasDir, 'dir');

    const plugin = vitestAffected({
      changedFiles: [path.join(aliasDir, 'src', 'main.ts')],
      cache: true,
    });
    const { vitest, project, projectConfig } = createMockContext(aliasDir);

    const hook = (plugin as unknown as Record<string, unknown>).configureVitest as (
      ctx: { vitest: typeof vitest; project: typeof project },
    ) => Promise<void>;
    await hook({ vitest, project });

    // Selection must land on the CANONICAL test path — not fall back to the
    // full-suite include pattern, and not emit an alias-path variant.
    expect(projectConfig.include).toEqual([canonicalTest]);
  });
});
