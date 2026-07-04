/**
 * Exec — per-commit ref control, environment hygiene, vitest invocation, and
 * the fail-closed shadow guard.
 *
 * REF CONTROL: BCA's config hardcodes `ref: 'main'`. To make the unmodified
 * config diff exactly C-1 -> C we detach HEAD at C, then force-move `main` to
 * C^ (first parent). Order matters: detaching first frees `main` so
 * `git branch -f main` cannot fail with "cannot force update the currently
 * checked out branch".
 *
 * ENVIRONMENT HYGIENE: CI / GITHUB_ACTIONS are cleared for walk runs (BCA's
 * `retry: CI ? 1 : 0` would silently mask outcome flips), shadow mode is forced
 * on, and each commit gets its own stats file (no interleaving with the
 * consumer's live stats.jsonl).
 *
 * FAIL-CLOSED GUARD: every replayed commit MUST emit a shadow stats line (the
 * plugin's every-exit-emission contract). A missing line marks the commit
 * BROKEN — it is NEVER counted clean.
 */
import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { runGit } from './git-cmd.js';
import type { ShadowDecision } from './types.js';

/**
 * Detach HEAD at `sha` in the clone, then force `main` to its first parent so
 * the consumer config (ref: 'main') diffs exactly C-1 -> C.
 */
export async function setRefToParent(
  cloneDir: string,
  sha: string,
): Promise<void> {
  await runGit(cloneDir, ['checkout', '--detach', sha]);
  await runGit(cloneDir, ['branch', '-f', 'main', `${sha}^1`]);
}

/**
 * Build the per-commit run environment: clear CI signals, force shadow mode,
 * and point the plugin's stats output at the per-commit file. Pure — returns a
 * fresh env object, never mutates the input.
 *
 * The `delete`s below are only effective if the child process is spawned with
 * `extendEnv: false` (see runCommit): execa's DEFAULT is to merge `process.env`
 * OVER nothing but UNDER the provided env — so a key merely deleted from this
 * object is re-introduced from the parent `process.env` at spawn time (a key
 * that is absent does not override the parent's value). Running the harness in a
 * shell with `CI=1` / `GITHUB_ACTIONS` / `VITEST_AFFECTED_DISABLED=1` would then
 * silently defeat this hygiene (retry masking, or an all-BROKEN walk). The child
 * is therefore given EXACTLY this env, not an extension of the parent's.
 */
export function buildRunEnv(
  baseEnv: NodeJS.ProcessEnv,
  statsFilePath: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  delete env.CI;
  delete env.GITHUB_ACTIONS;
  // An inherited VITEST_AFFECTED_DISABLED=1 would suppress the plugin entirely:
  // fail-closed (every commit BROKEN via the missing-shadow-line guard), but a
  // uselessly misleading walk. The disabled early-return deliberately emits
  // nothing, so it is indistinguishable from a broken harness — clear it.
  delete env.VITEST_AFFECTED_DISABLED;
  env.VITEST_AFFECTED_SHADOW = '1';
  env.VITEST_AFFECTED_STATS_FILE = statsFilePath;
  return env;
}

/**
 * Parse a per-commit stats file (JSONL) for the shadow decision. Returns the
 * FIRST shadow-selective / shadow-full-suite line (the configureVitest decision
 * emitted before the run), or null when no shadow line exists — the caller
 * treats null as the fail-closed BROKEN signal.
 */
export function parseShadowStatsLine(content: string): ShadowDecision | null {
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
    const action = obj.action;
    if (action !== 'shadow-selective' && action !== 'shadow-full-suite') {
      continue;
    }
    const rawSelected = obj.selectedFiles;
    const selectedFiles = Array.isArray(rawSelected)
      ? rawSelected.filter((f): f is string => typeof f === 'string')
      : null;
    const decision: ShadowDecision = { action, selectedFiles };
    if (typeof obj.reason === 'string') decision.reason = obj.reason;
    return decision;
  }
  return null;
}

