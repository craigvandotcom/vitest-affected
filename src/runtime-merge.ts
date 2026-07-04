/**
 * Reverse dependency map: source file → the set of test files that import it
 * (transitively, as observed at runtime). Absolute, Vite-normalized paths.
 *
 * BY-DESIGN: vi.mock / vi.importActual boundary
 * -----------------------------------------------------------------------
 * Edges here come entirely from Vitest's own `importDurations` diagnostic —
 * a module only appears if Vitest actually loaded it. That gives a precise,
 * intentional boundary around mocked dependencies:
 *
 * - A factory `vi.mock('./dep', () => ({ ... }))` with no `importActual`
 *   REPLACES `./dep` for every importer; the real file is never loaded, so
 *   it never appears in `importDurations` and gets NO reverse edge. This is
 *   correct, not a gap: a fully-mocked module is decoupled from the test by
 *   design, so changing the real file cannot change that test's outcome —
 *   there is nothing for an edge to protect.
 * - A factory that calls `await vi.importActual('./dep')` (partial mock) DOES
 *   load the real file, so it appears in `importDurations` and gets a normal
 *   reverse edge — runtime coverage works exactly as for a static import.
 *
 * Regression-pinned in test/runtime.test.ts ("vi.mock / vi.importActual
 * boundary: BY-DESIGN edge presence") against a real nested Vitest run, so a
 * future "fix" can't wrongly add mock-aware edges, and a future regression
 * can't silently drop the importActual edge.
 *
 * README taxonomy line: "fully-mocked modules are intentionally edge-free;
 * partial mocks via importActual are runtime-tracked."
 */
export type ReverseMap = Map<string, Set<string>>;

/**
 * Merge a fresh batch of runtime reverse edges into a base map, applying a
 * per-test overwrite so that removed imports are reflected (not accumulated
 * forever). PURE in the sense that neither `base` nor `fresh` is ever mutated
 * and a NEW top-level map is returned.
 *
 * STRUCTURAL SHARING: to avoid cloning every Set on the hot path, the returned
 * map REUSES the exact Set instances from `base` for entries this merge does
 * not touch (no member removed, no fresh member added). Only entries actually
 * affected by the overwrite set — those losing members or gaining fresh edges,
 * plus entries seen only in `fresh` — get freshly-allocated Sets. Consequence:
 * the returned map may SHARE Set references with `base`. Callers MUST NOT mutate
 * the entry Sets of either map in place (treat both as read-only); to change an
 * entry, run another merge. Inputs themselves are never mutated by this call.
 *
 * Persistence is the caller's concern — the reporter writes the result to the
 * cache; the replay harness merges without touching the live cache.
 *
 * Scope semantics:
 * - `'all'`  → overwrite EVERY test present in `fresh`: strip those tests'
 *   stale edges from `base`, then merge their fresh edges in.
 * - `Set<testPath>` → overwrite ONLY the tests in the set. Edges belonging to
 *   any other test in `base` remain untouched, and fresh edges for tests
 *   outside the set are ignored.
 */
export function mergeRuntimeEdges(
  base: ReverseMap,
  fresh: ReverseMap,
  scope: Set<string> | 'all',
): ReverseMap {
  // Tests whose edges this merge is allowed to overwrite.
  let overwrite: Set<string>;
  if (scope === 'all') {
    overwrite = new Set<string>();
    for (const tests of fresh.values()) {
      for (const t of tests) overwrite.add(t);
    }
  } else {
    overwrite = scope;
  }

  // Pre-group the fresh edges the overwrite set admits, by source file. These
  // are freshly-allocated Sets, so using them directly in `result` never
  // aliases `fresh`'s own Sets.
  const freshByFile = new Map<string, Set<string>>();
  for (const [file, tests] of fresh) {
    for (const t of tests) {
      if (!overwrite.has(t)) continue;
      let s = freshByFile.get(file);
      if (!s) {
        s = new Set<string>();
        freshByFile.set(file, s);
      }
      s.add(t);
    }
  }

  const result: ReverseMap = new Map();
  for (const [file, tests] of base) {
    let losesMember = false;
    for (const t of tests) {
      if (overwrite.has(t)) {
        losesMember = true;
        break;
      }
    }
    const gained = freshByFile.get(file);
    if (!losesMember && gained === undefined) {
      // Untouched entry — reuse the base Set instance verbatim (no clone).
      result.set(file, tests);
      continue;
    }
    // Affected entry — allocate a new Set: kept base members + fresh members.
    const next = new Set<string>();
    for (const t of tests) {
      if (!overwrite.has(t)) next.add(t);
    }
    if (gained) {
      for (const t of gained) next.add(t);
      freshByFile.delete(file);
    }
    if (next.size > 0) result.set(file, next);
  }

  // Files present only in `fresh` (never in `base`) — their freshly-allocated
  // Sets can be used directly.
  for (const [file, gained] of freshByFile) {
    if (gained.size > 0) result.set(file, gained);
  }

  return result;
}
