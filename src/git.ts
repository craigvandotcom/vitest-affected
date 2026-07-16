import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { toCanonicalPath } from './graph/normalize.js';

const execFile = promisify(execFileCb);

// Raise Node's 1MB default stdout cap to a large finite bound. A big changeset
// (a giant diff range, or codegen touching 10k+ files) overflows the 1MB default
// and makes execFile reject with "maxBuffer length exceeded".
//
// The cap is finite ON PURPOSE. `Infinity` would let git's stdout buffer grow
// unbounded until the process dies with an UNCATCHABLE V8 heap OOM — which no
// try/catch can intercept, so the plugin's full-suite fallback never runs. A
// finite cap instead makes overflow throw a CATCHABLE error:
//   - committed path (no `.catch`): rejects → propagates through Promise.all →
//     getChangedFiles throws → the plugin's catch-all falls back to the full suite;
//   - staged/unstaged paths (per-command `.catch` + isBenignGitError): a maxBuffer
//     overflow is NOT a benign shape, so it too rethrows → full-suite fallback
//     (only an unborn-HEAD failure degrades that source to []).
// Either way the outcome is a real error the plugin can act on — over-select via
// full-suite fallback — rather than the whole test process dying. 256MB is far
// above any realistic `--name-only` diff (paths only, no contents) yet still a
// bound V8 can honor without OOM.
const GIT_STDOUT_MAX_BUFFER = 256 * 1024 * 1024;

async function exec(cmd: string, args: string[], opts: { cwd: string }): Promise<{ stdout: string }> {
  try {
    const { stdout } = await execFile(cmd, args, {
      ...opts,
      encoding: 'utf-8',
      maxBuffer: GIT_STDOUT_MAX_BUFFER,
    });
    return { stdout: stdout ?? '' };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const stderr = err && typeof err === 'object' && 'stderr' in err ? String(err.stderr) : undefined;
    throw new Error(`${cmd} ${args.join(' ')} failed: ${stderr ?? msg}`);
  }
}