export interface RunCommitOptions {
  cloneDir: string;
  sha: string;
  /** <workdir>/runs/<timestamp> artifact dirs. */
  statsDir: string;
  outcomesDir: string;
  graphsDir: string;
  /** Base env to derive the hygienic run env from (usually process.env). */
  baseEnv?: NodeJS.ProcessEnv;
}

export interface RunCommitResult {
  sha: string;
  status: 'ok' | 'BROKEN';
  reason: string;
  totalMs: number;
  statsPath: string;
  outcomesPath?: string;
  graphPath?: string;
  decision?: ShadowDecision;
}

/**
 * Replay a single commit end-to-end:
 *  1. ref control (detach C, main -> C^)
 *  2. run `vitest run --reporter=json`, full suite, shadow on, per-commit stats
 *  3. capture ground-truth outcomes JSON
 *  4. read the shadow decision from the stats file (fail-closed guard)
 *  5. copy the post-run graph.json (fresh runtime edge map at C)
 *
 * Any install/run failure or a missing shadow line yields status BROKEN with an
 * itemized reason — never a silent clean.
 *
 * NOTE: this is exercised end-to-end by the deferred BCA acceptance run (needs a
 * ~6GB clone + a ~320s suite per commit); the unit tests cover its pure pieces
 * (ref control, env hygiene, shadow parsing) against small synthetic repos.
 */
export async function runCommit(
  opts: RunCommitOptions,
): Promise<RunCommitResult> {
  const { cloneDir, sha, statsDir, outcomesDir, graphsDir } = opts;
  const baseEnv = opts.baseEnv ?? process.env;
  const statsPath = path.join(statsDir, `${sha}.jsonl`);
  const outcomesPath = path.join(outcomesDir, `${sha}.json`);
  const graphPath = path.join(graphsDir, `${sha}.json`);
  const start = Date.now();

  const broken = (reason: string): RunCommitResult => ({
    sha,
    status: 'BROKEN',
    reason,
    totalMs: Date.now() - start,
    statsPath,
  });

  try {
    await setRefToParent(cloneDir, sha);
  } catch (err) {
    return broken(`ref control failed: ${errText(err)}`);
  }

  await mkdir(statsDir, { recursive: true });
  const env = buildRunEnv(baseEnv, statsPath);

  let stdout: string;
  try {
    const result = await execa(
      'npx',
      ['vitest', 'run', '--reporter=json'],
      // extendEnv:false — the child gets EXACTLY buildRunEnv's env, never an
      // extension of the parent process.env (which would re-introduce the CI /
      // GITHUB_ACTIONS / VITEST_AFFECTED_DISABLED keys buildRunEnv deletes; see
      // its doc comment). `env` is a full copy of the base env, so PATH etc. are
      // carried through.
      { cwd: cloneDir, env, reject: false, extendEnv: false },
    );
    stdout = result.stdout;
  } catch (err) {
    return broken(`vitest invocation failed: ${errText(err)}`);
  }

  // (a) Ground-truth outcomes JSON — persist even if unparseable for triage.
  await writeFile(outcomesPath, stdout, 'utf-8');

  // (b) Shadow decision — the fail-closed guard.
  let decision: ShadowDecision | null = null;
  if (existsSync(statsPath)) {
    const statsContent = await readFile(statsPath, 'utf-8');
    decision = parseShadowStatsLine(statsContent);
  }
  if (decision === null) {
    return broken('no shadow stats line emitted (fail-closed)');
  }

  // (c) Post-run graph.json — the complete fresh runtime edge map at C.
  const graphSrc = path.join(cloneDir, '.vitest-affected', 'graph.json');
  let capturedGraph: string | undefined;
  if (existsSync(graphSrc)) {
    await copyFile(graphSrc, graphPath);
    capturedGraph = graphPath;
  }

  return {
    sha,
    status: 'ok',
    reason: 'ok',
    totalMs: Date.now() - start,
    statsPath,
    outcomesPath,
    graphPath: capturedGraph,
    decision,
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
