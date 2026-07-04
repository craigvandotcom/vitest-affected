/**
 * Walker — first-parent chain enumeration, commit classification, and the
 * dependency-install policy.
 *
 * We walk the FIRST-PARENT chain of the consumer's main branch: a merge
 * commit's step-diff (vs its first parent) is the whole PR delta that landed on
 * main, which is exactly what live plugin usage saw. Feature-branch commits
 * (second-parent side) are never replayed in isolation.
 *
 * Commits that touch the lockfile or build/test config are FLAGGED and skipped
 * (never silently dropped) — their diff is dominated by dependency/config
 * churn, not source edits, so they are not meaningful selection samples.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { runGit } from './git-cmd.js';
import type { CommitClassification } from './types.js';

/** Default lockfile the harness watches for reinstall decisions. */
export const DEFAULT_LOCKFILE = 'pnpm-lock.yaml';

/**
 * True when a changed-file path is a lockfile or config-touching file that
 * warrants skipping the commit. Matches on basename:
 *  - pnpm-lock.yaml (lockfile)
 *  - package.json (deps / scripts)
 *  - vitest.config.* (test runner config)
 *  - tsconfig* (compiler / resolution config)
 */
export function isSkipTriggeringFile(file: string): boolean {
  const base = path.posix.basename(file.replace(/\\/g, '/'));
  if (base === DEFAULT_LOCKFILE) return true;
  if (base === 'package.json') return true;
  if (/^vitest\.config\.[A-Za-z]+$/.test(base)) return true;
  if (base.startsWith('tsconfig') && base.endsWith('.json')) return true;
  return false;
}

/**
 * Classify a commit from its step-diff file list. Pure — no git access, so it
 * is trivially unit-testable. `skipTriggers` itemizes exactly which files
 * caused the skip.
 */
export function classifyCommit(
  sha: string,
  changedFiles: string[],
): CommitClassification {
  const skipTriggers = changedFiles.filter(isSkipTriggeringFile);
  return {
    sha,
    changedFiles,
    skip: skipTriggers.length > 0,
    skipTriggers,
  };
}

/**
 * Install policy: reinstall when there is no prior hash (first commit) or the
 * lockfile content hash changed since the last install. Keeps `pnpm install`
 * off the critical path for the ~98% of commits that don't touch deps.
 */
export function shouldReinstall(
  prevLockHash: string | null,
  currentLockHash: string | null,
): boolean {
  if (prevLockHash === null) return true;
  return prevLockHash !== currentLockHash;
}

/** SHA-256 of the lockfile at `dir`, or null if the lockfile is absent. */
export async function getLockfileHash(
  dir: string,
  lockfile: string = DEFAULT_LOCKFILE,
): Promise<string | null> {
  try {
    const content = await readFile(path.join(dir, lockfile), 'utf-8');
    return createHash('sha256').update(content).digest('hex');
  } catch {
    return null;
  }
}

/**
 * First-parent commit chain for `range` (e.g. "from..to"), oldest -> newest.
 * `--first-parent` follows only the mainline; `--reverse` yields chronological
 * order so the replay walks history forward.
 */
export async function getFirstParentChain(
  repoPath: string,
  range: string,
): Promise<string[]> {
  const out = await runGit(repoPath, [
    'rev-list',
    '--first-parent',
    '--reverse',
    range,
  ]);
  if (out.length === 0) return [];
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

/**
 * Step-diff file list for a commit vs its FIRST parent (C-1 -> C). For a merge
 * commit this is the whole PR delta that landed on main. Falls back to the
 * root-commit tree listing when the commit has no parent.
 */
export async function getCommitChangedFiles(
  repoPath: string,
  sha: string,
): Promise<string[]> {
  let out: string;
  try {
    out = await runGit(repoPath, ['diff', '--name-only', `${sha}^1`, sha]);
  } catch {
    // Root commit (no first parent): list the files introduced by the commit.
    out = await runGit(repoPath, [
      'diff-tree',
      '--no-commit-id',
      '--name-only',
      '-r',
      '--root',
      sha,
    ]);
  }
  if (out.length === 0) return [];
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

/**
 * Ensure dependencies are installed in the clone. `pnpm install
 * --prefer-offline` on first commit or whenever the lockfile hash changed.
 * Throws on install failure so the caller can mark the commit BROKEN.
 */
export async function ensureInstall(
  cloneDir: string,
  reinstall: boolean,
): Promise<void> {
  if (!reinstall) return;
  await execa('pnpm', ['install', '--prefer-offline'], { cwd: cloneDir });
}
