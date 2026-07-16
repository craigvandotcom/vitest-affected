/**
 * Flake guard — distinguishes a real regression from a flaky test by
 * re-running plugin-disabled once when new failures appear.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { trackChild } from './child-registry.js';
import {
  STDOUT_MAX_BUFFER,
  VITEST_RUN_TIMEOUT_MS,
  CHILD_FORCE_KILL_MS,
} from './limits.js';
import { parseOutcomes } from './parsers.js';

export interface FlakeCheckResult {
  sha: string;
  /** Tests newly failing at C (not failing at C-1). */
  newFailures: string[];
  /** New failures that still failed on the plugin-disabled re-run. */
  confirmed: string[];
  /** New failures that passed on the re-run — flakes, not real flips. */
  flaky: string[];
  /** Whether a re-run was actually spawned. */
  reran: boolean;
  /** True when this commit established the baseline (no prior outcomes). */
  baseline: boolean;
}

/**
 * Flake guard: when a commit introduces NEW failures (failed at C, not failed
 * at C-1), re-run ONCE via `rerun` and split confirmed failures from flakes.
 * The re-runner is injected so tests never spawn vitest; production wiring
 * uses `spawnDisabledRerun` (plugin fully inert → no cache/stats side
 * effects). No new failures → no re-run at all.
 *
 * BASELINE RULE: `prevOutcomes === null` marks the FIRST measurable commit —
 * there is nothing to compare against, so every failure would spuriously look
 * "new" (spurious re-runs, and a baseline-broken test could get laundered
 * into 'flaky'). No re-run; the commit's outcomes simply become the baseline.
 */
export async function flakeCheckCommit(
  sha: string,
  prevOutcomes: ReadonlyMap<string, string> | null,
  curOutcomes: ReadonlyMap<string, string>,
  rerun: () => Promise<Map<string, string>>,
): Promise<FlakeCheckResult> {
  if (prevOutcomes === null) {
    return {
      sha,
      newFailures: [],
      confirmed: [],
      flaky: [],
      reran: false,
      baseline: true,
    };
  }
  const newFailures: string[] = [];
  for (const [test, status] of curOutcomes) {
    if (status !== 'failed') continue;
    if (prevOutcomes.get(test) === 'failed') continue; // already failing
    newFailures.push(test);
  }
  newFailures.sort();
  if (newFailures.length === 0) {
    return {
      sha,
      newFailures,
      confirmed: [],
      flaky: [],
      reran: false,
      baseline: false,
    };
  }
  const rerunOutcomes = await rerun();
  const confirmed: string[] = [];
  const flaky: string[] = [];
  for (const test of newFailures) {
    // Absent from the re-run (e.g. renamed mid-flight) counts as confirmed —
    // fail-closed: never launder a failure into a flake without evidence.
    if (rerunOutcomes.get(test) === 'passed') flaky.push(test);
    else confirmed.push(test);
  }
  return { sha, newFailures, confirmed, flaky, reran: true, baseline: false };
}

/**
 * Production re-runner: spawn the consumer suite exactly like exec.ts does,
 * but with VITEST_AFFECTED_DISABLED=1 — the plugin's kill-switch makes it
 * fully inert (no include mutation, no reporter, no cache write, no stats
 * emission), so the re-run has zero side effects on the walk's artifacts.
 */
export async function spawnDisabledRerun(
  cloneDir: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<Map<string, string>> {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  delete env.CI;
  delete env.GITHUB_ACTIONS;
  delete env.VITEST_AFFECTED_SHADOW;
  delete env.VITEST_AFFECTED_STATS_FILE;
  env.VITEST_AFFECTED_DISABLED = '1';
  // trackChild registers this re-run with the signal handler (run.ts) so Ctrl-C
  // terminates it before clone teardown. maxBuffer/timeout/forceKillAfterDelay
  // mirror runCommit's vitest spawn (see exec.ts / limits.ts): a huge JSON
  // capture must not truncate to an empty outcome map, and a wedged re-run must
  // not stall the walk. On timeout/overflow (reject:false → no throw) stdout is
  // partial and parseOutcomes yields an empty map; flakeCheckCommit then treats
  // every new failure as CONFIRMED (fail-closed — never laundered into 'flaky'
  // without positive re-run evidence), which is the safe direction here.
  const result = await trackChild(
    execa('npx', ['vitest', 'run', '--reporter=json'], {
      cwd: cloneDir,
      env,
      reject: false,
      // Same trap as runCommit (see exec.ts): execa's default extendEnv re-merges
      // the parent process.env, re-introducing the CI / GITHUB_ACTIONS keys
      // deleted above — an inherited CI=1 would enable retry masking in exactly
      // the re-run whose job is to confirm a failure. The env above is a full
      // copy of the base env, so PATH etc. carry through.
      extendEnv: false,
      maxBuffer: STDOUT_MAX_BUFFER,
      timeout: VITEST_RUN_TIMEOUT_MS,
      forceKillAfterDelay: CHILD_FORCE_KILL_MS,
    }),
  );
  return parseOutcomes(result.stdout);
}

/** One flake-log.jsonl line, written by run.ts whenever a re-run happened. */
export interface FlakeLogEntry {
  sha: string;
  newFailures: string[];
  confirmed: string[];
  flaky: string[];
}

/** Load flake-log.jsonl → sha → set of known-flaky tests at that commit. */
export async function loadFlakyBySha(
  runDir: string,
): Promise<Map<string, Set<string>>> {
  const flaky = new Map<string, Set<string>>();
  const logPath = path.join(runDir, 'flake-log.jsonl');
  if (!existsSync(logPath)) return flaky;
  const content = await readFile(logPath, 'utf-8');
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== 'object') continue;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.sha !== 'string' || !Array.isArray(obj.flaky)) continue;
    flaky.set(
      obj.sha,
      new Set(obj.flaky.filter((t): t is string => typeof t === 'string')),
    );
  }
  return flaky;
}
