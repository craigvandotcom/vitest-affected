/**
 * Replay harness CLI entry.
 *
 *   npx tsx tools/replay/run.ts --repo <path> --range <from>..<to> [--sample <n>]
 *
 * Devtool only: NOT part of the published package (absent from package.json
 * files/exports and the tsup entries). It drives the plugin through the
 * consumer's OWN vitest config — it imports nothing from src/. The analysis
 * layer (a later bead) imports mergeRuntimeEdges from dist.
 */
import { appendFile } from 'node:fs/promises';
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
} from './workdir.js';
import { runCommit } from './exec.js';
import { runGit } from './git-cmd.js';
import type { LedgerEntry } from './types.js';

export interface CliArgs {
  help: boolean;
  repo?: string;
  range?: string;
  sample?: number;
}

export const USAGE = `vitest-affected replay harness

Replays a consumer repo's git history through the REAL plugin (driven via the
consumer's own vitest config) to measure the plugin's true miss-rate.

Usage:
  npx tsx tools/replay/run.ts --repo <path> --range <from>..<to> [--sample <n>]

Options:
  --repo <path>        Path to the consumer repo to clone (e.g. body-compass-app).
  --range <from>..<to> Commit range to walk (first-parent chain of main).
  --sample <n>         Replay only the most recent <n> commits of the range.
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
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (args.help) return args;
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
  for (const sha of chain) {
    const changedFiles = await getCommitChangedFiles(cloneDir, sha);
    const cls = classifyCommit(sha, changedFiles);
    if (cls.skip) {
      await appendLedger(dirs.ledgerPath, {
        sha,
        status: 'skipped',
        reason: `config/lockfile touched: ${cls.skipTriggers.join(', ')}`,
        timings: { totalMs: 0 },
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
    });
    process.stdout.write(`[replay] ${sha} ${result.status} (${result.reason})\n`);
  }

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
