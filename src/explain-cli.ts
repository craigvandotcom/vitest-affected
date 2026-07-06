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

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg || arg === '-h' || arg === '--help') {
    console.log('usage: vitest-affected-explain <testfile>');
    console.log(
      'Explains why a test would (or would not) be selected right now, against',
    );
    console.log('the .vitest-affected cache and the current git working state.');
    process.exitCode = arg ? 0 : 2;
    return;
  }

  const rootDir = toCanonicalPath(process.cwd());
  const testFile = toCanonicalPath(
    path.isAbsolute(arg) ? arg : path.resolve(rootDir, arg),
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

  const { changed, deleted } = await getChangedFiles(rootDir);
  const seeds = [...changed, ...deleted].map((f) => toCanonicalPath(f));
  const result = explainSelection(testFile, seeds, reverse);
  printResult(result, seeds);
}

void main();
