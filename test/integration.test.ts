/// <reference types="vitest/config" />
import { describe, test, expect, beforeAll, afterEach } from 'vitest';
import path from 'node:path';
import {
  mkdtempSync,
  cpSync,
  symlinkSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { execa } from 'execa';

const projectRoot = path.resolve(import.meta.dirname, '..');
const distPath = path.join(projectRoot, 'dist', 'index.js');
const distUrl = pathToFileURL(distPath).href;

// Track temp dirs for cleanup
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
  tempDirs.length = 0;
});

/** Vitest JSON reporter result shape */
interface VitestJsonReport {
  testResults: Array<{ name: string; status: string }>;
  success: boolean;
}

/**
 * Copy a fixture to a temp dir, symlink node_modules, and write a vitest.config.ts
 * that loads the built plugin via file:// URL.
 */
function setupFixture(fixtureName: string): string {
  const src = path.join(import.meta.dirname, 'fixtures', fixtureName);
  const tmp = mkdtempSync(
    path.join(tmpdir(), `vitest-affected-${fixtureName}-`),
  );
  tempDirs.push(tmp);
  cpSync(src, tmp, { recursive: true });

  // Symlink node_modules so vitest + plugin are resolvable
  symlinkSync(
    path.join(projectRoot, 'node_modules'),
    path.join(tmp, 'node_modules'),
  );

  // Generate vitest.config.ts with absolute file:// import for Windows compat
  writeFileSync(
    path.join(tmp, 'vitest.config.ts'),
    `
import { defineConfig } from 'vitest/config';
import { vitestAffected } from '${distUrl}';
export default defineConfig({
  plugins: [vitestAffected({ verbose: true })],
  test: { include: ['tests/**/*.test.ts'] },
});
`,
  );

  return tmp;
}

/**
 * Initialize a git repo in the given directory with an initial commit.
 */
async function gitInit(cwd: string): Promise<void> {
  await execa('git', ['init'], { cwd });
  await execa('git', ['config', 'user.email', 'test@test.com'], { cwd });
  await execa('git', ['config', 'user.name', 'Test'], { cwd });
  await execa('git', ['add', '.'], { cwd });
  await execa('git', ['commit', '-m', 'initial'], { cwd });
}

/**
 * Run vitest with JSON reporter in the given directory.
 * Returns the parsed JSON report.
 * Vitest's --reporter=json writes JSON to stdout.
 */
async function runVitest(
  cwd: string,
  env: Record<string, string> = {},
): Promise<VitestJsonReport> {
  const result = await execa(
    'npx',
    ['vitest', 'run', '--reporter=json'],
    {
      cwd,
      env: { ...process.env, ...env },
      reject: false,
    },
  );

  // Vitest JSON reporter writes to stdout
  let report: VitestJsonReport;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    // Fallback: maybe JSON is in stderr
    try {
      report = JSON.parse(result.stderr);
    } catch {
      throw new Error(
        `Failed to parse Vitest JSON output.\nstdout: ${result.stdout}\nstderr: ${result.stderr}\nexitCode: ${result.exitCode}`,
      );
    }
  }
  return report;
}

beforeAll(async () => {
  await execa('npm', ['run', 'build'], { cwd: projectRoot });
}, 60_000);

