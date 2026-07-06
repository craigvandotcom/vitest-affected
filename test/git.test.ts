import { describe, test, expect, afterEach } from 'vitest';
import path from 'node:path';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { getChangedFiles } from '../src/git.js';

const execFile = promisify(execFileCb);
const git = (args: string[], cwd: string) => execFile('git', args, { cwd });

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  tempDirs.length = 0;
});

/** Create a temp directory and init a fresh git repo. */
async function makeTempRepo(): Promise<string> {
  // realpathSync: os.tmpdir() sits behind a symlink on macOS (/var -> /private/var).
  // getChangedFiles() canonicalizes its output (git itself also resolves the repo
  // toplevel through symlinks), so `dir` must be canonical too or every assertion
  // below comparing `path.join(dir, ...)` against the returned paths diverges.
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'vitest-affected-git-')));
  tempDirs.push(dir);
  await git(['init'], dir);
  await git(['config', 'user.email', 'test@test.com'], dir);
  await git(['config', 'user.name', 'Test'], dir);
  return dir;
}

describe('getChangedFiles', () => {
  // 1. Committed changes (ref-based)
  test('returns committed changed files when ref is provided', async () => {
    const dir = await makeTempRepo();
    writeFileSync(path.join(dir, 'foo.ts'), 'export const foo = 1;\n');
    await git(['add', 'foo.ts'], dir);
    await git(['commit', '-m', 'initial'], dir);

    writeFileSync(path.join(dir, 'foo.ts'), 'export const foo = 2;\n');
    await git(['add', 'foo.ts'], dir);
    await git(['commit', '-m', 'update'], dir);

    const result = await getChangedFiles(dir, 'HEAD~1');
    expect(result.changed).toContain(path.join(dir, 'foo.ts'));
    expect(result.deleted).toHaveLength(0);
  });

  // 2. Staged changes
  test('returns staged changed files', async () => {
    const dir = await makeTempRepo();
    writeFileSync(path.join(dir, 'bar.ts'), 'export const bar = 1;\n');
    await git(['add', 'bar.ts'], dir);
    await git(['commit', '-m', 'initial'], dir);

    writeFileSync(path.join(dir, 'bar.ts'), 'export const bar = 2;\n');
    await git(['add', 'bar.ts'], dir);

    const result = await getChangedFiles(dir);
    expect(result.changed).toContain(path.join(dir, 'bar.ts'));
  });

  // 3. Unstaged changes (tracked file modified but not added)
  test('returns unstaged modified files', async () => {
    const dir = await makeTempRepo();
    writeFileSync(path.join(dir, 'baz.ts'), 'export const baz = 1;\n');
    await git(['add', 'baz.ts'], dir);
    await git(['commit', '-m', 'initial'], dir);

    // Modify without staging
    writeFileSync(path.join(dir, 'baz.ts'), 'export const baz = 99;\n');

    const result = await getChangedFiles(dir);
    expect(result.changed).toContain(path.join(dir, 'baz.ts'));
  });

  // 4. Untracked (new) files
  test('returns untracked new files', async () => {
    const dir = await makeTempRepo();
    // Need at least one commit so the repo is valid
    writeFileSync(path.join(dir, 'seed.ts'), 'export const seed = 0;\n');
    await git(['add', 'seed.ts'], dir);
    await git(['commit', '-m', 'seed'], dir);

    writeFileSync(path.join(dir, 'new.ts'), 'export const n = 1;\n');

    const result = await getChangedFiles(dir);
    expect(result.changed).toContain(path.join(dir, 'new.ts'));
  });

  // 5. Deleted files appear in deleted array
  test('returns deleted files in deleted array', async () => {
    const dir = await makeTempRepo();
    writeFileSync(path.join(dir, 'gone.ts'), 'export const gone = 1;\n');
    await git(['add', 'gone.ts'], dir);
    await git(['commit', '-m', 'initial'], dir);

    rmSync(path.join(dir, 'gone.ts'));

    const result = await getChangedFiles(dir);
    expect(result.deleted).toContain(path.join(dir, 'gone.ts'));
    expect(result.changed).not.toContain(path.join(dir, 'gone.ts'));
  });

  // 6. No changes: clean repo returns empty arrays
  test('returns empty arrays when repo is clean', async () => {
    const dir = await makeTempRepo();
    writeFileSync(path.join(dir, 'clean.ts'), 'export const clean = 1;\n');
    await git(['add', 'clean.ts'], dir);
    await git(['commit', '-m', 'initial'], dir);

    const result = await getChangedFiles(dir);
    expect(result.changed).toHaveLength(0);
    expect(result.deleted).toHaveLength(0);
  });

  // 7. Non-git directory: returns empty arrays gracefully
  test('returns empty arrays for non-git directory', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'not-a-git-repo-'));
    const result = await getChangedFiles(dir);
    expect(result.changed).toHaveLength(0);
    expect(result.deleted).toHaveLength(0);
  });

  // 8. Deduplication: file in both staged and unstaged appears only once
  test('deduplicates files that appear in multiple git outputs', async () => {
    const dir = await makeTempRepo();
    writeFileSync(path.join(dir, 'dup.ts'), 'export const dup = 1;\n');
    await git(['add', 'dup.ts'], dir);
    await git(['commit', '-m', 'initial'], dir);

    // Modify and stage, then modify again (file is in both staged and unstaged)
    writeFileSync(path.join(dir, 'dup.ts'), 'export const dup = 2;\n');
    await git(['add', 'dup.ts'], dir);
    writeFileSync(path.join(dir, 'dup.ts'), 'export const dup = 3;\n');

    const result = await getChangedFiles(dir);
    const allFiles = [...result.changed, ...result.deleted];
    const dupFile = path.join(dir, 'dup.ts');
    const occurrences = allFiles.filter(f => f === dupFile).length;
    expect(occurrences).toBe(1);
  });

  // 9. All returned paths are absolute
  test('all returned paths are absolute', async () => {
    const dir = await makeTempRepo();
    writeFileSync(path.join(dir, 'abs.ts'), 'export const abs = 1;\n');
    await git(['add', 'abs.ts'], dir);
    await git(['commit', '-m', 'initial'], dir);

    writeFileSync(path.join(dir, 'abs.ts'), 'export const abs = 2;\n');
    await git(['add', 'abs.ts'], dir);

    const result = await getChangedFiles(dir);
    for (const f of [...result.changed, ...result.deleted]) {
      expect(path.isAbsolute(f)).toBe(true);
    }
  });

  // 11. .env-drift decision (T2c): gitignored .env changes are INVISIBLE to
  // git-diff-based detection — the empirical fact the "document a recipe,
  // don't add to CONFIG_BASENAMES" decision rests on. `ls-files --others
  // --modified --exclude-standard` (used for the unstaged/untracked source)
  // honours .gitignore for untracked paths, so a newly-created, gitignored
  // .env never appears in `changed` at all — no filter downstream (extension
  // allowlist, configBasenames, fullSuiteTriggers) can act on a file the
  // changed-file set never contains.
  test('a newly-created, gitignored .env is invisible (not in changed, not in deleted)', async () => {
    const dir = await makeTempRepo();
    writeFileSync(path.join(dir, 'seed.ts'), 'export const seed = 0;\n');
    writeFileSync(path.join(dir, '.gitignore'), '.env\n.env.local\n');
    await git(['add', 'seed.ts', '.gitignore'], dir);
    await git(['commit', '-m', 'seed'], dir);

    writeFileSync(path.join(dir, '.env'), 'SECRET=1\n');
    writeFileSync(path.join(dir, '.env.local'), 'SECRET_LOCAL=1\n');

    const result = await getChangedFiles(dir);
    expect(result.changed).not.toContain(path.join(dir, '.env'));
    expect(result.changed).not.toContain(path.join(dir, '.env.local'));
    expect(result.deleted).toHaveLength(0);
  });

  // Counter-case: IF a repo tracks its .env (unusual — most gitignore it),
  // gitignore no longer applies to that already-tracked path and a plain
  // modification surfaces normally via the unstaged path. This is the one
  // scenario where a CONFIG_BASENAMES entry would ever fire — corpus evidence
  // showed no failure justifying paying that always-on cost for it.
  test('a tracked (unusual) .env IS visible once modified — gitignore does not apply to tracked paths', async () => {
    const dir = await makeTempRepo();
    writeFileSync(path.join(dir, '.gitignore'), '.env\n');
    writeFileSync(path.join(dir, '.env'), 'SECRET=1\n');
    await git(['add', '-f', '.gitignore', '.env'], dir);
    await git(['commit', '-m', 'seed (tracked .env, unusual)'], dir);

    writeFileSync(path.join(dir, '.env'), 'SECRET=2\n');

    const result = await getChangedFiles(dir);
    expect(result.changed).toContain(path.join(dir, '.env'));
  });

  // 12. Non-shallow repo, unresolvable ref → loud failure (full-suite fallback).
  // The shallow-clone guard only fires when the repo IS shallow. On a normal
  // (non-shallow) checkout, a ref that never resolves (never fetched, typo)
  // must NOT silently drop the committed diff and degrade to working-tree-only
  // selection. getChangedFiles rethrows a `vitest-affected:` error — the same
  // loud-failure taxonomy the shallow-clone guard uses — which the plugin's
  // catch-all turns into a full-suite fallback. Mirrors the shallow guard's
  // assertion: expect a reject carrying the recognizable error prefix.
  test('throws (loud failure) when ref does not resolve on a non-shallow repo', async () => {
    const dir = await makeTempRepo();
    writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');
    await git(['add', 'a.ts'], dir);
    await git(['commit', '-m', 'initial'], dir);

    // Sanity: this is a normal, non-shallow repo (shallow guard would not fire).
    const { stdout: shallow } = await git(['rev-parse', '--is-shallow-repository'], dir);
    expect(shallow.trim()).toBe('false');

    await expect(getChangedFiles(dir, 'no-such-ref-xyz')).rejects.toThrow(
      /vitest-affected: ref "no-such-ref-xyz" does not resolve/,
    );
  });

  // 10. Renamed file: old name in deleted, new name in changed
  test('handles renamed files correctly', async () => {
    const dir = await makeTempRepo();
    writeFileSync(path.join(dir, 'old.ts'), 'export const old = 1;\n');
    await git(['add', 'old.ts'], dir);
    await git(['commit', '-m', 'initial'], dir);

    await git(['mv', 'old.ts', 'new-name.ts'], dir);

    const result = await getChangedFiles(dir);
    // new-name.ts exists → changed
    expect(result.changed).toContain(path.join(dir, 'new-name.ts'));
    // old.ts no longer exists → deleted
    expect(result.deleted).toContain(path.join(dir, 'old.ts'));
  });

  // 13. COMMITTED rename (ref-based): both old and new path must surface.
  // git's DEFAULT rename detection collapses a committed A→B rename into a single
  // --name-only entry showing only the NEW path, so the OLD path would never enter
  // `deleted` and its cached `old → [tests]` reverse edges would never seed BFS —
  // a silent under-selection. `--no-renames` splits the rename back into A + D.
  // Regression guard for the committed-diff path (the staged path was already
  // covered by test 10, which exercises the working tree, not ref...HEAD).
  test('committed rename surfaces BOTH old (deleted) and new (changed) paths', async () => {
    const dir = await makeTempRepo();
    writeFileSync(path.join(dir, 'renamed-old.ts'), 'export const x = 1;\n');
    await git(['add', 'renamed-old.ts'], dir);
    await git(['commit', '-m', 'initial'], dir);

    // Rename AND commit it, so the change is committed (not in the working tree).
    await git(['mv', 'renamed-old.ts', 'renamed-new.ts'], dir);
    await git(['commit', '-m', 'rename'], dir);

    // ref points BEFORE the rename → the committed diff HEAD~1...HEAD is the rename.
    const result = await getChangedFiles(dir, 'HEAD~1');
    // new path exists on disk → changed/added
    expect(result.changed).toContain(path.join(dir, 'renamed-new.ts'));
    // old path no longer exists → deleted (this is what default rename detection drops)
    expect(result.deleted).toContain(path.join(dir, 'renamed-old.ts'));
  });

  // 14. COMMITTED type-change (ref-based): a tracked path whose TYPE changes
  // (regular file → symlink) is reported by git as a single `T` entry and nothing
  // else. With --diff-filter=ACMD (no T) that entry is silently dropped: the path
  // never enters `changed`, its cached reverse edges never seed BFS, and dependent
  // tests are silently skipped — violating "never silently skip tests". Adding T
  // (ACMDT) restores it. The new form (a symlink) still exists on disk, so
  // existsSync routes it to `changed`. Regression guard for the committed-diff path.
  // symlink() is POSIX-only; this suite's CI matrix is ubuntu + macos (no Windows),
  // so skip on win32 rather than fight platform-specific symlink semantics.
  const maybeSymlinkTest = process.platform === 'win32' ? test.skip : test;
  maybeSymlinkTest('committed type-change (file → symlink) surfaces the path in changed', async () => {
    const { symlinkSync, unlinkSync } = await import('node:fs');
    const dir = await makeTempRepo();
    // Two committed regular files: `target.ts` is the symlink destination, and
    // `shifty.ts` starts life as a regular file.
    writeFileSync(path.join(dir, 'target.ts'), 'export const target = 1;\n');
    writeFileSync(path.join(dir, 'shifty.ts'), 'export const shifty = 1;\n');
    await git(['add', 'target.ts', 'shifty.ts'], dir);
    await git(['commit', '-m', 'initial'], dir);

    // Replace the regular file with a symlink pointing at the other committed
    // file, then commit — this is a pure type-change (git reports it as `T`).
    unlinkSync(path.join(dir, 'shifty.ts'));
    symlinkSync('target.ts', path.join(dir, 'shifty.ts'));
    await git(['add', 'shifty.ts'], dir);
    await git(['commit', '-m', 'file → symlink'], dir);

    // ref points BEFORE the type-change → the committed diff HEAD~1...HEAD is the T entry.
    const result = await getChangedFiles(dir, 'HEAD~1');
    // The symlink still exists on disk → existsSync → the path is routed to
    // `changed` (never `deleted`). getChangedFiles canonicalizes via realpath, which
    // resolves the symlink to its target — the SAME canonicalization graph keys use
    // (see graph/builder.ts), so this is self-consistent. The load-bearing assertion
    // is that a `T` entry surfaces in `changed` AT ALL (empty before the ACMDT fix).
    expect(result.changed).toContain(realpathSync(path.join(dir, 'shifty.ts')));
    expect(result.deleted).not.toContain(realpathSync(path.join(dir, 'shifty.ts')));
  });
});
