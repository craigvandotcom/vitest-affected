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
import {
  getFirstParentChain,
  getCommitChangedFiles,
  classifyCommit,
  getLockfileHash,
  shouldReinstall,
  ensureInstall,
} from './walker.js';
import {
  resolveWorkdirRoot,
  symlinkDist,
  cloneConsumer,
  createRunDir,
  CONSUMER_DIRNAME,
} from './workdir.js';
import { runCommit } from './exec.js';
import { runGit } from './git-cmd.js';
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
}

/**
 * Checkout the commit and reconcile the install: reinstall when the lockfile
 * hash changed. Returns the lockfile hash observed at this commit (the new
 * prev-hash for the next iteration).
 */
async function ensureInstallForCommit(
  cloneDir: string,
  sha: string,
  prevLockHash: string | null,
): Promise<string | null> {
  // A detached checkout is needed to read the lockfile at this commit; runCommit
  // re-detaches at the same sha, so this is idempotent.
  await runGit(cloneDir, ['checkout', '--detach', sha]);
  const curHash = await getLockfileHash(cloneDir);
  await ensureInstall(cloneDir, shouldReinstall(prevLockHash, curHash));
  return curHash;
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
