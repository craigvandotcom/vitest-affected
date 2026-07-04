/**
 * Evolution — simulated selective cache reconstruction.
 *
 * WHY THIS EXISTS (trap #1): the replay harness runs the FULL suite at every
 * commit to capture ground truth. A live consumer does NOT — a selective run
 * only re-records the tests it actually ran, so its cache DRIFTS: an unselected
 * test keeps whatever edges it last recorded. Naively treating the harness's
 * always-fresh post-run cache as "the cache the plugin would have loaded" erases
 * exactly the staleness this measurement is about.
 *
 * So we reconstruct the cache a LIVE run would hold, commit by commit, by
 * replaying the same persistence a live run performs:
 *
 *   cache_{C+1} = mergeRuntimeEdges(cache_C, freshMap_C, scope_C)
 *
 * where `freshMap_C` is the ground-truth full runtime map captured at C and
 * `scope_C` reflects what a live run at C would have persisted:
 *   - shadow-selective → the selected set only (Set of selectedFiles)
 *   - shadow-full-suite → the whole fresh map ('all'); this is also exactly how
 *     commit #1's cold cache is warmed.
 *
 * IMPORT NOTE (load-bearing): mergeRuntimeEdges is imported from the BUILT
 * package root ('../../dist/index.js') — the same artifact the replay harness
 * ships against — NOT from '../../src/runtime-merge.js'. Importing src would
 * measure unbuilt code and recreate logic drift; run `npm run build` if dist is
 * stale/missing. The ReverseMap type comes from the dist declarations.
 */
import { mergeRuntimeEdges } from '../../dist/index.js';
import type { ReverseMap } from '../../dist/index.js';
import type { ShadowDecision } from './types.js';

/** The merge scope mergeRuntimeEdges accepts: a selected set, or 'all'. */
export type MergeScope = Set<string> | 'all';

/**
 * The persistence scope a live run at this decision would apply:
 *  - shadow-selective → Set of the selected test files (only those re-recorded)
 *  - shadow-full-suite → 'all' (every test present in the fresh map re-recorded)
 *
 * A shadow-selective decision with a null selection degrades to an EMPTY set
 * (persist nothing) — never 'all', which would silently over-warm the cache.
 */
export function scopeForDecision(decision: ShadowDecision): MergeScope {
  if (decision.action === 'shadow-full-suite') return 'all';
  return new Set(decision.selectedFiles ?? []);
}

/** Per-commit ground-truth edge data + the decision that shaped persistence. */
export interface CommitEdgeInput {
  sha: string;
  /** Ground-truth full runtime map at C (parsed from graphs/<sha>.json). */
  freshMap: ReverseMap;
  decision: ShadowDecision;
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
}

/**
 * Reconstruct the selective-cache evolution across an ordered commit chain,
 * driving the REAL package `mergeRuntimeEdges`. `initial` is the warm-start
 * snapshot (empty for a cold cache). Never mutates its inputs; each step's
 * `cacheBefore` is the prior step's `cacheAfter` (structurally shared, per
 * mergeRuntimeEdges' read-only contract).
 */
export function reconstructCacheEvolution(
  commits: readonly CommitEdgeInput[],
  initial: ReverseMap = new Map(),
): CacheEvolutionStep[] {
  let cache: ReverseMap = initial;
  const steps: CacheEvolutionStep[] = [];
  for (const commit of commits) {
    const scope = scopeForDecision(commit.decision);
    const cacheBefore = cache;
    const cacheAfter = mergeRuntimeEdges(cacheBefore, commit.freshMap, scope);
    steps.push({ sha: commit.sha, cacheBefore, cacheAfter, scope });
    cache = cacheAfter;
  }
  return steps;
}
