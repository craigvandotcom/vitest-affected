import type { ReverseMap } from './graph/types.js';

/**
 * Provenance for a single selected test: WHY it was selected.
 * - `seed`  — the changed/deleted file the BFS started from that first reached
 *   this test (BFS-first-reached; deterministic given seed order).
 * - `chain` — the full path of files from `seed` to the test, inclusive of both
 *   ends, following reverse-dependency edges (seed → … → test). A test that is
 *   itself a seed has `chain === [test]` and `seed === test` (self-selection).
 */
export interface SelectionTrail {
  seed: string;
  chain: string[];
}

/**
 * BFS over the reverse-dependency graph that ALSO records provenance for every
 * selected test (the seed it was reached from + the edge chain). This is the
 * provenance-bearing core; `bfsAffectedTests` is a thin wrapper that discards
 * the provenance, so existing call sites keep their `string[]` contract.
 *
 * The traversal is identical to the plain BFS: seeds are enqueued first,
 * `visited` dedups, and a node's dependents (its importers, per the reverse
 * map) are enqueued in encounter order. Provenance is derived from a
 * first-reached `parent` chain — the first node to enqueue a given node wins,
 * matching BFS shortest-path semantics.
 */
export function bfsAffectedTestsWithProvenance(
  changedFiles: string[],
  reverse: ReverseMap,
  isTestFile: (path: string) => boolean,
): { tests: string[]; provenance: Map<string, SelectionTrail> } {
  const visited = new Set<string>();
  // parent maps each discovered node to the node that first enqueued it; seeds
  // map to null. First-writer-wins keeps the BFS-first-reached path.
  const parent = new Map<string, string | null>();
  const queue = [...changedFiles];
  for (const seed of changedFiles) {
    if (!parent.has(seed)) parent.set(seed, null);
  }
  let i = 0;
  const affectedTests: string[] = [];
  const provenance = new Map<string, SelectionTrail>();

  function buildChain(node: string): string[] {
    const chain: string[] = [];
    let cur: string | null | undefined = node;
    while (cur !== null && cur !== undefined) {
      chain.push(cur);
      cur = parent.get(cur) ?? null;
    }
    return chain.reverse();
  }

  while (i < queue.length) {
    const file = queue[i++]!;
    if (visited.has(file)) continue;
    visited.add(file);
    if (isTestFile(file)) {
      affectedTests.push(file);
      const chain = buildChain(file);
      provenance.set(file, { seed: chain[0]!, chain });
    }
    const dependents = reverse.get(file);
    if (dependents) {
      for (const dep of dependents) {
        // Gate the push on the ENQUEUE-time map (`parent`), not on `visited`
        // (which is only set at DEQUEUE). A high-fan-in node is a dependent of
        // many files; guarding on `visited` re-enqueues it once per incoming
        // edge (it isn't dequeued/marked visited until much later) → O(E) queue
        // growth. `parent` is written the instant a node is first enqueued, so
        // this admits each node exactly once. Behavior is unchanged: the winning
        // (first-recorded) parent is still the first file in dequeue order whose
        // dependents include `dep` — a node can't be dequeued before its first
        // push, at which point `parent` is already set — so provenance trails
        // and the selected set stay byte-identical; only the redundant enqueues
        // are removed. Seeds are pre-seeded in `parent` (mapped to null), so a
        // dep that is also a seed is never re-enqueued and keeps its null trail.
        if (!parent.has(dep)) {
          parent.set(dep, file);
          queue.push(dep);
        }
      }
    }
  }

  return { tests: affectedTests.sort(), provenance };
}

export function bfsAffectedTests(
  changedFiles: string[],
  reverse: ReverseMap,
  isTestFile: (path: string) => boolean
): string[] {
  return bfsAffectedTestsWithProvenance(changedFiles, reverse, isTestFile).tests;
}
