/// <reference types="vitest/config" />
import { describe, test, expect, afterEach } from 'vitest';
import path from 'node:path';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { execa } from 'execa';

import {
  isSkipTriggeringFile,
  classifyCommit,
  shouldReinstall,
  getFirstParentChain,
  getCommitChangedFiles,
} from '../tools/replay/walker.js';
import {
  resolveWorkdirRoot,
  symlinkDist,
  cloneConsumer,
  createRunDir,
  CONSUMER_DIRNAME,
} from '../tools/replay/workdir.js';
import {
  buildRunEnv,
  parseShadowStatsLine,
  setRefToParent,
} from '../tools/replay/exec.js';
import { parseArgs, USAGE, resolveDistPath } from '../tools/replay/run.js';

// ---------------------------------------------------------------------------
// Temp-dir bookkeeping (mirrors integration.test.ts).
// ---------------------------------------------------------------------------
const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
  tempDirs.length = 0;
});

function tmp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

/** Init a git repo with an initial commit (mirrors integration.test.ts). */
async function gitInit(cwd: string): Promise<void> {
  await execa('git', ['init'], { cwd });
  await execa('git', ['config', 'user.email', 'test@test.com'], { cwd });
  await execa('git', ['config', 'user.name', 'Test'], { cwd });
  await execa('git', ['config', 'commit.gpgsign', 'false'], { cwd });
  await execa('git', ['checkout', '-b', 'main'], { cwd });
}

async function commitFile(
  cwd: string,
  file: string,
  content: string,
  msg: string,
): Promise<string> {
  const full = path.join(cwd, file);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
  await execa('git', ['add', '.'], { cwd });
  await execa('git', ['commit', '-m', msg], { cwd });
  const { stdout } = await execa('git', ['rev-parse', 'HEAD'], { cwd });
  return stdout.trim();
}

// ===========================================================================
// walker — classification
// ===========================================================================
describe('walker: commit classification', () => {
  test('isSkipTriggeringFile flags lockfile and config files', () => {
    expect(isSkipTriggeringFile('pnpm-lock.yaml')).toBe(true);
    expect(isSkipTriggeringFile('package.json')).toBe(true);
    expect(isSkipTriggeringFile('vitest.config.mts')).toBe(true);
    expect(isSkipTriggeringFile('vitest.config.ts')).toBe(true);
    expect(isSkipTriggeringFile('tsconfig.json')).toBe(true);
    expect(isSkipTriggeringFile('tsconfig.build.json')).toBe(true);
    // Nested paths classify on basename.
    expect(isSkipTriggeringFile('packages/app/package.json')).toBe(true);
  });

  test('isSkipTriggeringFile ignores ordinary source and test files', () => {
    expect(isSkipTriggeringFile('src/foo.ts')).toBe(false);
    expect(isSkipTriggeringFile('test/foo.test.ts')).toBe(false);
    expect(isSkipTriggeringFile('README.md')).toBe(false);
    expect(isSkipTriggeringFile('src/config.ts')).toBe(false);
  });

  test('classifyCommit flags skip with itemized triggers', () => {
    const cls = classifyCommit('abc123', [
      'src/foo.ts',
      'pnpm-lock.yaml',
      'vitest.config.mts',
    ]);
    expect(cls.skip).toBe(true);
    expect(cls.skipTriggers).toEqual(['pnpm-lock.yaml', 'vitest.config.mts']);
    expect(cls.sha).toBe('abc123');
  });

  test('classifyCommit marks source-only commit ok', () => {
    const cls = classifyCommit('def456', ['src/a.ts', 'src/b.ts']);
    expect(cls.skip).toBe(false);
    expect(cls.skipTriggers).toEqual([]);
  });
});

// ===========================================================================
// walker — install policy
// ===========================================================================
describe('walker: install policy', () => {
  test('shouldReinstall true on first commit (no prior hash)', () => {
    expect(shouldReinstall(null, 'hash-a')).toBe(true);
  });

  test('shouldReinstall true when lockfile hash changed', () => {
    expect(shouldReinstall('hash-a', 'hash-b')).toBe(true);
  });

  test('shouldReinstall false when lockfile hash unchanged', () => {
    expect(shouldReinstall('hash-a', 'hash-a')).toBe(false);
  });
});

