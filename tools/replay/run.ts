/**
 * Replay harness CLI entry.
 *
 *   npx tsx tools/replay/run.ts --repo <path> --range <from>..<to> [--sample <n>]
 *
 * Devtool only: NOT part of the published package (absent from package.json
 * files/exports and the tsup entries). It drives the plugin through the
 * consumer's OWN vitest config — it imports nothing from src/. The analysis
 * layer (analysis.ts / evolution.ts / detector.ts / report.ts) runs after the
 * walk and imports mergeRuntimeEdges from dist (never src).
 */
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execa } from 'execa';
import {
  getFirstParentChain,
  getCommitChangedFiles,
  classifyCommit,
  getLockfileHash,
  shouldReinstall,
} from './walker.js';
import {
  resolveWorkdirRoot,
  symlinkDist,
  cloneConsumer,
  createRunDir,
  removeClone,
  CONSUMER_DIRNAME,
} from './workdir.js';
import { runCommit } from './exec.js';
import { runGit } from './git-cmd.js';
import { killTrackedChildren } from './child-registry.js';
import { INSTALL_TIMEOUT_MS, SIGNAL_CHILD_GRACE_MS } from './limits.js';
import {
  analyzeAndReport,
  flakeCheckCommit,
  spawnDisabledRerun,
  parseOutcomes,
} from './analysis.js';
import type { FlakeLogEntry } from './analysis.js';
import type { LedgerEntry } from './types.js';

export interface CliArgs {
  help: boolean;
  repo?: string;
  range?: string;
  sample?: number;
  /** Re-run ONLY the analysis + report over an existing run dir. */
  analyzeOnly?: string;
  /** Clone root override for --analyze-only path resolution. */
  root?: string;
  /** Keep the multi-GB consumer clone after the walk (for debugging). */
  keepWorkdir?: boolean;
}

export const USAGE = `vitest-affected replay harness

Replays a consumer repo's git history through the REAL plugin (driven via the
consumer's own vitest config) to measure the plugin's true miss-rate.

Usage:
  npx tsx tools/replay/run.ts --repo <path> --range <from>..<to> [--sample <n>]
  npx tsx tools/replay/run.ts --analyze-only <runDir> [--root <cloneDir>]

Options:
  --repo <path>        Path to the consumer repo to clone (e.g. body-compass-app).
  --range <from>..<to> Commit range to walk (first-parent chain of main).
  --sample <n>         Replay only the most recent <n> commits of the range.
  --analyze-only <dir> Skip the walk: re-run analysis + report over an existing
                       run dir (walks are ~320s/commit; analysis iterates fast).
  --root <path>        Clone root for --analyze-only path resolution (defaults
                       to <runDir>/../../${CONSUMER_DIRNAME}, the A2a layout).
  --keep-workdir       Do NOT delete the multi-GB consumer clone after the walk
                       (default: the clone is torn down; run artifacts survive).
                       Use when debugging a walk against the clone's final state.
  -h, --help           Show this help.

Notes:
  Requires this repo to be built first (npm run build) — the harness symlinks
  <workdir>/vitest-affected/dist -> ./dist so the consumer config loads the real
  plugin instead of its silent no-op fallback.
`;

/**
 * Parse argv (the slice AFTER node + script). Pure. Throws on malformed input;
 * callers print USAGE and exit non-zero. `--help` / `-h` short-circuits with
 * help=true and no validation.
 */
