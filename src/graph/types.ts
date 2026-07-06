/**
 * Reverse dependency map — the core graph domain type.
 *
 * Keys are SOURCE files; each value is the set of TEST files that import that
 * source (transitively, as observed at runtime). In other words: given a file
 * that changed, `reverse.get(file)` names the tests that could be affected by
 * it. All paths are absolute and Vite-normalized (query strings, `\0` prefixes
 * and `/@fs/` stripped, realpath-canonicalized).
 *
 * This is the canonical home for the type; peripheral consumers
 * (`runtime-merge.ts`, `selector.ts`, `explain-core.ts`, `graph/builder.ts`,
 * `graph/cache.ts`, `plugin.ts`) import it from here rather than redeclaring the
 * raw `Map<string, Set<string>>` shape.
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