// ===========================================================================
// walker — first-parent chain + step-diff (synthetic repo)
// ===========================================================================
describe('walker: first-parent chain enumeration', () => {
  test('getFirstParentChain follows mainline and excludes feature commits', async () => {
    const repo = tmp('replay-chain-');
    await gitInit(repo);
    const a = await commitFile(repo, 'src/a.ts', 'a', 'A');
    const b = await commitFile(repo, 'src/b.ts', 'b', 'B');

    // Feature branch off B with two commits.
    await execa('git', ['checkout', '-b', 'feature'], { cwd: repo });
    await commitFile(repo, 'src/f1.ts', 'f1', 'F1');
    await commitFile(repo, 'src/f2.ts', 'f2', 'F2');

    // Back on main, one more commit, then a no-ff merge.
    await execa('git', ['checkout', 'main'], { cwd: repo });
    const c = await commitFile(repo, 'src/c.ts', 'c', 'C');
    await execa('git', ['merge', '--no-ff', 'feature', '-m', 'M'], {
      cwd: repo,
    });
    const { stdout: m } = await execa('git', ['rev-parse', 'HEAD'], {
      cwd: repo,
    });

    const chain = await getFirstParentChain(repo, `${a}..${m.trim()}`);
    // First-parent mainline (oldest -> newest): B, C, M. Feature commits excluded.
    expect(chain).toEqual([b, c, m.trim()]);
  });

  test('getCommitChangedFiles returns the step-diff (merge = whole PR delta)', async () => {
    const repo = tmp('replay-diff-');
    await gitInit(repo);
    const a = await commitFile(repo, 'src/a.ts', 'a', 'A');

    await execa('git', ['checkout', '-b', 'feature'], { cwd: repo });
    await commitFile(repo, 'src/f1.ts', 'f1', 'F1');
    await commitFile(repo, 'src/f2.ts', 'f2', 'F2');
    await execa('git', ['checkout', 'main'], { cwd: repo });
    await execa('git', ['merge', '--no-ff', 'feature', '-m', 'M'], {
      cwd: repo,
    });
    const { stdout: m } = await execa('git', ['rev-parse', 'HEAD'], {
      cwd: repo,
    });

    // Single (non-merge) commit: its own file.
    const bChanged = await getCommitChangedFiles(repo, a);
    expect(bChanged).toContain('src/a.ts');

    // Merge commit vs first parent (main@A) = the whole feature delta.
    const mChanged = await getCommitChangedFiles(repo, m.trim());
    expect(mChanged.sort()).toEqual(['src/f1.ts', 'src/f2.ts']);
  });
});

// ===========================================================================
// workdir — layout construction
// ===========================================================================
describe('workdir: layout construction', () => {
  test('resolveWorkdirRoot returns a realpath-canonical existing dir', () => {
    const base = tmp('replay-base-');
    const workdir = resolveWorkdirRoot(base);
    tempDirs.push(workdir);
    expect(existsSync(workdir)).toBe(true);
    // No /var -> /private/var drift: the path equals its own realpath.
    expect(realpathSync(workdir)).toBe(workdir);
  });

  test('symlinkDist points <workdir>/vitest-affected/dist at the real dist', () => {
    const base = tmp('replay-base-');
    const workdir = resolveWorkdirRoot(base);
    tempDirs.push(workdir);

    // Stand-in dist dir with a marker file.
    const distPath = path.join(base, 'real-dist');
    mkdirSync(distPath, { recursive: true });
    writeFileSync(path.join(distPath, 'index.js'), '// built plugin');

    const link = symlinkDist(workdir, distPath);
    expect(link).toBe(path.join(workdir, 'vitest-affected', 'dist'));
    // The symlink resolves through to the real dist (createRequire realpaths it).
    expect(realpathSync(link)).toBe(realpathSync(distPath));
    expect(existsSync(path.join(link, 'index.js'))).toBe(true);
  });

  test('cloneConsumer clones the repo to <workdir>/body-compass-app with history', async () => {
    const base = tmp('replay-base-');
    const source = tmp('replay-src-');
    await gitInit(source);
    await commitFile(source, 'src/a.ts', 'a', 'A');
    await commitFile(source, 'src/b.ts', 'b', 'B');

    const workdir = resolveWorkdirRoot(base);
    tempDirs.push(workdir);
    const cloneDir = await cloneConsumer(workdir, source);

    expect(cloneDir).toBe(path.join(workdir, CONSUMER_DIRNAME));
    expect(existsSync(path.join(cloneDir, 'src', 'b.ts'))).toBe(true);
    // Full history came across.
    const { stdout } = await execa('git', ['rev-list', '--count', 'HEAD'], {
      cwd: cloneDir,
    });
    expect(Number(stdout.trim())).toBe(2);
  });

  test('createRunDir builds timestamped run dir with artifact subdirs', () => {
    const workdir = tmp('replay-run-');
    const dirs = createRunDir(workdir, '2026-07-04T00-00-00-000Z');
    expect(existsSync(dirs.statsDir)).toBe(true);
    expect(existsSync(dirs.outcomesDir)).toBe(true);
    expect(existsSync(dirs.graphsDir)).toBe(true);
    expect(dirs.ledgerPath).toBe(path.join(dirs.runDir, 'ledger.jsonl'));
    expect(dirs.runDir).toContain(path.join('runs', '2026-07-04T00-00-00-000Z'));
  });
});

// ===========================================================================
// exec — env hygiene
// ===========================================================================
describe('exec: environment hygiene', () => {
  test('buildRunEnv clears CI signals and sets shadow + stats file', () => {
    const base: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      CI: '1',
      GITHUB_ACTIONS: 'true',
    };
    const env = buildRunEnv(base, '/run/stats/abc.jsonl');
    expect(env.CI).toBeUndefined();
    expect(env.GITHUB_ACTIONS).toBeUndefined();
    expect(env.VITEST_AFFECTED_SHADOW).toBe('1');
    expect(env.VITEST_AFFECTED_STATS_FILE).toBe('/run/stats/abc.jsonl');
    // PATH preserved.
    expect(env.PATH).toBe('/usr/bin');
    // Input not mutated.
    expect(base.CI).toBe('1');
  });
});