export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '-h':
      case '--help':
        return { help: true };
      case '--repo':
        args.repo = argv[++i];
        break;
      case '--range':
        args.range = argv[++i];
        break;
      case '--sample': {
        const raw = argv[++i];
        const n = Number(raw);
        if (!Number.isInteger(n) || n <= 0) {
          throw new Error(`--sample must be a positive integer (got: ${raw})`);
        }
        args.sample = n;
        break;
      }
      case '--analyze-only':
        args.analyzeOnly = argv[++i];
        break;
      case '--root':
        args.root = argv[++i];
        break;
      case '--keep-workdir':
        args.keepWorkdir = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (args.help) return args;
  if (args.analyzeOnly !== undefined) {
    if (!args.analyzeOnly) {
      throw new Error('--analyze-only requires a run dir path');
    }
    // Analysis-only mode needs no walk arguments.
    return args;
  }
  if (!args.repo) throw new Error('--repo is required');
  if (!args.range) throw new Error('--range is required');
  if (!/^.+\.\..+$/.test(args.range)) {
    throw new Error(`--range must be of the form <from>..<to> (got: ${args.range})`);
  }
  return args;
}

/** Absolute path to this repo's built dist (../../dist from tools/replay). */
export function resolveDistPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'dist');
}

/**
 * Orchestrate a full replay walk. Returns the run directory path. Heavy — the
 * per-commit loop clones the consumer and runs its full suite; the deferred BCA
 * acceptance run exercises this against real history.
 */