// Benign git-error shapes for the working-tree sources (staged/unstaged).
//
// The ONLY known-benign failure is an unborn HEAD (a repo with zero commits):
// the two `diff-index ... HEAD` sources cannot resolve HEAD, so git 2.49 emits
//   fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.
// which exec() rewraps as `git diff-index ... failed: <that stderr>`. Here empty
// genuinely means "nothing committed yet" → degrade to [] is correct.
//
// The `ls-files` (unstaged/untracked) source has NO currently-known benign
// failure mode — it exits 0 on an unborn HEAD and lists untracked files. The
// same classifier is applied uniformly to all three sources anyway (single
// source of truth, forward-safe); in practice an `ls-files` failure is never
// benign and always propagates.
//
// Everything NOT matched here (corrupt index, I/O error, unreadable `.git`,
// maxBuffer overflow) is a GENUINE failure: rethrow so it propagates through
// Promise.all → getChangedFiles throws → the plugin's catch-all falls back to
// the full suite. This mirrors the committed path and the ref-verification
// loud-failure guard — never silently skip tests.
const BENIGN_GIT_ERROR_PATTERNS = [
  /unknown revision or path not in the working tree/,
  /ambiguous argument 'HEAD'/,
];
function isBenignGitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return BENIGN_GIT_ERROR_PATTERNS.some((re) => re.test(msg));
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

  // Step 2: Shallow clone detection (only relevant when ref is provided).
  // Scoped to ref-based selection ON PURPOSE: a ref-less run diffs only the
  // working tree / index against HEAD, which a shallow (HEAD-only) clone fully
  // satisfies — so we deliberately tolerate shallow clones there and guard only
  // the ref path, where reaching a historical merge-base requires real depth.
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

  // Step 2b: Ref resolvability check (only relevant when ref is provided).
  // The shallow-clone guard above only fires when the repo IS shallow. On a
  // NON-shallow checkout the ref can still fail to resolve (CI fetched only
  // HEAD, the ref was never fetched, or a typo). Left unguarded, the committed
  // `git diff ${ref}...HEAD` below fails and the per-command catch would
  // silently drop the ENTIRE committed diff — the user asked for ref-based
  // selection and would silently get working-tree-only selection instead.
  // Mirror the shallow-clone guard EXACTLY: throw a loud `vitest-affected:`
  // error so the plugin's catch-all falls back to the full suite.
  if (ref !== undefined) {
    let refResolves = false;
    try {
      // `--verify --quiet <ref>^{commit}` exits 0 (prints the SHA) when the ref
      // resolves to a commit, and non-zero with no output otherwise — which
      // exec() surfaces as a throw.
      await exec('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: rootDir });
      refResolves = true;
    } catch {
      refResolves = false;
    }
    if (!refResolves) {
      throw new Error(
        `vitest-affected: ref "${ref}" does not resolve to a commit. ` +
        'Cannot compute ref-based diff. ' +
        'Ensure the ref is fetched (e.g. "git fetch origin <ref>" in CI) and spelled correctly.'
      );
    }
  }

  // Step 3: Get git root (paths from git diff are relative to git root, not rootDir)
  // Canonicalize explicitly rather than relying on git's own realpath behavior
  // (which resolves symlinks when locating the repo toplevel): on macOS this is
  // exactly the /var → /private/var divergence that desyncs git-derived paths
  // from graph keys built off a non-canonicalized rootDir.
  const { stdout: gitRootRaw } = await exec('git', ['rev-parse', '--show-toplevel'], { cwd: rootDir });
  const gitRoot = toCanonicalPath(gitRootRaw.trim());

  // Step 4: Parallel git commands
  //
  // Committed changes (ref-based): use git diff with ref...HEAD and --no-renames so
  //   a rename surfaces as its A (new path) + D (old path) pair. WITHOUT --no-renames,
  //   git's default rename detection collapses A→B into a single entry showing only the
  //   NEW path, so the OLD path never enters `changed`/`deleted` and the cached
  //   `old → [tests]` reverse edges never seed BFS — an under-selection. This mirrors
  //   the staged path's diff-index A+D behaviour below. --diff-filter includes T
  //   (type-changed, e.g. file → symlink) so a type-change surfaces as `changed`
  //   rather than being silently dropped — another under-selection.
  // Staged changes: use diff-index --cached which reports renames as A+D entries (unlike
  //   git diff --cached which merges renames into a single R entry with --name-only);
  //   T (type-changed) is likewise included so it enters `changed`.
  // Unstaged changes: ls-files --others --modified reports untracked and modified tracked files
  //
  // All paths are relative to gitRoot.

  // No `.catch(() => [])` here (unlike the staged/unstaged sources below): the
  // ref was verified to resolve and the repo is non-shallow, so a failure of
  // `git diff ${ref}...HEAD` is genuinely unexpected (e.g. unrelated histories
  // with no merge base, or an I/O error). Silently returning [] would drop the
  // ref-based diff the user explicitly requested — an under-selection. Letting
  // it reject propagates through Promise.all → getChangedFiles throws → the
  // plugin's catch-all falls back to the full suite (the safe, loud outcome).
  const committedPromise: Promise<string[]> = ref !== undefined
    ? exec('git', ['diff', '--name-only', '--no-renames', '--diff-filter=ACMDT', `${ref}...HEAD`], { cwd: gitRoot })
        .then(r => r.stdout.trim().split('\n').filter(Boolean))
    : Promise.resolve([]);

  // staged (add/copy/modify/rename/type-change) — new names or modified files
  const stagedChangedPromise: Promise<string[]> = exec(
    'git',
    ['diff-index', '--cached', '--name-only', '--diff-filter=ACMRT', 'HEAD'],
    { cwd: gitRoot }
  )
    .then(r => r.stdout.trim().split('\n').filter(Boolean))
    .catch((err: unknown) => { if (isBenignGitError(err)) return []; throw err; });

  // staged deletions — includes old names from renames
  const stagedDeletedPromise: Promise<string[]> = exec(
    'git',
    ['diff-index', '--cached', '--name-only', '--diff-filter=D', 'HEAD'],
    { cwd: gitRoot }
  )
    .then(r => r.stdout.trim().split('\n').filter(Boolean))
    .catch((err: unknown) => { if (isBenignGitError(err)) return []; throw err; });

  // unstaged: untracked files + modified tracked files (includes unstaged deletions)
  const unstagedPromise: Promise<string[]> = exec(
    'git',
    ['ls-files', '--others', '--modified', '--exclude-standard', '--full-name'],
    { cwd: gitRoot }
  )
    .then(r => r.stdout.trim().split('\n').filter(Boolean))
    .catch((err: unknown) => { if (isBenignGitError(err)) return []; throw err; });

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
  // Canonicalize so paths match Vite's forward-slash convention AND converge
  // with graph keys even when gitRoot sits behind a symlinked alias. Deleted
  // files (the common case for `rel` here) don't exist on disk — toCanonicalPath
  // falls back to the nearest existing ancestor rather than throwing.
  const classify = (rel: string) => {
    const absPath = toCanonicalPath(path.resolve(gitRoot, rel));
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

/**
 * Read the current HEAD commit SHA and branch name, for the cache's git
 * identity metadata (persisted alongside the reverse map so a later run can
 * detect a branch switch / rebase that silently invalidated the
 * runtime-observed graph — see reconcileCacheStaleness in plugin.ts).
 *
 * Each of the two reads degrades to `undefined` INDEPENDENTLY on ANY failure
 * (unborn HEAD, not a git repo, detached-HEAD edge cases, or any other git
 * error) — this is a best-effort diagnostic read, not a decision input, so it
 * must never throw and never block the pipeline. Mirrors git.ts's existing
 * benign-failure posture (isBenignGitError / getChangedFiles's soft
 * not-a-work-tree fallback) but is even more permissive: EVERY failure here is
 * benign, because the only consumer (a DIAGNOSTIC heartbeat) treats an absent
 * value as "no baseline, don't warn" rather than a decision that must fail
 * loud. Independent try/catch per read: `--abbrev-ref HEAD` can resolve via
 * the symbolic ref even when `rev-parse HEAD` fails on an unborn HEAD (no
 * commit to name yet), so one succeeding while the other fails is a real,
 * useful partial result rather than an all-or-nothing pair.
 */
export async function readGitIdentity(
  rootDir: string,
): Promise<{ headSha?: string; branch?: string }> {
  let headSha: string | undefined;
  try {
    const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: rootDir });
    headSha = stdout.trim() || undefined;
  } catch {
    headSha = undefined;
  }

  let branch: string | undefined;
  try {
    const { stdout } = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: rootDir });
    branch = stdout.trim() || undefined;
  } catch {
    branch = undefined;
  }

  return { headSha, branch };
}
