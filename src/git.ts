import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import path from 'node:path';

const execFile = promisify(execFileCb);

async function exec(cmd: string, args: string[], opts: { cwd: string }): Promise<{ stdout: string }> {
  try {
    const { stdout } = await execFile(cmd, args, { ...opts, encoding: 'utf-8' });
    return { stdout: stdout ?? '' };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const stderr = err && typeof err === 'object' && 'stderr' in err ? String(err.stderr) : undefined;
    throw new Error(`${cmd} ${args.join(' ')} failed: ${stderr ?? msg}`);
  }
}

export async function getChangedFiles(
  rootDir: string,
  ref?: string
): Promise<{ changed: string[]; deleted: string[] }> {
  // Step 1: Check if this is a git work tree
  let isGit = false;
  try {
    const { stdout } = await exec('git', ['rev-parse', '--is-inside-work-tree'], { cwd: rootDir });
    isGit = stdout.trim() === 'true';
  } catch {
    // Not a git repo — soft fallback
    console.warn('[vitest-affected] Not inside a git work tree — running full suite');
    return { changed: [], deleted: [] };
  }

  if (!isGit) {
    console.warn('[vitest-affected] Not inside a git work tree — running full suite');
    return { changed: [], deleted: [] };
  }

  // Step 2: Shallow clone detection (only relevant when ref is provided)
  if (ref !== undefined) {
    try {
      const { stdout } = await exec('git', ['rev-parse', '--is-shallow-repository'], { cwd: rootDir });
      if (stdout.trim() === 'true') {
        throw new Error(
          'vitest-affected: shallow clone detected. ' +
          'Cannot compute ref-based diff. ' +
          'Run "git fetch --unshallow" in CI to fix this.'
        );
      }
    } catch (err: unknown) {
      // If the error is our shallow clone error, rethrow
      if (err instanceof Error && err.message.includes('vitest-affected: shallow clone detected')) {
        throw err;
      }
      // Otherwise --is-shallow-repository may not be supported on older git; ignore
    }
  }

  // Step 3: Get git root (paths from git diff are relative to git root, not rootDir)
  const { stdout: gitRootRaw } = await exec('git', ['rev-parse', '--show-toplevel'], { cwd: rootDir });
  const gitRoot = gitRootRaw.trim();

  // Step 4: Parallel git commands
  //
  // Committed changes (ref-based): use git diff with ref...HEAD
  // Staged changes: use diff-index --cached which reports renames as A+D entries (unlike
  //   git diff --cached which merges renames into a single R entry with --name-only)
  // Unstaged changes: ls-files --others --modified reports untracked and modified tracked files
  //
  // All paths are relative to gitRoot.

  const committedPromise: Promise<string[]> = ref !== undefined
    ? exec('git', ['diff', '--name-only', '--diff-filter=ACMRD', `${ref}...HEAD`], { cwd: gitRoot })
        .then(r => r.stdout.trim().split('\n').filter(Boolean))
        .catch(() => [])
    : Promise.resolve([]);

  // staged (add/copy/modify/rename) — new names or modified files
  const stagedChangedPromise: Promise<string[]> = exec(
    'git',
    ['diff-index', '--cached', '--name-only', '--diff-filter=ACMR', 'HEAD'],
    { cwd: gitRoot }
  )
    .then(r => r.stdout.trim().split('\n').filter(Boolean))
    .catch(() => []);

  // staged deletions — includes old names from renames
  const stagedDeletedPromise: Promise<string[]> = exec(
    'git',
    ['diff-index', '--cached', '--name-only', '--diff-filter=D', 'HEAD'],
    { cwd: gitRoot }
  )
    .then(r => r.stdout.trim().split('\n').filter(Boolean))
    .catch(() => []);

  // unstaged: untracked files + modified tracked files (includes unstaged deletions)
  const unstagedPromise: Promise<string[]> = exec(
    'git',
    ['ls-files', '--others', '--modified', '--exclude-standard', '--full-name'],
    { cwd: gitRoot }
  )
    .then(r => r.stdout.trim().split('\n').filter(Boolean))
    .catch(() => []);

  const [committed, stagedChanged, stagedDeleted, unstaged] = await Promise.all([
    committedPromise,
    stagedChangedPromise,
    stagedDeletedPromise,
    unstagedPromise,
  ]);

  // Step 5: Deduplicate across all sources and resolve to absolute paths
  const seenPaths = new Set<string>();
  const changed: string[] = [];
  const deleted: string[] = [];

  // Helper: classify and add a relative path
  const classify = (rel: string) => {
    const absPath = path.resolve(gitRoot, rel);
    if (seenPaths.has(absPath)) return;
    seenPaths.add(absPath);
    if (existsSync(absPath)) {
      changed.push(absPath);
    } else {
      deleted.push(absPath);
    }
  };

  // Process all candidate files (order: committed, staged changed, unstaged, then staged deleted)
  // staged deleted is last so that if a path appears in both staged-changed and staged-deleted
  // the first seen wins (which would be staged-changed, indicating it still exists)
  for (const rel of committed) classify(rel);
  for (const rel of stagedChanged) classify(rel);
  for (const rel of unstaged) classify(rel);
  for (const rel of stagedDeleted) classify(rel);

  return { changed, deleted };
}