export async function main(argv: string[]): Promise<string> {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(USAGE);
    return '';
  }

  // ANALYZE-ONLY: re-run the analysis + report over an existing run dir —
  // analysis must iterate fast on expensive walk data (~320s/commit).
  if (args.analyzeOnly !== undefined) {
    const runDir = path.resolve(args.analyzeOnly);
    const rootDir = args.root
      ? path.resolve(args.root)
      : path.resolve(runDir, '..', '..', CONSUMER_DIRNAME);
    const reportPath = await analyzeAndReport({ runDir, rootDir });
    process.stdout.write(`[replay] analysis report: ${reportPath}\n`);
    return runDir;
  }

  const repo = args.repo as string;
  const range = args.range as string;

  const distPath = resolveDistPath();
  if (!existsSync(distPath)) {
    throw new Error(
      `Built dist not found at ${distPath} — run \`npm run build\` first.`,
    );
  }

  const workdir = resolveWorkdirRoot();
  symlinkDist(workdir, distPath);
  const cloneDir = await cloneConsumer(workdir, repo);
  // Teardown: the consumer clone is multi-GB and per-run. Remove it on ANY exit
  // (normal, thrown, or signal) unless --keep-workdir is set — ONLY the clone
  // goes; run artifacts under <workdir>/runs survive. Idempotent so the finally
  // block and the signal handlers can't double-free.
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned || args.keepWorkdir) return;
    cleaned = true;
    removeClone(cloneDir);
  };
  // Signal handling is ORDER-CRITICAL: a live ~320s vitest child (spawned via
  // execa several frames down in runCommit / spawnDisabledRerun) may be running
  // when Ctrl-C arrives. Deleting the clone out from under its worker pool — or
  // just exiting and orphaning it — is the gap. So: terminate every tracked
  // child FIRST (SIGTERM, execa-escalated to SIGKILL, bounded wait), THEN remove
  // the clone, THEN exit. Idempotent re-entrancy guard so a coincident
  // SIGINT+SIGTERM (or a repeat) doesn't run the teardown twice.
  let signalHandled = false;
  const onSignal = (sig: NodeJS.Signals): void => {
    if (signalHandled) return;
    signalHandled = true;
    void (async () => {
      try {
        await killTrackedChildren(SIGNAL_CHILD_GRACE_MS);
      } finally {
        cleanup();
        // Reflect the interruption in the exit code (128 + signal number) — a
        // walk killed with Ctrl-C must not exit 0 and look clean.
        process.exit(sig === 'SIGINT' ? 130 : 143);
      }
    })();
  };
  // `.on`, NOT `.once`: the re-entrancy guard (signalHandled) already makes a
  // repeat signal a no-op, but `.once` REMOVES the listener after the first fire —
  // a second Ctrl-C would then reach Node's default handler and hard-kill the
  // process mid-teardown (orphaning workers + a half-deleted clone, the exact
  // failure this machinery exists to prevent). Keeping the listener installed
  // routes every repeat back through the guard, where it is absorbed as a no-op.
  // The finally block removes both listeners on exit.
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    const dirs = createRunDir(workdir);

    let chain = await getFirstParentChain(cloneDir, range);
    if (typeof args.sample === 'number') {
      chain = chain.slice(-args.sample);
    }

    process.stdout.write(
      `[replay] workdir=${workdir}\n[replay] run=${dirs.runDir}\n[replay] commits=${chain.length}\n`,
    );

    let prevLockHash: string | null = null;
    // Outcomes at the previous ok commit — the C-1 side of the flake guard.
    // null = no baseline yet: the FIRST measurable commit must NOT flake-check
    // (every failure would spuriously look "new" and a baseline-broken test
    // would be laundered into 'flaky'); its outcomes become the baseline.
    let prevOutcomes: Map<string, string> | null = null;
    for (const sha of chain) {
      // SIGNAL GATE (loop head). The signal handler runs ASYNC — it awaits
      // killTrackedChildren before removing the clone — so the walk loop must not
      // keep advancing underneath it. Without this gate the current child dies
      // fast under SIGTERM, `await runCommit` returns, and the loop rolls into the
      // NEXT commit's resetClone/installDeps/spawnDisabledRerun — spawning work on
      // (or a child against) a clone the handler is about to rmSync, and orphaning
      // any child spawned after the handler's kill snapshot. Stop the moment a
      // signal is latched; the handler owns teardown + the exit code.
      if (signalHandled) break;
      const changedFiles = await getCommitChangedFiles(cloneDir, sha);
      const cls = classifyCommit(sha, changedFiles);
      if (cls.skip) {
        await appendLedger(dirs.ledgerPath, {
          sha,
          status: 'skipped',
          reason: `config/lockfile touched: ${cls.skipTriggers.join(', ')}`,
          timings: { totalMs: 0 },
          changedFiles,
        });
        process.stdout.write(`[replay] ${sha} SKIPPED (${cls.skipTriggers.join(', ')})\n`);
        continue;
      }

      // Checkout must happen before hashing the lockfile at this commit; runCommit
      // does the checkout, so mirror the ref state here for install policy.
      try {
        await ensureInstallForCommit(cloneDir, sha, prevLockHash).then((h) => {
          prevLockHash = h;
        });
      } catch (err) {
        await appendLedger(dirs.ledgerPath, {
          sha,
          status: 'BROKEN',
          reason: `install failed: ${err instanceof Error ? err.message : String(err)}`,
          timings: { totalMs: 0 },
          changedFiles,
        });
        process.stdout.write(`[replay] ${sha} BROKEN (install)\n`);
        continue;
      }

      // SIGNAL GATE (post-install resumption). The install above awaits for
      // minutes; a signal can land inside it. Do not spawn the ~320s run child
      // onto a clone the handler is tearing down.
      if (signalHandled) break;
      const result = await runCommit({
        cloneDir,
        sha,
        statsDir: dirs.statsDir,
        outcomesDir: dirs.outcomesDir,
        graphsDir: dirs.graphsDir,
      });
      await appendLedger(dirs.ledgerPath, {
        sha: result.sha,
        status: result.status,
        reason: result.reason,
        timings: { totalMs: result.totalMs },
        ...(result.decision ? { decision: result.decision } : {}),
        changedFiles,
      });
      process.stdout.write(`[replay] ${sha} ${result.status} (${result.reason})\n`);

      // SIGNAL GATE (post-run resumption). A signal almost always lands DURING the
      // run child above; when it dies under SIGTERM `await runCommit` returns here.
      // The flake guard below spawns a fresh disabled-rerun child — do not, or it
      // survives the handler's kill snapshot and is orphaned when the clone is
      // removed. Break BEFORE spawning.
      if (signalHandled) break;

      // FLAKE GUARD — wired here, where per-commit outcomes are first available:
      // a NEW failure (failed at C, not at C-1) is re-run ONCE with the plugin
      // fully disabled (no cache/stats side effects). Re-runs are logged to
      // flake-log.jsonl; the analysis excludes logged flakes from the
      // outcome-confirmed tier.
      if (result.status === 'ok' && result.outcomesPath) {
        const curOutcomes = parseOutcomes(
          await readFile(result.outcomesPath, 'utf-8'),
        );
        const flake = await flakeCheckCommit(sha, prevOutcomes, curOutcomes, () =>
          spawnDisabledRerun(cloneDir),
        );
        if (flake.reran) {
          const logEntry: FlakeLogEntry = {
            sha,
            newFailures: flake.newFailures,
            confirmed: flake.confirmed,
            flaky: flake.flaky,
          };
          await appendFile(
            path.join(dirs.runDir, 'flake-log.jsonl'),
            JSON.stringify(logEntry) + '\n',
            'utf-8',
          );
          process.stdout.write(
            `[replay] ${sha} flake-guard re-run: ${flake.newFailures.length} new failure(s), ` +
              `${flake.confirmed.length} confirmed, ${flake.flaky.length} flaky\n`,
          );
        }
        if (curOutcomes.size > 0) prevOutcomes = curOutcomes;
      }
    }

    // SIGNAL GATE (post-loop). If a signal latched mid-walk, one of the gates
    // above broke us out of the loop while the handler tears down. Do NOT run the
    // analysis — it reads the clone (rootDir: cloneDir) the handler is removing,
    // and the handler owns the interrupted exit code. Return the run dir; the
    // finally-block cleanup is idempotent and no child is live (the gates stopped
    // all further spawns), so the handler's killTrackedChildren + rmSync race
    // nothing.
    if (signalHandled) return dirs.runDir;

    // ANALYSIS (A2b) — turn the raw artifacts into the honest measurement. The
    // degeneration guard (zero selective decisions across the walk) throws here,
    // surfacing on the report path (CLI exits non-zero) — but only AFTER the
    // diagnosis analysis.md has been written into the run dir (analyzeAndReport),
    // so the expensive walk stays diagnosable and re-analyzable without a
    // re-walk (--analyze-only).
    const reportPath = await analyzeAndReport({
      runDir: dirs.runDir,
      rootDir: cloneDir,
    });
    process.stdout.write(`[replay] analysis report: ${reportPath}\n`);

    return dirs.runDir;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    cleanup();
  }
}

