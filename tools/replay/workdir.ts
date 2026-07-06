/**
 * Workdir layout — the load-bearing directory structure that makes the replay
 * trustworthy.
 *
 * BCA's vitest.config.mts resolves the plugin via the sibling path
 * ../vitest-affected/dist WITH A SILENT NO-OP FALLBACK. A bare clone would load
 * the no-op and produce a false-clean report. So the harness must reproduce the
 * sibling layout:
 *
 *   <workdir>/body-compass-app/         <- clone of the consumer repo
 *   <workdir>/vitest-affected/dist  ->  <this repo>/dist   (symlink)
 *   <workdir>/runs/<timestamp>/         <- per-run artifacts
 *
 * Node's createRequire in BCA's config realpaths through the symlink correctly
 * (verified), so the clone loads the REAL built plugin.
 *
 * The workdir root is realpathSync'd at creation: un-canonicalized
 * /var -> /private/var temp paths desync rootDir from git/Vite paths and starve
 * the reporter of edges (same failure class as the known macOS git.test.ts
 * flakes).
 */
import { mkdtempSync, realpathSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runGit } from './git-cmd.js';

/** Fixed clone directory name — matches BCA's sibling-path expectation. */
export const CONSUMER_DIRNAME = 'body-compass-app';
/** Fixed sibling dir the consumer config resolves the plugin through. */
export const PLUGIN_DIRNAME = 'vitest-affected';

export interface RunDirs {
  /** <workdir>/runs/<timestamp> */
  runDir: string;
  statsDir: string;
  outcomesDir: string;
  graphsDir: string;
  ledgerPath: string;
}

/**
 * Create the workdir root and return its REALPATH. Pass `baseDir` to root it
 * somewhere other than the OS temp dir (tests use a controlled base).
 */
export function resolveWorkdirRoot(baseDir?: string): string {
  const parent = baseDir ?? tmpdir();
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(path.join(parent, 'vitest-affected-replay-'));
  // Canonicalize immediately so every downstream path derives from the real
  // location (no /var -> /private/var drift).
  return realpathSync(dir);
}

/**
 * Symlink <workdir>/vitest-affected/dist -> `distPath` (this repo's built dist)
 * and return the symlink path. Recreates BCA's sibling layout so the consumer
 * config loads the real plugin instead of its no-op fallback.
 */
export function symlinkDist(workdir: string, distPath: string): string {
  const pluginDir = path.join(workdir, PLUGIN_DIRNAME);
  mkdirSync(pluginDir, { recursive: true });
  const link = path.join(pluginDir, 'dist');
  symlinkSync(distPath, link, 'dir');
  return link;
}

/**
 * Clone the consumer repo into <workdir>/body-compass-app and return the clone
 * path. A local clone keeps full history (needed for range/first-parent walks
 * and per-commit ref control).
 */
export async function cloneConsumer(
  workdir: string,
  repoPath: string,
): Promise<string> {
  const dest = path.join(workdir, CONSUMER_DIRNAME);
  await runGit(workdir, ['clone', '--no-hardlinks', repoPath, dest]);
  return dest;
}

/**
 * Remove the multi-GB consumer clone once the walk is done, keeping every run
 * artifact (reports / logs / ledger under <workdir>/runs) intact — ONLY the clone
 * is a per-run disposable. Best-effort and idempotent: an already-removed or
 * missing clone is a no-op, and teardown NEVER throws, so a run interrupted
 * mid-walk can't have its real error masked by a cleanup failure. cloneDir is a
 * throwaway clone under the OS temp dir, so removing it is safe.
 */
export function removeClone(cloneDir: string): void {
  try {
    rmSync(cloneDir, { recursive: true, force: true });
  } catch {
    /* best-effort — never let a cleanup error mask the walk's real outcome */
  }
}

/**
 * Create a timestamped run directory with its artifact subdirs. Returns all the
 * paths the per-commit loop writes to.
 */
export function createRunDir(workdir: string, timestamp?: string): RunDirs {
  const stamp = timestamp ?? new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.join(workdir, 'runs', stamp);
  const statsDir = path.join(runDir, 'stats');
  const outcomesDir = path.join(runDir, 'outcomes');
  const graphsDir = path.join(runDir, 'graphs');
  for (const d of [statsDir, outcomesDir, graphsDir]) {
    mkdirSync(d, { recursive: true });
  }
  return {
    runDir,
    statsDir,
    outcomesDir,
    graphsDir,
    ledgerPath: path.join(runDir, 'ledger.jsonl'),
  };
}
