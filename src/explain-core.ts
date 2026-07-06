/**
 * Pure explain core — the "why would test X be selected / why not" decision,
 * with no IO. Shared by the public API (index.ts) and the
 * `vitest-affected-explain` CLI (explain-cli.ts). Kept separate from the CLI
 * entry so the CLI can be a pure side-effect bin while this stays a
 * tree-shakeable library export.
 */
import { bfsAffectedTestsWithProvenance } from './selector.js';
import type { ReverseMap } from './graph/types.js';

/**
 * Default test-file matcher used by the CLI in place of the project's Vitest
 * `include` globs (which would require booting Vitest's config resolution).
 * It only decides which nodes the BFS LABELS as tests — reachability of the
 * queried file is independent of it — so a heuristic is safe here.
 */
export const DEFAULT_TEST_MATCHER = /\.(test|spec)\.[cm]?[jt]sx?$/;

export interface ExplainResult {
  testFile: string;
  selected: boolean;
  /** The changed seed that reached the test (selected case only). */
  seed: string | null;
  /** Full edge chain seed → … → test (selected case only). */
  chain: string[];
  /** Human-readable why / why-not. */
  reason: string;
}

/**
 * Given the queried test file, the BFS seeds (changed + deleted files), and the
 * reverse graph, decide whether the test would be selected and why.
 */
export function explainSelection(
  testFile: string,
  seeds: string[],
  reverse: ReverseMap,
  isTestFile: (p: string) => boolean = (p) => DEFAULT_TEST_MATCHER.test(p),
): ExplainResult {
  if (!isTestFile(testFile)) {
    return {
      testFile,
      selected: false,
      seed: null,
      chain: [],
      reason:
        'not a test file — it does not match the default test matcher ' +
        '/\\.(test|spec)\\.[cm]?[jt]sx?$/, so it is never a selection target',
    };
  }
  if (seeds.length === 0) {
    return {
      testFile,
      selected: false,
      seed: null,
      chain: [],
      reason:
        'no changed files detected — with nothing changed the plugin runs the ' +
        'FULL suite (there is no selective subset to explain)',
    };
  }
  const { provenance } = bfsAffectedTestsWithProvenance(seeds, reverse, isTestFile);
  const trail = provenance.get(testFile);
  if (trail) {
    const hops = trail.chain.length - 1;
    return {
      testFile,
      selected: true,
      seed: trail.seed,
      chain: trail.chain,
      reason:
        `reached from changed file ${trail.seed} via ${hops} edge(s)` +
        (hops === 0 ? ' (the test file itself changed)' : ''),
    };
  }
  return {
    testFile,
    selected: false,
    seed: null,
    chain: [],
    reason:
      'not reachable from any changed file through the cached dependency ' +
      'graph — no import chain connects a changed file to this test',
  };
}