/**
 * Reset the commit's clone, checkout the commit, and reconcile the install:
 * reinstall when the lockfile hash changed. Returns the lockfile hash observed at
 * this commit (the new prev-hash for the next iteration).
 */
async function ensureInstallForCommit(
  cloneDir: string,
  sha: string,
  prevLockHash: string | null,
): Promise<string | null> {
  // Reset the throwaway clone to a pristine tree BEFORE checking out this commit.
  // A previous commit's `pnpm install` (or any non-frozen dependency resolve) can
  // leave the tracked lockfile / working tree dirty; without this reset the next
  // `checkout --detach` aborts ("local changes would be overwritten") and every
  // later commit cascades to BROKEN for the rest of a multi-hour walk. Scoped to
  // cloneDir — a disposable clone under the OS temp dir (resolveWorkdirRoot /
  // cloneConsumer in workdir.ts) — so a hard reset + clean is safe.
  await resetClone(cloneDir);

  // A detached checkout is needed to read the lockfile at this commit; runCommit
  // re-detaches at the same sha, so this is idempotent.
  await runGit(cloneDir, ['checkout', '--detach', sha]);
  const curHash = await getLockfileHash(cloneDir);
  await installDeps(cloneDir, shouldReinstall(prevLockHash, curHash));
  return curHash;
}

