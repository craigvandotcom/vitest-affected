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
 * forever). PURE: neither `base` nor `fresh` is mutated; a new map is returned.
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

  // Copy base, stripping stale edges for tests being overwritten.
  const result: ReverseMap = new Map();
  for (const [file, tests] of base) {
    const kept = new Set<string>();
    for (const t of tests) {
      if (!overwrite.has(t)) kept.add(t);
    }
    if (kept.size > 0) result.set(file, kept);
  }

  // Merge fresh edges, restricted to the overwrite set.
  for (const [file, tests] of fresh) {
    for (const t of tests) {
      if (!overwrite.has(t)) continue;
      if (!result.has(file)) result.set(file, new Set<string>());
      result.get(file)!.add(t);
    }
  }

  return result;
}