describe('integration: plugin orchestration', () => {
  /**
   * Test 1: First run (no cache) → full suite, populates cache.
   * Second run → selective (uses cached runtime graph).
   *
   * With the runtime-first architecture, the first run always runs full suite
   * because there's no cached reverse map. The runtime reporter populates the
   * cache. The second run then uses the cache for selective execution.
   */
  test(
    'first run populates cache, second run selects tests',
    async () => {
      const tmp = setupFixture('simple');
      await gitInit(tmp);

      // Modify src/c.ts (leaf in simple fixture) — unstaged change
      writeFileSync(
        path.join(tmp, 'src', 'c.ts'),
        'export const c = 42;\n',
      );

      const pluginEnv = { VITEST_AFFECTED_DISABLED: '0' };

      // First run: no cache → full suite → runtime reporter writes v2 cache
      const report1 = await runVitest(tmp, pluginEnv);
      const testFiles1 = report1.testResults.map((r) => r.name);
      // Full suite: all tests run (simple fixture has 1 test)
      expect(testFiles1.some((f) => f.includes('a.test.ts'))).toBe(true);

      // Verify cache file was created with v2 format
      const cacheFile = path.join(tmp, '.vitest-affected', 'graph.json');
      expect(existsSync(cacheFile)).toBe(true);
      const cache = JSON.parse(readFileSync(cacheFile, 'utf-8')) as {
        version: number;
      };
      expect(cache.version).toBe(2);

      // Second run: cache hit → selective execution
      const report2 = await runVitest(tmp, pluginEnv);
      const testFiles2 = report2.testResults.map((r) => r.name);
      expect(testFiles2.some((f) => f.includes('a.test.ts'))).toBe(true);
      expect(testFiles2).toHaveLength(1);
    },
    30_000,
  );

  /**
   * Test 2: Full suite on no changes
   * No git changes → all tests run (plugin returns early, config.include unchanged)
   * Uses diamond fixture (2 test files) so full suite is distinguishable from filtered.
   */
  test(
    'full suite on no changes: clean git state → all tests run',
    async () => {
      const tmp = setupFixture('diamond');
      await gitInit(tmp);

      // No changes after initial commit — plugin should fall back to full suite
      const report = await runVitest(tmp);
      const testFiles = report.testResults.map((r) => r.name);

      // Diamond fixture has 2 test files — both must run (full suite)
      expect(testFiles).toHaveLength(2);
    },
    30_000,
  );

  /**
   * Test 3: changedFiles option with pre-populated cache → selective
   */
  test(
    'changedFiles option with cache: selective test execution',
    async () => {
      const tmp = setupFixture('simple');
      await gitInit(tmp);

      const pluginEnv = { VITEST_AFFECTED_DISABLED: '0' };

      // First run: populate the cache (full suite)
      await runVitest(tmp, pluginEnv);

      // Verify cache exists
      const cacheFile = path.join(tmp, '.vitest-affected', 'graph.json');
      expect(existsSync(cacheFile)).toBe(true);

      // Now write config with changedFiles pointing to src/c.ts
      const changedFile = path.join(tmp, 'src', 'c.ts');
      writeFileSync(
        path.join(tmp, 'vitest.config.ts'),
        `
import { defineConfig } from 'vitest/config';
import { vitestAffected } from '${distUrl}';
export default defineConfig({
  plugins: [vitestAffected({ verbose: true, changedFiles: ['${changedFile}'] })],
  test: { include: ['tests/**/*.test.ts'] },
});
`,
      );

      // Second run: uses cached graph + changedFiles → selective
      const report = await runVitest(tmp, pluginEnv);
      const testFiles = report.testResults.map((r) => r.name);

      expect(testFiles.some((f) => f.includes('a.test.ts'))).toBe(true);
      expect(testFiles).toHaveLength(1);
    },
    30_000,
  );

  /**
   * Test 4: changedFiles with non-existing path (deletion)
   * Mix existing + non-existing → deleted file used as BFS seed.
   */
  test(
    'changedFiles with non-existing path: deleted file as BFS seed',
    async () => {
      const tmp = setupFixture('diamond');
      await gitInit(tmp);

      const pluginEnv = { VITEST_AFFECTED_DISABLED: '0' };

      // First run: populate cache
      await runVitest(tmp, pluginEnv);

      const existingFile = path.join(tmp, 'src', 'c.ts');
      const deletedFile = path.join(tmp, 'src', 'nonexistent.ts');

      // Write config with mixed existing + non-existing changedFiles
      writeFileSync(
        path.join(tmp, 'vitest.config.ts'),
        `
import { defineConfig } from 'vitest/config';
import { vitestAffected } from '${distUrl}';
export default defineConfig({
  plugins: [vitestAffected({ verbose: true, changedFiles: ['${existingFile}', '${deletedFile}'] })],
  test: { include: ['tests/**/*.test.ts'] },
});
`,
      );

      const report = await runVitest(tmp, pluginEnv);
      const testFiles = report.testResults.map((r) => r.name);

      // c.ts is shared dep in diamond — both tests affected.
      expect(testFiles).toHaveLength(2);
      expect(testFiles.some((f) => f.includes('a.test.ts'))).toBe(true);
      expect(testFiles.some((f) => f.includes('b.test.ts'))).toBe(true);
    },
    30_000,
  );

  /**
   * Test 4b: Deleted files outside the graph don't trigger full suite
   */
  test(
    'deleted files outside graph are ignored: only changed source tests run',
    async () => {
      const tmp = setupFixture('simple');
      await gitInit(tmp);

      const pluginEnv = { VITEST_AFFECTED_DISABLED: '0' };

      // First run: populate cache
      await runVitest(tmp, pluginEnv);

      // Create and commit an unrelated file, then delete it
      writeFileSync(path.join(tmp, 'docs.md'), '# Docs\n');
      await execa('git', ['add', '.'], { cwd: tmp });
      await execa('git', ['commit', '-m', 'add docs'], { cwd: tmp });
      rmSync(path.join(tmp, 'docs.md'));

      // Also change src/c.ts (leaf in simple fixture)
      writeFileSync(
        path.join(tmp, 'src', 'c.ts'),
        'export const c = 42;\n',
      );

      // Second run: cache hit → selective
      const report = await runVitest(tmp, pluginEnv);
      const testFiles = report.testResults.map((r) => r.name);

      // docs.md is not in the dep graph — deletion is a no-op BFS seed
      // Only src/c.ts change matters → only a.test.ts runs
      expect(testFiles.some((f) => f.includes('a.test.ts'))).toBe(true);
      expect(testFiles).toHaveLength(1);
    },
    30_000,
  );

  /**
   * Test 5: config.include absolute paths regression
   * Change src/c.ts in diamond fixture → both a.test.ts and b.test.ts should run
   */
  test(
    'config.include absolute paths: both tests in diamond run when shared dep changes',
    async () => {
      const tmp = setupFixture('diamond');
      await gitInit(tmp);

      const pluginEnv = { VITEST_AFFECTED_DISABLED: '0' };

      // First run: populate cache
      await runVitest(tmp, pluginEnv);

      // Change src/c.ts in diamond fixture (shared by both test chains)
      writeFileSync(
        path.join(tmp, 'src', 'c.ts'),
        'export const c = 99;\n',
      );

      // Second run: cache hit → selective
      const report = await runVitest(tmp, pluginEnv);
      const testFiles = report.testResults.map((r) => r.name);

      // Both a.test.ts and b.test.ts depend on c.ts transitively
      expect(testFiles.some((f) => f.includes('a.test.ts'))).toBe(true);
      expect(testFiles.some((f) => f.includes('b.test.ts'))).toBe(true);
    },
    30_000,
  );

  /**
   * Test 6: Cache file created after first run with v2 format
   * Run vitest → verify .vitest-affected/graph.json is created with version: 2
   */
  test(
    'cache persistence: graph.json exists after first run with v2 format',
    async () => {
      const tmp = setupFixture('simple');
      await gitInit(tmp);

      // Modify src/c.ts (unstaged change)
      writeFileSync(
        path.join(tmp, 'src', 'c.ts'),
        'export const c = 42;\n',
      );

      const pluginEnv = { VITEST_AFFECTED_DISABLED: '0' };

      // First run — populates cache
      const report1 = await runVitest(tmp, pluginEnv);
      expect(report1.testResults.length).toBeGreaterThan(0);

      // Verify cache file was created with v2 format
      const cacheFile = path.join(tmp, '.vitest-affected', 'graph.json');
      expect(existsSync(cacheFile)).toBe(true);
      const cache = JSON.parse(readFileSync(cacheFile, 'utf-8')) as {
        version: number;
        reverseMap?: Record<string, string[]>;
      };
      expect(cache.version).toBe(2);
      expect(typeof cache.reverseMap).toBe('object');
    },
    30_000,
  );

  /**
   * Test 7: Corrupt cache graceful recovery
   * Write invalid JSON to graph.json → first run falls back to full suite (cache miss).
   * Runtime reporter overwrites with valid v2 cache.
   */
  test(
    'cache recovery: corrupt graph.json triggers full suite, then cache is repopulated',
    async () => {
      const tmp = setupFixture('diamond');
      await gitInit(tmp);

      // Write corrupt JSON to the cache file before the first run
      mkdirSync(path.join(tmp, '.vitest-affected'), { recursive: true });
      writeFileSync(
        path.join(tmp, '.vitest-affected', 'graph.json'),
        '{{corrupt json',
      );

      // Modify src/c.ts (shared dep in diamond fixture)
      writeFileSync(
        path.join(tmp, 'src', 'c.ts'),
        'export const c = 99;\n',
      );

      const pluginEnv = { VITEST_AFFECTED_DISABLED: '0' };

      // First run: corrupt cache → cache miss → full suite
      const report = await runVitest(tmp, pluginEnv);
      const testFiles = report.testResults.map((r) => r.name);

      // Full suite: both tests run
      expect(testFiles.some((f) => f.includes('a.test.ts'))).toBe(true);
      expect(testFiles.some((f) => f.includes('b.test.ts'))).toBe(true);

      // Verify cache was repopulated with v2 format
      const cacheFile = path.join(tmp, '.vitest-affected', 'graph.json');
      const cache = JSON.parse(readFileSync(cacheFile, 'utf-8')) as { version: number };
      expect(cache.version).toBe(2);
    },
    30_000,
  );

  /**
   * Test 8: Two-run workflow with changedFiles
   * First run: populate cache. Second run: selective via cached graph.
   */
  test(
    'cache with changedFiles: second run uses cached graph',
    async () => {
      const tmp = setupFixture('simple');
      await gitInit(tmp);

      const pluginEnv = { VITEST_AFFECTED_DISABLED: '0' };

      // First run: populate cache (full suite — no cache yet)
      await runVitest(tmp, pluginEnv);

      // Verify cache file was created
      const cacheFile = path.join(tmp, '.vitest-affected', 'graph.json');
      expect(existsSync(cacheFile)).toBe(true);

      const changedFile = path.join(tmp, 'src', 'c.ts');

      // Write config with explicit changedFiles
      writeFileSync(
        path.join(tmp, 'vitest.config.ts'),
        `
import { defineConfig } from 'vitest/config';
import { vitestAffected } from '${distUrl}';
export default defineConfig({
  plugins: [vitestAffected({ verbose: true, cache: true, changedFiles: ['${changedFile}'] })],
  test: { include: ['tests/**/*.test.ts'] },
});
`,
      );

      // Second run — uses cached graph, selects tests/a.test.ts
      const report = await runVitest(tmp, pluginEnv);
      const testFiles = report.testResults.map((r) => r.name);
      expect(testFiles.some((f) => f.includes('a.test.ts'))).toBe(true);
      expect(testFiles).toHaveLength(1);
    },
    30_000,
  );
});
