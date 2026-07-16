#!/usr/bin/env node
/**
 * vitest-affected-explain — consumer-facing CLI that answers, ad hoc, "why
 * would test X be selected right now?" / "why not?" against the on-disk
 * dependency cache and the current git state.
 *
 * Shipped as a package `bin` (built into the published bundle by tsup) rather
 * than a repo-only `tools/` script, because CONSUMERS need it: a developer
 * whose selective run skipped a test they expected can run
 * `npx vitest-affected-explain path/to/foo.test.ts` in their own project.
 *
 * This file is a PURE SIDE-EFFECT entry — it exports nothing and runs `main()`
 * on load. The testable decision logic lives in `explain-core.ts` (imported
 * here and re-exported by the package index); package.json `sideEffects` marks
 * this file so the bundler never tree-shakes the `main()` call away.
 *
 * Seeds = the raw changed + deleted files from git (the same first-order seeds
 * the plugin feeds the BFS). DELIBERATE APPROXIMATION: the plugin ALSO
 * delta-parses changed files for brand-new imports not yet in the cache and
 * adds those as extra seeds; the CLI omits that step (it would need the Vite
 * resolver + alias config the plugin has but a standalone CLI does not). The
 * only divergence is the rare case where a changed file gained a NEW import
 * since the last run — the CLI may then under-report a selection the live
 * plugin would make. Documented so the output is trusted for what it is: a
 * cache-grounded explanation, not a re-run of the full decision pipeline.
 */
import path from 'node:path';
import { globSync } from 'tinyglobby';
import { loadCachedReverseMap } from './graph/cache.js';
import { getChangedFiles } from './git.js';
import { safeLabel, toCanonicalPath } from './graph/normalize.js';
import { explainSelection, type ExplainResult } from './explain-core.js';

/** Render an ExplainResult to stdout. */
function printResult(result: ExplainResult, seeds: string[]): void {
  if (result.selected) {
    console.log(`SELECTED: ${safeLabel(result.testFile)}`);
    // reason embeds the seed path (explain-core), so sanitize it too.
    console.log(`  why: ${safeLabel(result.reason)}`);
    console.log(`  seed: ${result.seed === null ? 'null' : safeLabel(result.seed)}`);
    console.log('  chain:');
    result.chain.forEach((node, i) => {
      const arrow = i === 0 ? '' : '  ↳ ';
      console.log(`    ${arrow}${safeLabel(node)}`);
    });
  } else {
    console.log(`NOT SELECTED: ${safeLabel(result.testFile)}`);
    console.log(`  why not: ${safeLabel(result.reason)}`);
    if (seeds.length > 0) {
      console.log(`  changed files considered (${seeds.length}):`);
      for (const s of seeds.slice(0, 20)) console.log(`    - ${safeLabel(s)}`);
      if (seeds.length > 20) console.log(`    … (+${seeds.length - 20} more)`);
    }
  }
}

interface ParsedArgs {
  help: boolean;
  /** First non-flag positional — the test file to explain. */
  testFile?: string;
  /** Repeatable --include globs (in order given). */
  includes: string[];
}

/**
 * Minimal argv parse: `--include <glob>` (or `--include=<glob>`) is repeatable
 * and may interleave with the positional; the FIRST non-flag argument is the
 * test file. `-h`/`--help` set the help flag.
 */
function parseArgs(argv: string[]): ParsedArgs {
  const includes: string[] = [];
  let testFile: string | undefined;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      help = true;
    } else if (a === '--include') {
      const val = argv[++i];
      if (val !== undefined) includes.push(val);
    } else if (a.startsWith('--include=')) {
      includes.push(a.slice('--include='.length));
    } else if (testFile === undefined) {
      testFile = a;
    }
    // Extra positionals are ignored — the first non-flag wins.
  }
  return { help, testFile, includes };
}

/** Split a comma/space-separated VITEST_AFFECTED_INCLUDE env value into globs. */
function parseEnvIncludes(env: string | undefined): string[] {
  if (!env) return [];
  return env
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function printUsage(): void {
  console.log('usage: vitest-affected-explain [--include <glob>]... <testfile>');
  console.log(
    'Explains why a test would (or would not) be selected right now, against',
  );
  console.log('the .vitest-affected cache and the current git working state.');
  console.log('');
  console.log('Options:');
  console.log('  --include <glob>   Vitest include glob(s) defining which files count as test');
  console.log('                     files (repeatable). Learned from an EXPLICIT source rather');
  console.log('                     than by booting Vitest, preserving the standalone stance.');
  console.log('                     Also settable via the VITEST_AFFECTED_INCLUDE env var');
  console.log('                     (comma/space-separated globs); the flag takes precedence.');
  console.log('                     When no glob is supplied (or none match), falls back to the');
  console.log('                     default heuristic matcher /\\.(test|spec)\\.[cm]?[jt]sx?$/.');
}

async function main(): Promise<void> {
  const { help, testFile: testArg, includes: flagIncludes } = parseArgs(
    process.argv.slice(2),
  );

  if (help) {
    printUsage();
    process.exitCode = 0;
    return;
  }
  if (!testArg) {
    printUsage();
    process.exitCode = 2;
    return;
  }

  const rootDir = toCanonicalPath(process.cwd());
  const testFile = toCanonicalPath(
    path.isAbsolute(testArg) ? testArg : path.resolve(rootDir, testArg),
  );
  const cacheDir = path.join(rootDir, '.vitest-affected');

  const { reverse, hit } = loadCachedReverseMap(cacheDir, rootDir);
  if (!hit) {
    console.log(
      `[vitest-affected-explain] No usable dependency cache at ${cacheDir} — ` +
        'the FULL suite would run (nothing to select from). Run the suite once ' +
        'to populate the cache, then re-run this command.',
    );
    return;
  }

  // Learn the test-file globs from an explicit source (flag > env). When globs
  // are supplied AND resolve to ≥1 file, membership in that canonical set
  // decides test-file-ness — matching the project's real Vitest `include` for
  // custom layouts (__tests__/, .e2e.ts, …). Otherwise leave isTestFile
  // undefined so explainSelection falls back to its DEFAULT_TEST_MATCHER. The
  // glob (IO) lives HERE, not in the IO-free explain-core.
  const includes =
    flagIncludes.length > 0
      ? flagIncludes
      : parseEnvIncludes(process.env.VITEST_AFFECTED_INCLUDE);
  let isTestFile: ((p: string) => boolean) | undefined;
  if (includes.length > 0) {
    const testSet = new Set(
      globSync(includes, { cwd: rootDir, absolute: true }).map(toCanonicalPath),
    );
    if (testSet.size > 0) {
      isTestFile = (p) => testSet.has(p);
    }
  }

  const { changed, deleted } = await getChangedFiles(rootDir);
  const seeds = [...changed, ...deleted].map((f) => toCanonicalPath(f));
  const result = explainSelection(testFile, seeds, reverse, isTestFile);
  printResult(result, seeds);
}

void main();
