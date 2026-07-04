/**
 * Evolution — simulated selective cache reconstruction.
 *
 * WHY THIS EXISTS (trap #1): the replay harness runs the FULL suite at every
 * commit to capture ground truth, and the plugin's reporter persists the
 * clone's cache with scope 'all' after each run — so both the clone's cache
 * AND the recorded shadow decisions are drift-free. A live consumer is NOT: a
 * selective run only re-records the tests it actually ran, so its cache
 * DRIFTS (unselected tests keep whatever edges they last recorded). Naively
 * reusing either the harness cache or the recorded selections erases exactly
 * the staleness this measurement is about.
 *
 * So we reconstruct the cache a LIVE run would hold, commit by commit:
 *
 *   cache_{C+1} = mergeRuntimeEdges(cache_C, freshMap_C, scope_C)
 *
 * where `freshMap_C` is the ground-truth full runtime map captured at C and
 * `scope_C` reflects what a live run at C would ACTUALLY have persisted:
 *
 *  - Cold cache (first evolved commit): a live deployment has no cache file →
 *    full-suite → persists everything → scope 'all'. This is exactly how
 *    commit #1 warms the cold cache.
 *  - Recorded shadow-selective: a live run would have selected from the
 *    DRIFTED cache, run that selection, and persisted only its edges → scope
 *    = the SIMULATED selection at C (NOT the recorded selectedFiles — those
 *    were computed against the harness's always-fresh cache; feeding them
 *    into evolution breaks the drift feedback loop and optimistically biases
 *    miss-rates as drift accumulates).
 *  - Recorded shadow-full-suite with a cache-INDEPENDENT reason (the decision
 *    does not depend on cache state: config-change, setup-file-change,
 *    global-setup-change, full-suite-trigger, no-changes, workspace,
 *    config-shape): a live deployment would also have gone full-suite →
 *    scope 'all'.
 *  - Recorded shadow-full-suite with a cache-DEPENDENT reason (cache-miss —
 *    cannot happen live once the evolved cache exists; no-affected-tests /
 *    threshold-exceeded and other selection-size-dependent reasons — the live
 *    decision hinges on drifted-cache content): treat as selective — a live
 *    pipeline would have run and persisted its simulated selection. Unlisted
 *    reasons default to cache-dependent (conservative: never optimistically
 *    refreshes the drifted cache).
 *  - Empty simulated selection (any non-exempt decision): the live plugin's
 *    own no-affected-tests fallback runs the FULL suite and persists
 *    everything — live self-healing → scope 'all'.
 *
 * IMPORT NOTE (load-bearing): mergeRuntimeEdges is imported from the BUILT
 * package root ('../../dist/index.js') — the same artifact the replay harness
 * ships against — NOT from '../../src/runtime-merge.js'. Importing src would
 * measure unbuilt code and recreate logic drift; run `npm run build` if dist
 * is stale/missing. The ReverseMap type comes from the dist declarations.
 */
import { mergeRuntimeEdges } from '../../dist/index.js';
import type { ReverseMap } from '../../dist/index.js';
import { simulateLiveSelection, testsOf } from './detector.js';
import type { ShadowDecision } from './types.js';

/** The merge scope mergeRuntimeEdges accepts: a selected set, or 'all'. */
export type MergeScope = Set<string> | 'all';

/**
 * Full-suite reasons whose decision does NOT depend on cache state — a live
 * deployment with a drifted cache would have made the same full-suite call,
 * run everything, and persisted everything (scope 'all').
 */
export const CACHE_INDEPENDENT_FULL_SUITE_REASONS: ReadonlySet<string> =
  new Set([
    'config-change',
    'setup-file-change',
    'global-setup-change',
    'full-suite-trigger',
    'no-changes',
    'workspace',
    'config-shape',
  ]);

/**
 * The persistence scope a live run would apply, given the recorded decision
 * and the selection SIMULATED from the drifted cache (see module header for
 * the full rule table). The cold-cache rule lives in evolveStep — it needs
 * the cache itself.
 */
export function evolutionScope(
  decision: ShadowDecision,
  simulatedSelection: ReadonlySet<string>,
): MergeScope {
  if (
    decision.action === 'shadow-full-suite' &&
    CACHE_INDEPENDENT_FULL_SUITE_REASONS.has(decision.reason ?? '')
  ) {
    return 'all';
  }
  // Recorded selective, or cache-dependent full-suite: live would have run
  // its simulated selection. An EMPTY simulated selection means the live
  // plugin's no-affected-tests fallback fires — full suite, everything
  // persisted (live self-healing).
  return simulatedSelection.size > 0 ? new Set(simulatedSelection) : 'all';
}

/** Per-commit ground-truth edge data + the decision that shaped persistence. */
export interface CommitEdgeInput {
  sha: string;
  /** Ground-truth full runtime map at C (parsed from graphs/<sha>.json). */
  freshMap: ReverseMap;
  decision: ShadowDecision;
  /** Changed files at C, ABSOLUTE (same path space as the maps). */
  changedFiles: readonly string[];
}

/** The reconstructed cache state around a single commit. */
export interface CacheEvolutionStep {
  sha: string;
  /** State a live run at C would LOAD (pre-run snapshot). */
  cacheBefore: ReverseMap;
  /** State a live run at C would PERSIST (post-run). */
  cacheAfter: ReverseMap;
  /** The persistence scope applied at C. */
  scope: MergeScope;
  /**
   * The selection a live run at C would have made from the drifted cache —
   * the detector's selection AND (when non-empty, for selective /
   * cache-dependent decisions) the persistence scope.
   */
  simulatedSelection: Set<string>;
}

/**
 * Evolve the simulated live cache across ONE commit, driving the REAL package
 * mergeRuntimeEdges. Never mutates its inputs (mergeRuntimeEdges' read-only
 * structural-sharing contract applies to both maps).
 */
export function evolveStep(
  cache: ReverseMap,
  input: CommitEdgeInput,
): CacheEvolutionStep {
  const simulatedSelection = simulateLiveSelection(
    cache,
    input.changedFiles,
    testsOf(input.freshMap),
  );
  // COLD-CACHE RULE: with no cache at all a live plugin cannot be selective —
  // it full-suites (cache-miss) and persists everything, regardless of what
  // the recorded decision or the (test-file self-selecting) simulated set say.
  const scope: MergeScope =
    cache.size === 0
      ? 'all'
      : evolutionScope(input.decision, simulatedSelection);
  const cacheAfter = mergeRuntimeEdges(cache, input.freshMap, scope);
  return {
    sha: input.sha,
    cacheBefore: cache,
    cacheAfter,
    scope,
    simulatedSelection,
  };
}

/**
 * Reconstruct the selective-cache evolution across an ordered commit chain.
 * `initial` is the warm-start snapshot (empty for a cold cache). Each step's
 * `cacheBefore` is the prior step's `cacheAfter`.
 */
export function reconstructCacheEvolution(
  commits: readonly CommitEdgeInput[],
  initial: ReverseMap = new Map(),
): CacheEvolutionStep[] {
  let cache: ReverseMap = initial;
  const steps: CacheEvolutionStep[] = [];
  for (const commit of commits) {
    const step = evolveStep(cache, commit);
    steps.push(step);
    cache = step.cacheAfter;
  }
  return steps;
}
