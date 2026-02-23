/// <reference types="vitest/config" />
import { describe, test, expect, beforeAll, afterEach } from 'vitest';
import path from 'node:path';
import {
  mkdtempSync,
  cpSync,
  symlinkSync,
  writeFileSync,
  rmSync,
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
   * Test 1: Basic filtering
   * Change src/c.ts in simple fixture → only tests/a.test.ts runs
   * (simple: tests/a.test.ts → src/a.ts → src/b.ts → src/c.ts)
   */
  test(
    'basic filtering: change src/c.ts → only tests/a.test.ts runs',
    async () => {
      const tmp = setupFixture('simple');
      await gitInit(tmp);

      // Modify src/c.ts (leaf in simple fixture) — unstaged change
      writeFileSync(
        path.join(tmp, 'src', 'c.ts'),
        'export const c = 42;\n',
      );

      const report = await runVitest(tmp);
      const testFiles = report.testResults.map((r) => r.name);

      // Only tests/a.test.ts should have run (it's the only test that imports c transitively)
      expect(testFiles.some((f) => f.includes('a.test.ts'))).toBe(true);
      expect(testFiles).toHaveLength(1);
    },
    30_000,
  );

  /**
   * Test 2: Full suite on no changes
   * No git changes → all tests run (plugin returns early, config.include unchanged)
   */
  test(
    'full suite on no changes: clean git state → all tests run',
    async () => {
      const tmp = setupFixture('simple');
      await gitInit(tmp);

      // No changes after initial commit — plugin should fall back to full suite
      const report = await runVitest(tmp);
      const testFiles = report.testResults.map((r) => r.name);

      // Simple fixture has only 1 test file, and full suite means it runs
      expect(testFiles.length).toBeGreaterThanOrEqual(1);
    },
    30_000,
  );

  /**
   * Test 3: changedFiles option bypass
   * Provide changedFiles directly → correct test selected
   */
  test(
    'changedFiles option: providing absolute path triggers correct test selection',
    async () => {
      const tmp = setupFixture('simple');
      await gitInit(tmp);

      // Write a vitest.config.ts that passes changedFiles directly (src/c.ts is the leaf)
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

      const report = await runVitest(tmp);
      const testFiles = report.testResults.map((r) => r.name);

      // tests/a.test.ts should be selected (c.ts is in its transitive deps)
      expect(testFiles.some((f) => f.includes('a.test.ts'))).toBe(true);
      expect(testFiles).toHaveLength(1);
    },
    30_000,
  );

  /**
   * Test 4: changedFiles with non-existing path (deletion)
   * Mix existing + non-existing → deletion triggers full suite
   */
  test(
    'changedFiles with non-existing path triggers full suite (deletion fallback)',
    async () => {
      const tmp = setupFixture('simple');
      await gitInit(tmp);

      const existingFile = path.join(tmp, 'src', 'c.ts');
      const deletedFile = path.join(tmp, 'src', 'nonexistent.ts');

      // Write a vitest.config.ts with mixed existing + non-existing changedFiles
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

      const report = await runVitest(tmp);
      const testFiles = report.testResults.map((r) => r.name);

      // Full suite runs because deleted file triggers fallback:
      // simple fixture has 1 test file
      expect(testFiles.length).toBeGreaterThanOrEqual(1);
    },
    30_000,
  );

  /**
   * Test 5: config.include absolute paths regression
   * Change src/c.ts in diamond fixture → both a.test.ts and b.test.ts should run
   * Verifies that assigning absolute paths to config.include works correctly.
   */
  test(
    'config.include absolute paths: both tests in diamond run when shared dep changes',
    async () => {
      const tmp = setupFixture('diamond');
      await gitInit(tmp);

      // Change src/c.ts in diamond fixture (shared by both test chains)
      // Diamond: a.test.ts → src/a.ts → {src/b.ts, src/d.ts} → src/c.ts
      //          b.test.ts → src/b.ts → src/c.ts
      writeFileSync(
        path.join(tmp, 'src', 'c.ts'),
        'export const c = 99;\n',
      );

      const report = await runVitest(tmp);
      const testFiles = report.testResults.map((r) => r.name);

      // Both a.test.ts and b.test.ts depend on c.ts transitively
      expect(testFiles.some((f) => f.includes('a.test.ts'))).toBe(true);
      expect(testFiles.some((f) => f.includes('b.test.ts'))).toBe(true);
    },
    30_000,
  );
});
