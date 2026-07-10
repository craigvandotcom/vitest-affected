/// <reference types="vitest/config" />
//
// The wave's Silver Bullet: proves BOTH blind-channel closure mechanisms
// end-to-end.
//
//   1. The raw-import edge — a Vite `?raw` import (e.g. `import w from
//      './w.txt?raw'`) that the static oxc-parser walk cannot resolve to a
//      real module on its own. Closed by two already-merged pieces working
//      together: the runtime reporter observing the ACTUAL executed module
//      graph (importDurations), and builder.ts's query-suffix handling
//      (stripQuerySuffix + binary-exclusion bypass) so a later delta-parse
//      of the changed file can also see it. PART 1 below (real `runVitest`,
//      warm cache from a prior run) is the end-to-end proof.
//
//   2. The alwaysRunTests option — a bounded, user-declared list of test
//      files unioned into every SELECTIVE run unconditionally, for tests
//      whose dependency surface no single import edge can represent. PART 2
//      below is the dedicated mock-context unit suite (mirrors
//      test/plugin.test.ts's 'alwaysRunTests option' describe block, which
//      already carries 3 sibling cases at a different layer — this file is
//      the layer-complete suite; overlap is intentional, not duplication).
//
// Case 8 (query-suffixed static seeding) is owned by va-pw0.7 and already
// lives in test/builder.test.ts ('query-suffixed specifiers (?raw, ?url)
// resolve to the real on-disk files, bypassing binary exclusion') — verified
// present, not duplicated here.
import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import {
  mkdtempSync,
  mkdirSync,
  cpSync,
  symlinkSync,
  writeFileSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { execa } from 'execa';
import type { Reporter, TestRunEndReason } from 'vitest/reporters';
import { vitestAffected } from '../src/plugin.js';
import { saveCacheSync } from '../src/graph/cache.js';
import {
  createMockContext,
  cleanupTempDirs,
  runHook,
  readStats,
  lastStat,
  createMockTestModule,
  makeTempDir,
} from './_helpers.js';

// ===========================================================================
// PART 1 — Silver Bullet: real runVitest integration, warm cache from a
// prior run. Uses test/fixtures/blind-channel/ (new fixture, owned by this
// bead): tests/t.test.ts imports src/w.txt via '?raw' ONLY, tests/u.test.ts
// imports the unrelated sibling src/x.ts (the control edge), tests/s.test.ts
// has no edges at all (the alwaysRunTests subject).
// ===========================================================================

const projectRoot = path.resolve(import.meta.dirname, '..');
const distPath = path.join(projectRoot, 'dist', 'index.js');
const distUrl = pathToFileURL(distPath).href;

const integrationTempDirs: string[] = [];

afterEach(() => {
  for (const dir of integrationTempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
  integrationTempDirs.length = 0;
});

interface VitestJsonReport {
  testResults: Array<{ name: string; status: string }>;
  success: boolean;
}

/**
 * Local integration harness for the blind-channel fixture: copy fixture ->
 * temp dir, symlink node_modules, write a vitest.config.ts that loads the
 * built plugin with INJECTABLE options. Mirrors test/integration.test.ts's
 * setupFixture/gitInit/runVitest trio, which hardcodes `{ verbose: true }`
 * only (test/integration.test.ts:44-70) — this local copy is the "add a
 * local helper" branch of the bead's harness-injection prerequisite. Kept
 * local rather than importing test/integration.test.ts directly: importing
 * a sibling *.test.ts module would re-execute its top-level `describe(...)`
 * calls and double-register its 9 tests.
 */
function setupBlindChannelFixture(): string {
  const src = path.join(import.meta.dirname, 'fixtures', 'blind-channel');
  const tmp = mkdtempSync(path.join(tmpdir(), 'vitest-affected-blind-channel-'));
  integrationTempDirs.push(tmp);
  cpSync(src, tmp, { recursive: true });

  symlinkSync(
    path.join(projectRoot, 'node_modules'),
    path.join(tmp, 'node_modules'),
  );

  writeBlindChannelConfig(tmp, {});
  return tmp;
}

/** (Re)write vitest.config.ts with the given plugin options layered over verbose:true. */
function writeBlindChannelConfig(tmp: string, options: Record<string, unknown>): void {
  writeFileSync(
    path.join(tmp, 'vitest.config.ts'),
    `
import { defineConfig } from 'vitest/config';
import { vitestAffected } from '${distUrl}';
export default defineConfig({
  plugins: [vitestAffected(${JSON.stringify({ verbose: true, ...options })})],
  test: { include: ['tests/**/*.test.ts'] },
});
`,
  );
}

async function gitInit(cwd: string): Promise<void> {
  await execa('git', ['init'], { cwd });
  await execa('git', ['config', 'user.email', 'test@test.com'], { cwd });
  await execa('git', ['config', 'user.name', 'Test'], { cwd });
  await execa('git', ['add', '.'], { cwd });
  await execa('git', ['commit', '-m', 'initial'], { cwd });
}

async function runVitest(
  cwd: string,
  env: Record<string, string> = {},
): Promise<VitestJsonReport> {
  const result = await execa('npx', ['vitest', 'run', '--reporter=json'], {
    cwd,
    env: { ...process.env, ...env },
    reject: false,
  });

  try {
    return JSON.parse(result.stdout) as VitestJsonReport;
  } catch {
    try {
      return JSON.parse(result.stderr) as VitestJsonReport;
    } catch {
      throw new Error(
        `Failed to parse Vitest JSON output.\nstdout: ${result.stdout}\nstderr: ${result.stderr}\nexitCode: ${result.exitCode}`,
      );
    }
  }
}

beforeAll(async () => {
  await execa('npm', ['run', 'build'], { cwd: projectRoot });
}, 60_000);

describe('Silver Bullet: blind-channel closure end-to-end', () => {
  test(
    'raw-import edge (?raw) and alwaysRunTests both close their respective blind channels',
    async () => {
      const tmp = setupBlindChannelFixture();
      await gitInit(tmp);

      const pluginEnv = { VITEST_AFFECTED_DISABLED: '0' };

      // --- Warm-up run: no cache yet -> full suite, populates the cache with
      // REAL runtime edges: t.test.ts -> w.txt (through the ?raw specifier),
      // u.test.ts -> x.ts. All 3 fixture tests run.
      const warmup = await runVitest(tmp, pluginEnv);
      expect(warmup.testResults).toHaveLength(3);

      const wPath = path.join(tmp, 'src', 'w.txt');
      const xPath = path.join(tmp, 'src', 'x.ts');
      const sPath = path.join(tmp, 'tests', 's.test.ts');

      // --- (a)+(b)+(e): changing w.txt selects t.test.ts (the raw-import
      // edge is live) and — with no alwaysRunTests configured — does NOT
      // select s.test.ts. This is the control for assertion (e): same diff,
      // no alwaysRunTests -> s.test.ts stays out.
      writeBlindChannelConfig(tmp, { changedFiles: [wPath] });
      const reportW = await runVitest(tmp, pluginEnv);
      const namesW = reportW.testResults.map((r) => r.name);
      expect(namesW.some((n) => n.includes('t.test.ts'))).toBe(true);
      expect(namesW.some((n) => n.includes('s.test.ts'))).toBe(false);
      expect(namesW.some((n) => n.includes('u.test.ts'))).toBe(false);
      expect(reportW.testResults).toHaveLength(1);

      // --- (c): changing the sibling x.ts (no edge to t.test.ts) selects
      // ONLY u.test.ts — proving specificity, not an accidental full-suite
      // fallback that would trivially include t.test.ts too.
      writeBlindChannelConfig(tmp, { changedFiles: [xPath] });
      const reportX = await runVitest(tmp, pluginEnv);
      const namesX = reportX.testResults.map((r) => r.name);
      expect(namesX.some((n) => n.includes('u.test.ts'))).toBe(true);
      expect(namesX.some((n) => n.includes('t.test.ts'))).toBe(false);
      expect(namesX.some((n) => n.includes('s.test.ts'))).toBe(false);
      expect(reportX.testResults).toHaveLength(1);

      // --- (d): the SAME w.txt diff as above, this time with s.test.ts
      // declared in alwaysRunTests -> s.test.ts is unioned into the
      // selective run alongside the BFS-selected t.test.ts.
      writeBlindChannelConfig(tmp, { changedFiles: [wPath], alwaysRunTests: [sPath] });
      const reportD = await runVitest(tmp, pluginEnv);
      const namesD = reportD.testResults.map((r) => r.name);
      expect(namesD.some((n) => n.includes('t.test.ts'))).toBe(true);
      expect(namesD.some((n) => n.includes('s.test.ts'))).toBe(true);
      expect(namesD.some((n) => n.includes('u.test.ts'))).toBe(false);
      expect(reportD.testResults).toHaveLength(2);
    },
    120_000,
  );
});

// ===========================================================================
// PART 2 — alwaysRunTests dedicated unit suite (mock-context style, mirrors
// test/plugin.test.ts + test/_helpers.ts's createMockContext/runHook idiom).
// The 3 sibling cases already in test/plugin.test.ts's 'alwaysRunTests
// option' describe block are a different layer (feature-landing coverage);
// this file is the DEDICATED, exhaustive suite for the option. Overlap is
// intentional — neither file's cases are deleted.
// ===========================================================================

const tempDirs: string[] = [];

let savedDisabledEnv: string | undefined;

beforeEach(() => {
  savedDisabledEnv = process.env.VITEST_AFFECTED_DISABLED;
  delete process.env.VITEST_AFFECTED_DISABLED;
});

afterEach(() => {
  if (savedDisabledEnv !== undefined) {
    process.env.VITEST_AFFECTED_DISABLED = savedDisabledEnv;
  } else {
    delete process.env.VITEST_AFFECTED_DISABLED;
  }
  cleanupTempDirs(tempDirs);
});

/**
 * Standard alwaysRunTests fixture: src/main.ts -> tests/main.test.ts (cached
 * edge), src/orphan.ts (no edges — drives the allowNoTests path), and
 * tests/always.test.ts (the alwaysRunTests subject, no edges of its own).
 */
function setupAlwaysRunFixture(): {
  tmpDir: string;
  mainPath: string;
  testPath: string;
  orphanPath: string;
  alwaysPath: string;
} {
  const tmpDir = makeTempDir(tempDirs, 'vitest-affected-bcc-alwaysrun-');

  mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
  mkdirSync(path.join(tmpDir, 'tests'), { recursive: true });

  writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}');
  writeFileSync(path.join(tmpDir, 'src', 'main.ts'), 'export const main = 1;\n');
  writeFileSync(path.join(tmpDir, 'src', 'orphan.ts'), 'export const orphan = 1;\n');

  const testPath = path.join(tmpDir, 'tests', 'main.test.ts');
  writeFileSync(
    testPath,
    'import { main } from "../src/main";\nimport { test, expect } from "vitest";\ntest("main", () => expect(main).toBe(1));\n',
  );

  const alwaysPath = path.join(tmpDir, 'tests', 'always.test.ts');
  writeFileSync(
    alwaysPath,
    'import { test, expect } from "vitest";\ntest("always", () => expect(1).toBe(1));\n',
  );

  const cacheDir = path.join(tmpDir, '.vitest-affected');
  const reverse = new Map<string, Set<string>>();
  reverse.set(path.join(tmpDir, 'src', 'main.ts'), new Set([testPath]));
  saveCacheSync(cacheDir, reverse);

  return {
    tmpDir,
    mainPath: path.join(tmpDir, 'src', 'main.ts'),
    testPath,
    orphanPath: path.join(tmpDir, 'src', 'orphan.ts'),
    alwaysPath,
  };
}

// ---------------------------------------------------------------------------
// Case 1 — union dedups an alwaysRun test already BFS-selected
// ---------------------------------------------------------------------------

describe('Case 1 — union dedups an alwaysRun test already BFS-selected', () => {
  test('the same test appears exactly once in include, never duplicated', async () => {
    const { tmpDir, mainPath, testPath } = setupAlwaysRunFixture();
    const { vitest, project, projectConfig } = createMockContext(tmpDir);

    await runHook(
      vitestAffected({
        changedFiles: [mainPath],
        cache: true,
        alwaysRunTests: [testPath], // same test the BFS already selects
      }),
      { vitest, project },
    );

    expect(projectConfig.include).toEqual([testPath]);
  });
});

// ---------------------------------------------------------------------------
// Case 2 — allowNoTests + zero affected: include becomes the alwaysRun list
// ---------------------------------------------------------------------------

describe('Case 2 — allowNoTests + zero affected: include becomes the alwaysRun list, not []', () => {
  test('the allow-no-tests write site unions in alwaysRunTests instead of an empty include', async () => {
    const { tmpDir, orphanPath, alwaysPath } = setupAlwaysRunFixture();
    const { vitest, project, projectConfig } = createMockContext(tmpDir);

    await runHook(
      vitestAffected({
        allowNoTests: true,
        changedFiles: [orphanPath], // no graph edges -> zero BFS-affected tests
        cache: true,
        alwaysRunTests: [alwaysPath],
      }),
      { vitest, project },
    );

    expect(projectConfig.include).toEqual([alwaysPath]);
  });
});

// ---------------------------------------------------------------------------
// Case 3 — running an alwaysRun test produces no selection-mismatch heartbeat
// ---------------------------------------------------------------------------

describe('Case 3 — running an alwaysRun test produces NO selection-mismatch heartbeat', () => {
  test('setSelectedTests recorded the union, so self-verify does not flag the always-run entry', async () => {
    const { tmpDir, mainPath, testPath, alwaysPath } = setupAlwaysRunFixture();
    const statsFile = path.join(tmpDir, 'stats.jsonl');
    const { vitest, project } = createMockContext(tmpDir);

    await runHook(
      vitestAffected({
        changedFiles: [mainPath],
        cache: true,
        statsFile,
        alwaysRunTests: [alwaysPath],
      }),
      { vitest, project },
    );

    const reporter = (vitest.reporters as Reporter[]).find(
      (r) => typeof r.onTestRunEnd === 'function',
    )!;
    const mainMod = createMockTestModule(testPath, {});
    const alwaysMod = createMockTestModule(alwaysPath, {});
    reporter.onTestModuleEnd!(mainMod);
    reporter.onTestModuleEnd!(alwaysMod);
    reporter.onTestRunEnd!([mainMod, alwaysMod], [], 'passed' as TestRunEndReason);

    const mismatches = readStats(statsFile).filter((l) => l.reason === 'selection-mismatch');
    expect(mismatches).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Case 4 — relative alwaysRunTests entry canonicalizes against rootDir
// through a symlinked root (mirrors plugin.test.ts's symlinked-rootDir test)
// ---------------------------------------------------------------------------

describe('Case 4 — a relative alwaysRunTests path canonicalizes against rootDir through a symlink', () => {
  test('relative resolution and symlink canonicalization both converge on the real always-run test', async () => {
    const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'vitest-affected-bcc-symlink-')));
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
    const canonicalAlways = path.join(realDir, 'tests', 'always.test.ts');
    writeFileSync(
      canonicalAlways,
      'import { test, expect } from "vitest";\ntest("always", () => expect(1).toBe(1));\n',
    );

    const reverse = new Map<string, Set<string>>();
    reverse.set(path.join(realDir, 'src', 'main.ts'), new Set([canonicalTest]));
    saveCacheSync(path.join(realDir, '.vitest-affected'), reverse);

    // Everything the plugin RECEIVES goes through the alias.
    const aliasDir = path.join(base, 'alias');
    symlinkSync(realDir, aliasDir, 'dir');

    const plugin = vitestAffected({
      changedFiles: [path.join(aliasDir, 'src', 'main.ts')],
      cache: true,
      // RELATIVE path, resolved against rootDir (the alias, per vitest.config.root)
      alwaysRunTests: ['tests/always.test.ts'],
    });
    const { vitest, project, projectConfig } = createMockContext(aliasDir);

    await runHook(plugin, { vitest, project });

    // Both the BFS-selected test and the relative always-run entry must land
    // on their CANONICAL (real-project) paths — no alias-path variant, no
    // missing-path fallback.
    expect(new Set(projectConfig.include)).toEqual(new Set([canonicalTest, canonicalAlways]));
  });
});

// ---------------------------------------------------------------------------
// Case 5 — a full-suite decision leaves alwaysRunTests as a no-op
// ---------------------------------------------------------------------------

describe('Case 5 — a full-suite decision leaves alwaysRunTests as a no-op', () => {
  test('cache-miss fallback: include is untouched and the decision reason is unaffected', async () => {
    const tmpDir = makeTempDir(tempDirs, 'vitest-affected-bcc-fullsuite-');
    mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    mkdirSync(path.join(tmpDir, 'tests'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}');
    writeFileSync(path.join(tmpDir, 'src', 'main.ts'), 'export const main = 1;\n');
    const alwaysPath = path.join(tmpDir, 'tests', 'always.test.ts');
    writeFileSync(
      alwaysPath,
      'import { test, expect } from "vitest";\ntest("always", () => expect(1).toBe(1));\n',
    );
    // Deliberately NO cache written -> cache-miss full-suite path.

    const statsFile = path.join(tmpDir, 'stats.jsonl');
    const { vitest, project, projectConfig } = createMockContext(tmpDir);
    const original = [...projectConfig.include];

    await runHook(
      vitestAffected({
        changedFiles: [path.join(tmpDir, 'src', 'main.ts')],
        cache: true,
        statsFile,
        alwaysRunTests: [alwaysPath],
      }),
      { vitest, project },
    );

    // Full-suite fallback: include untouched, alwaysRunTests never unioned in
    // (the option is exempt from the ratio gate, not from the decision itself).
    expect(projectConfig.include).toEqual(original);
    const lines = readStats(statsFile);
    expect(lines).toHaveLength(1);
    expect(lines[0].action).toBe('full-suite');
    expect(lines[0].reason).toBe('cache-miss');
  });
});

// ---------------------------------------------------------------------------
// Case 6 — shadow mode reflects the union in selectedFiles without mutating include
// ---------------------------------------------------------------------------

describe('Case 6 — shadow mode reflects the union in selectedFiles without mutating include', () => {
  test('shadow-selective decision carries both the BFS test and the always-run test in selectedFiles', async () => {
    const { tmpDir, mainPath, testPath, alwaysPath } = setupAlwaysRunFixture();
    const statsFile = path.join(tmpDir, 'stats.jsonl');
    const { vitest, project, projectConfig } = createMockContext(tmpDir);
    const original = [...projectConfig.include];

    await runHook(
      vitestAffected({
        shadow: true,
        changedFiles: [mainPath],
        cache: true,
        statsFile,
        alwaysRunTests: [alwaysPath],
      }),
      { vitest, project },
    );

    // Mutation site guarded: include stays the full-suite pattern.
    expect(projectConfig.include).toEqual(original);

    const line = lastStat(statsFile);
    expect(line.action).toBe('shadow-selective');
    expect(new Set(line.selectedFiles as string[])).toEqual(new Set([testPath, alwaysPath]));
  });
});

// ---------------------------------------------------------------------------
// Case 7 — a missing alwaysRunTests path warns and falls back to the full suite
// ---------------------------------------------------------------------------

describe('Case 7 — a missing alwaysRunTests path warns and falls back to the full suite', () => {
  test('reason is always-run-config-error, console.warn fires, exactly one decision line is written', async () => {
    const { tmpDir, mainPath } = setupAlwaysRunFixture();
    const statsFile = path.join(tmpDir, 'stats.jsonl');
    const { vitest, project, projectConfig } = createMockContext(tmpDir);
    const original = [...projectConfig.include];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await runHook(
        vitestAffected({
          changedFiles: [mainPath],
          cache: true,
          statsFile,
          alwaysRunTests: [path.join(tmpDir, 'tests', 'does-not-exist.test.ts')],
        }),
        { vitest, project },
      );

      // Full-suite fallback: include is left untouched.
      expect(projectConfig.include).toEqual(original);

      expect(warnSpy).toHaveBeenCalled();
      expect(
        warnSpy.mock.calls.some((call) => String(call[0]).includes('alwaysRunTests')),
      ).toBe(true);

      const lines = readStats(statsFile);
      expect(lines).toHaveLength(1);
      expect(lines[0].action).toBe('full-suite');
      expect(lines[0].reason).toBe('always-run-config-error');
    } finally {
      warnSpy.mockRestore();
    }
  });
});
