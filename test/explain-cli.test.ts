/// <reference types="vitest/config" />
//
// Surface tests for the shipped `vitest-affected-explain` bin (src/explain-cli.ts,
// built to dist/explain-cli.js). That entry is a pure side-effect module — it
// exports nothing and runs `main()` on import — so `printResult` cannot be
// imported without executing the CLI. We therefore exercise it by SPAWNING the
// built bin and asserting its argv / exit-code / output surface, including one
// end-to-end SELECTED run that locks the real multi-line output shape the README
// documents.
import { describe, test, expect, afterEach, beforeAll } from 'vitest';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execa } from 'execa';
import { saveCacheSync } from '../src/graph/cache.js';
import { makeTempDir, cleanupTempDirs } from './_helpers.js';

const projectRoot = path.resolve(import.meta.dirname, '..');
const BIN = path.join(projectRoot, 'dist', 'explain-cli.js');

const tempDirs: string[] = [];

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

/** Run the built bin. `reject: false` so non-zero exits are inspected, not thrown. */
function runBin(args: string[], cwd?: string) {
  return execa('node', [BIN, ...args], {
    cwd: cwd ?? projectRoot,
    reject: false,
  });
}

beforeAll(async () => {
  // dist/ is normally already built by the quality gate; build defensively so a
  // cold checkout still has the bin this test spawns.
  await execa('npm', ['run', 'build'], { cwd: projectRoot });
}, 60_000);

// ===========================================================================
// (1) ARGV / EXIT-CODE SURFACE.
// ===========================================================================

describe('vitest-affected-explain bin — argv/exit surface', () => {
  test('no argument → exit 2 and prints usage', async () => {
    const r = await runBin([]);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain('usage: vitest-affected-explain');
  });

  test('--help → exit 0 and prints usage', async () => {
    const r = await runBin(['--help']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('usage: vitest-affected-explain');
  });

  test('-h → exit 0 and prints usage', async () => {
    const r = await runBin(['-h']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('usage: vitest-affected-explain');
  });

  test('cache miss → reports no usable cache and exits 0', async () => {
    // A temp dir with no .vitest-affected/ cache. The bin returns after the
    // cache-miss branch (before touching git), so no repo setup is needed.
    const tmp = makeTempDir(tempDirs, 'vitest-affected-explain-cli-');
    const r = await runBin(['test/whatever.test.ts'], tmp);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('No usable dependency cache');
    expect(r.stdout).toContain('the FULL suite would run');
  });
});

// ===========================================================================
// (2) END-TO-END SELECTED OUTPUT — locks the documented multi-line shape.
// ===========================================================================

describe('vitest-affected-explain bin — SELECTED output shape', () => {
  test('a changed source that reaches the test prints the SELECTED block', async () => {
    const tmp = makeTempDir(tempDirs, 'vitest-affected-explain-sel-');
    mkdirSync(path.join(tmp, 'src'), { recursive: true });
    mkdirSync(path.join(tmp, 'test'), { recursive: true });
    const mainPath = path.join(tmp, 'src', 'main.ts');
    const testPath = path.join(tmp, 'test', 'main.test.ts');
    writeFileSync(mainPath, 'export const main = 1;\n');
    writeFileSync(
      testPath,
      'import { main } from "../src/main";\nimport { test, expect } from "vitest";\ntest("main", () => expect(main).toBe(1));\n',
    );

    // Warm cache: main.ts → main.test.ts reverse edge.
    const reverse = new Map<string, Set<string>>([[mainPath, new Set([testPath])]]);
    saveCacheSync(path.join(tmp, '.vitest-affected'), reverse);

    // Git repo so getChangedFiles has a work tree; commit, then modify main.ts
    // so it shows up as an unstaged change (a BFS seed).
    await execa('git', ['init', '-q'], { cwd: tmp });
    await execa('git', ['config', 'user.email', 'test@test.com'], { cwd: tmp });
    await execa('git', ['config', 'user.name', 'Test'], { cwd: tmp });
    await execa('git', ['add', '.'], { cwd: tmp });
    await execa('git', ['commit', '-qm', 'initial'], { cwd: tmp });
    writeFileSync(mainPath, 'export const main = 2;\n');

    const r = await runBin(['test/main.test.ts'], tmp);
    expect(r.exitCode).toBe(0);
    // Real printResult shape: SELECTED: <file> / why / seed / chain block.
    expect(r.stdout).toContain(`SELECTED: ${testPath}`);
    expect(r.stdout).toContain('why: reached from changed file');
    expect(r.stdout).toContain(`seed: ${mainPath}`);
    expect(r.stdout).toContain('chain:');
    expect(r.stdout).toContain(mainPath);
    expect(r.stdout).toContain('↳');
  });
});