// ===========================================================================
// exec — shadow stats parsing (fail-closed guard)
// ===========================================================================
describe('exec: shadow stats parsing', () => {
  test('parseShadowStatsLine reads a shadow-selective decision', () => {
    const content =
      JSON.stringify({
        timestamp: '2026-07-04T00:00:00.000Z',
        action: 'shadow-selective',
        reason: 'selective',
        selectedFiles: ['test/a.test.ts', 'test/b.test.ts'],
      }) + '\n';
    const decision = parseShadowStatsLine(content);
    expect(decision).not.toBeNull();
    expect(decision?.action).toBe('shadow-selective');
    expect(decision?.selectedFiles).toEqual(['test/a.test.ts', 'test/b.test.ts']);
    expect(decision?.reason).toBe('selective');
  });

  test('parseShadowStatsLine reads a shadow-full-suite decision (null selection)', () => {
    const content =
      JSON.stringify({
        timestamp: '2026-07-04T00:00:00.000Z',
        action: 'shadow-full-suite',
        reason: 'no-cache',
        selectedFiles: null,
      }) + '\n';
    const decision = parseShadowStatsLine(content);
    expect(decision?.action).toBe('shadow-full-suite');
    expect(decision?.selectedFiles).toBeNull();
  });

  test('parseShadowStatsLine skips non-shadow lines and picks the shadow one', () => {
    const content =
      JSON.stringify({ action: 'selective', selectedFiles: ['x'] }) +
      '\n' +
      JSON.stringify({ action: 'shadow-selective', selectedFiles: ['y'] }) +
      '\n';
    const decision = parseShadowStatsLine(content);
    expect(decision?.action).toBe('shadow-selective');
    expect(decision?.selectedFiles).toEqual(['y']);
  });

  test('parseShadowStatsLine returns null when no shadow line (BROKEN signal)', () => {
    const content =
      JSON.stringify({ action: 'selective', selectedFiles: ['x'] }) + '\n';
    expect(parseShadowStatsLine(content)).toBeNull();
    expect(parseShadowStatsLine('')).toBeNull();
    expect(parseShadowStatsLine('{{ not json\n')).toBeNull();
  });
});

// ===========================================================================
// exec — ref control (synthetic repo)
// ===========================================================================
describe('exec: ref control', () => {
  test('setRefToParent detaches HEAD at C and force-moves main to C^', async () => {
    const repo = tmp('replay-ref-');
    await gitInit(repo);
    const c1 = await commitFile(repo, 'src/a.ts', 'a', 'C1');
    const c2 = await commitFile(repo, 'src/b.ts', 'b', 'C2');

    await setRefToParent(repo, c2);

    // HEAD is detached exactly at C2.
    const { stdout: head } = await execa('git', ['rev-parse', 'HEAD'], {
      cwd: repo,
    });
    expect(head.trim()).toBe(c2);
    const { stdout: symbolic } = await execa(
      'git',
      ['symbolic-ref', '-q', 'HEAD'],
      { cwd: repo, reject: false },
    );
    expect(symbolic.trim()).toBe(''); // detached: no symbolic ref

    // main now points at C2^ == C1, so the config diffs C1 -> C2.
    const { stdout: main } = await execa('git', ['rev-parse', 'main'], {
      cwd: repo,
    });
    expect(main.trim()).toBe(c1);
  });
});

// ===========================================================================
// run — CLI arg parsing
// ===========================================================================
describe('run: CLI arg parsing', () => {
  test('parseArgs parses --repo, --range, --sample', () => {
    const args = parseArgs([
      '--repo',
      '/path/to/bca',
      '--range',
      'abc..def',
      '--sample',
      '3',
    ]);
    expect(args.help).toBe(false);
    expect(args.repo).toBe('/path/to/bca');
    expect(args.range).toBe('abc..def');
    expect(args.sample).toBe(3);
  });

  test('parseArgs sets help on --help / -h without requiring other args', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });

  test('parseArgs throws on missing --repo', () => {
    expect(() => parseArgs(['--range', 'a..b'])).toThrow(/--repo is required/);
  });

  test('parseArgs throws on missing --range', () => {
    expect(() => parseArgs(['--repo', '/x'])).toThrow(/--range is required/);
  });

  test('parseArgs throws on malformed --range', () => {
    expect(() => parseArgs(['--repo', '/x', '--range', 'nope'])).toThrow(
      /--range must be of the form/,
    );
  });

  test('parseArgs throws on non-positive --sample', () => {
    expect(() =>
      parseArgs(['--repo', '/x', '--range', 'a..b', '--sample', '0']),
    ).toThrow(/--sample must be a positive integer/);
  });

  test('USAGE and resolveDistPath are wired', () => {
    expect(USAGE).toContain('replay harness');
    expect(resolveDistPath().endsWith('dist')).toBe(true);
  });
});
