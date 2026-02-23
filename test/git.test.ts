import { describe, test, expect, afterEach } from 'vitest';
import path from 'node:path';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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
  const dir = mkdtempSync(path.join(tmpdir(), 'vitest-affected-git-'));
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
});
