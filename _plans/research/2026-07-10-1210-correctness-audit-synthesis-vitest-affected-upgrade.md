# Correctness Audit Synthesis — input research for the next-level upgrade plan

_Source: three parallel audits run 2026-07-09 (plugin mechanisms × test coverage × BCA exposure), synthesized in the planning conversation. This file persists the findings that motivated the wave._

## Architecture invariant (governs everything)

The AUTHORITATIVE reverse graph is built SOLELY from Vitest's runtime `importDurations`
(plugin.ts:271-293, folded by `mergeRuntimeEdges`). Static parsing (graph/builder.ts) is
**seed-only** — it parses changed files to add their new import targets as extra BFS roots;
it never constructs persistent reverse edges. Therefore: **any dependency channel invisible
to runtime import tracking has NO reverse edge, and editing that target silently
under-selects.** The 19 fail-closed full-suite fallback paths guard errors, not invisibility.
This is why `extraDependencies` must inject durable REVERSE EDGES, not seeds.

## Verdict matrix

| Channel | Plugin handles? | Test-pinned? | BCA exposed? | Verdict |
|---|---|---|---|---|
| Static imports, literal `import()` | ✅ static + runtime | ✅ | everywhere | proven |
| Barrels / re-exports (`export * from`) | ✅ builder.ts:169-178 | ❌ ZERO tests | yes | regression-unpinned |
| BFS, cache v1→v3, renames/deletes, filtering, fail-closed | ✅ | ✅ strong | — | proven |
| Config/setup/lockfile changes | ✅ force full suite | ✅ | uses setupFiles | proven |
| `vi.mock` (1,760 BCA sites) | ✅ by-design (mocked=decoupled) | ✅ | heavy | safe by design |
| `import.meta.glob`, `?raw`, variable `import()` | ⚠️ blind cold | ❌ | **BCA uses NONE** | blind but unexposed |
| tsconfig `paths`/`baseUrl` | ✅ oxc-resolver | ❌ no native test | yes | pin with tests |
| `require()` | ❌ static-blind | ❌ | — | document + pin |
| `.json` edges | ✅ | ❌ | — | pin |
| **Workers** | ❌ no reverse edge ever | tests prove wrong thing (extraction only) | **yes: public/workers/image-compression.js** | REAL HOLE |
| **`.snap` files** | ❌ invisible | ❌ | 1 file snapshot | real, low-traffic (DEFERRED) |
| **fs-read/execSync drift-guard tests** | ❌ invisible by definition | n/a | **~27 unguarded targets** | THE BIG ONE |
| Staleness | ⚠️ warn-only | ✅ (pins the warn) | loop cadence resets it | policy accepted |

## BCA's ~27 unguarded invisible dependencies (from the exposure audit)

fullSuiteTriggers today: `__tests__/fixtures/`, `supabase/migrations/`, `supabase/config.toml`,
`scripts/mock-pipeline-v5/prompts/`, `ios/App/App/BodyCompassDeepLinks.swift`,
`.claude/skills/curate/SKILL.md`. Unguarded targets include (test → target):

- globals-css-light-mode, landing-header, new-navbar → `app/globals.css`, `app/layout.tsx`, `tailwind.config.ts`
- worker-compression → `public/workers/image-compression.js` (runtime `new Worker('/workers/…')` string)
- environment, sw-cache → `public/sw.js`, `lib/utils/environment.ts`
- db-layer-signals, db-queries → `lib/db/symptoms.ts`, `lib/db/foods.ts` (raw fs reads, not imported)
- tier-transitions-unique → `lib/methodology/orchestrator.ts`
- partial-skip-field-partition → `lib/services/canonical-writer.ts`
- retrigger-clears-curator-state → `app/api/admin/ingredients/[slug]/retrigger/route.ts`
- dashboard-insights-tf-prop, dynamic-imports, signal-fab-page-wiring → `app/(protected)/app/page.tsx` (+ add-signal-dialog.tsx, legacy-symptom-mapping.ts)
- image-components → hero-section.tsx, image-crop-modal.tsx
- zone-display-cohesion → ingredient-detail-drawer.tsx, ingredient-page-client.tsx
- update-user-preferences → ai-model-settings.tsx
- typography-zone-labels → tailwind.config.ts, food-zone-summary-bar.tsx
- keyboard-scroll-hook-wiring → use-keyboard-aware-scroll.ts + 6 consumer files
- mdx → `content/` dir (readdirSync)
- theme-prepaint-injection → `scripts/inject-theme-script.sh` (execSync)
- ci-hygiene → `.github/workflows/modifier-integrity.yml` + recursive test-dir scans
- whole-tree scanners (git-grep / recursive readdir): no-hardcoded-theme-colors, bundle-hygiene,
  zone-type-canonical, zone-vocabulary-source (dep = entire source tree → these need dir-glob entries)

Resolved as NON-issues by crossing audits: setupFiles (plugin force-fulls, tested),
package.json raw-reads (CONFIG_BASENAME → full suite), vi.mock sites (by-design safe),
no import.meta.glob / ?raw / variable-import usage anywhere in BCA.

## Test-coverage gaps to regression-pin (ranked)

1. Barrels/re-exports — zero tests despite builder.ts:169-178 support (highest value)
2. `require()`/CJS — zero coverage, behavior undocumented
3. tsconfig `paths`/`baseUrl` native resolution — zero native tests (headline feature!)
4. `.json` import as followed edge — no direct test
5. Shallow-clone guard FIRES branch (git.ts:70) — asserted-absent only, never asserted-fires
6. Plain-quote dynamic import literal + `${}` template SKIP — unasserted branches
7. Plugin-level lockfile→full-suite e2e decision — only filter-preservation tested
8. `vi.doMock` — untested (vi.mock boundary is)

## Monitoring context (already fixed, uncommitted in BCA)

- `vitest.config.mts`: `ref: process.env.VITEST_AFFECTED_REF ?? 'main'`
- `quality-gate.yml`: full-run path extracts last checkpoint SHA from
  `_ci-evidence/vitest-affected-divergence-log.jsonl` → exports `VITEST_AFFECTED_REF`
  (guarded: missing/unresolvable → warn + old behavior) → same anchor into `--changed-ref`
- Validated: anchor `31388bee` resolves; 68 files changed since → next full run makes a real
  selective decision. YAML validated. Cadence decision: ONE full suite at end of ac-loop,
  affected-only per merge → loop-close checkpoint is the sole pre-publish safety net.
- Evidence log had 3 lines as of 2026-07-09 18:01, ALL `shadow-full-suite/no-changes`
  (the empty-diff bug this fix kills). Hero card numbers = 2026-07-05 replay baseline
  (12 selective decisions, 0 misses, 99 commits).

## Interview decisions (2026-07-10)

- extraDependencies = **config map** option (test path/glob → watched paths/globs), tinyglobby for globs
- **One cross-repo wave** (vitest-affected + body-compass-app)
- Publish gate = **strict SHA match** (evidence log last SHA == main HEAD, else refuse)

## Out of scope (settled)

`.snap` handling (deferred), staleness policy changes (loop cadence solves), new trigger
machinery (ac-loop fires the full run).