/**
 * Reset the disposable consumer clone to a pristine tree: discard tracked-file
 * modifications (`git reset --hard`) and remove untracked, non-ignored files
 * (`git clean -fd` — WITHOUT `-x`, so gitignored node_modules survives and stays
 * off the critical path). cloneDir is a throwaway clone under the OS temp dir
 * (workdir.ts), so a destructive reset is safe here.
 *
 * `-e .vitest-affected`: the accumulating plugin cache MUST survive every reset.
 * `.vitest-affected/` is only gitignored from a certain commit onward in the
 * walked repo (BCA), so on OLDER commits `git clean -fd` (which deletes untracked
 * NON-ignored files) would wipe the cache every iteration — degrading every
 * decision to a cold cache-miss/full-suite and eventually tripping the analysis'
 * degeneration guard. The explicit exclude protects the cache regardless of
 * whether the checked-out commit's .gitignore happens to cover it.
 */
async function resetClone(cloneDir: string): Promise<void> {
  await runGit(cloneDir, ['reset', '--hard']);
  await runGit(cloneDir, ['clean', '-fd', '-e', '.vitest-affected']);
}

/**
 * Install dependencies in the clone, preferring a FROZEN lockfile so pnpm never
 * rewrites the tracked pnpm-lock.yaml mid-walk (that rewrite is what dirtied the
 * tree and cascaded later checkouts to BROKEN). When the lockfile legitimately
 * does not match package.json at THIS historical commit, `--frozen-lockfile`
 * refuses (ERR_PNPM_OUTDATED_LOCKFILE) — a normal fact of walking old history,
 * not a harness failure — so we fall back to a non-frozen install for that commit
 * (the next iteration's resetClone discards any resulting lockfile rewrite). Any
 * OTHER failure throws, preserving the caller's install → BROKEN taxonomy.
 */
async function installDeps(cloneDir: string, reinstall: boolean): Promise<void> {
  if (!reinstall) return;
  // INSTALL_TIMEOUT_MS: a wedged install must not stall an unattended walk. These
  // spawns do NOT set `reject: false`, so on timeout execa THROWS (ExecaError with
  // timedOut:true) — the throw propagates to ensureInstallForCommit's caller
  // (run.ts main loop try/catch) and is classified install→BROKEN, so the walk
  // continues past a hung commit rather than aborting.
  try {
    await execa('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], {
      cwd: cloneDir,
      timeout: INSTALL_TIMEOUT_MS,
    });
    return;
  } catch (err) {
    if (!isFrozenLockfileMismatch(err)) throw err;
  }
  // Legitimate lockfile / package.json drift at this commit — resolve normally.
  await execa('pnpm', ['install', '--prefer-offline'], {
    cwd: cloneDir,
    timeout: INSTALL_TIMEOUT_MS,
  });
}

/**
 * True when an execa error looks like pnpm refusing a frozen install because the
 * lockfile is out of sync with package.json (the ONE failure we retry non-frozen,
 * vs. genuine install failures which must propagate to BROKEN).
 */
function isFrozenLockfileMismatch(err: unknown): boolean {
  if (!(err && typeof err === 'object')) return false;
  const parts: string[] = [];
  for (const key of ['stderr', 'stdout', 'shortMessage', 'message'] as const) {
    const value = (err as Record<string, unknown>)[key];
    if (typeof value === 'string') parts.push(value);
  }
  return /ERR_PNPM_OUTDATED_LOCKFILE|frozen-lockfile|lockfile[^\n]*(?:up to date|out of date|not match|outdated)/i.test(
    parts.join('\n'),
  );
}

async function appendLedger(
  ledgerPath: string,
  entry: LedgerEntry,
): Promise<void> {
  await appendFile(ledgerPath, JSON.stringify(entry) + '\n', 'utf-8');
}

// Run as a script (npx tsx tools/replay/run.ts ...) — but not when imported.
const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`\n[replay] error: ${msg}\n\n`);
    process.stderr.write(USAGE);
    process.exit(1);
  });
}
