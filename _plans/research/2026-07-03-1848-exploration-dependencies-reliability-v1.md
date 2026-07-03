## Finding 1: A documented, supported reporter-registration path already exists — the defineProperty hack is unnecessary
**Type:** API-fragility
**Current state / mechanism:** Vitest's own Plugin API docs state plainly: "At this point reporters are not created yet, so modifying `vitest.reporters` will have no effect because it will be overwritten." The documented fix: `vitest.config.reporters.push([['my-reporter', {}]])` inside `configureVitest`. `plugin.ts:324-342` instead intercepts the *assignment* via `Object.defineProperty(vitest, 'reporters', {get/set...})`, which depends on `createReporters` doing a plain `vitest.reporters = ...` assignment (not e.g. `Object.assign` or per-index mutation) — an internal implementation detail with no stability guarantee.
**File(s)/URL(s):** `src/plugin.ts:320-342`; https://main.vitest.dev/api/advanced/plugin
**Implication for the plan:** Swap the defineProperty interceptor for `vitest.config.reporters.push([...])` (needs a serializable reporter reference, e.g. package/module path, since config is resolved before object refs are usable the same way — verify shape) or keep defineProperty as fallback but add a startup self-check that the reporter actually got wired (see Finding 6).

## Finding 2: `project.config.include` mutation for test selection is undocumented
**Type:** API-fragility
**Current state / mechanism:** Vitest docs describe `configureVitest`'s `project` as giving access to config, and document `injectTestProjects`/`vitest.config.project` for project-level filtering, but nowhere document mutating `project.config.include` as a supported test-selection mechanism.
**File(s)/URL(s):** `src/plugin.ts:490,524,586`; https://main.vitest.dev/api/advanced/plugin
**Implication for the plan:** Since Vitest 4 also shipped `onFilterWatchedSpecification` (see Finding 3) as a first-class filtering hook, evaluate whether a spec-filter based approach is more future-proof for non-watch runs too, and treat `include` mutation as the fragile path needing a self-verifying assertion (selected files actually appear in the run).

## Finding 3: `onFilterWatchedSpecification` is a genuine, intentional replacement API (Vitest 4)
**Type:** API-fragility (positive signal)
**Current state / mechanism:** "In Vitest 4, `onFilterWatchedSpecification` was added as a replacement for the deprecated `changedTests` API" — a first-class, documented hook for filtering which specs run. Plugin currently only registers it as a pass-through (`() => true`) in watch mode, deferring to Vitest's own graph.
**File(s)/URL(s):** `src/plugin.ts:344-347`; https://main.vitest.dev/advanced/api/vitest
**Implication for the plan:** This is a stable, intended extension point (unlike `include` mutation) — worth using for non-watch selection too if it's callable outside watch mode, reducing reliance on the undocumented `include` mutation path.

## Finding 4: `importDurations` is still explicitly experimental, actively evolving
**Type:** API-fragility
**Current state / mechanism:** Vitest's own experimental-config docs still list `importDurations` under `experimental`, with `limit` defaulting to 0 (silently disabling collection) — which the plugin already works around by force-setting `limit: Number.MAX_SAFE_INTEGER` and documents as a v4-only gotcha (comment at line 258-263 references "cli-api: line ~10293" internals). No changelog evidence of imminent stabilization or removal found; it was recently *expanded* (added `print`/`failOnDanger`/`thresholds`), suggesting active but not yet frozen shape.
**File(s)/URL(s):** `src/plugin.ts:258-271`; https://vitest.dev/config/experimental.html
**Implication for the plan:** Any reliability harness must pin/detect the Vitest version and assert the `experimental.importDurations` shape at startup rather than assume it; a shape-check with a clear warning-and-fallback is cheap insurance against silent breakage on a Vitest bump.

## Finding 5: Vitest 5 is in beta now (mid-2026) — no evidence it touches any of the 4 fragile surfaces, but it does remove other deprecated APIs
**Type:** Upstream
**Current state / mechanism:** GitHub Discussion #9664 confirms Vitest 5.0 is in active beta with a tracked milestone; the migration guide documents ~30 breaking changes (benchmark API rewrite, removed `test.sequential`, browser locator serialization, JSON/JUnit reporters defaulting to file output) but nothing found calling out `importDurations`, `configureVitest`, `onFilterWatchedSpecification`, or `project.config.include`.
**File(s)/URL(s):** https://github.com/vitest-dev/vitest/discussions/9664 ; https://main.vitest.dev/guide/migration
**Implication for the plan:** Not urgent, but the reliability harness should include a smoke-test against Vitest 5 beta before it stabilizes (peerDep is currently `>=3.2.0 <5.0.0`, so 5.0 is already excluded — confirm the exclusion is intentional guardrail, not an oversight, and plan the 5.x validation pass before widening it).

## Finding 6: No native Vitest "affected tests" / TIA feature is being built — this plugin's niche stays open, but `--changed` has known real gaps worth stealing fallback ideas from
**Type:** Upstream / Prior-art
**Current state / mechanism:** No GitHub issue/discussion found proposing native runtime-based affected-test selection in vitest-dev/vitest. The built-in `--changed` flag walks the *static* import graph only, and is documented (dev.to reverse-engineering + GH issues #8654, #1113) to break when: import targets aren't statically analyzable (data-driven `require`/dynamic paths), `--changed` is combined with `--projects` (external-vs-local path resolution bug), and coverage integration ("Coverage with `--changed`" issue #5237 — they don't compose).
**File(s)/URL(s):** https://github.com/vitest-dev/vitest/discussions/6734 ; https://github.com/vitest-dev/vitest/issues/8654 ; https://github.com/vitest-dev/vitest/issues/1113
**Implication for the plan:** vitest-affected's runtime-edge approach (importDurations) already avoids the static-graph blind spot that plagues `--changed` — worth stating explicitly as the plugin's core value prop in reliability messaging, and worth a regression test mirroring #8654's project-resolution bug shape.

## Finding 7: A near-identical tool ("testpick") independently converged on the same runtime-coverage idea, with an explicit "never less" reliability posture
**Type:** Prior-art
**Current state / mechanism:** testpick uses V8 precise coverage per test (not import parsing) to build a test→source map, and states its core reliability rule as "when in doubt, run more, never less" — unmapped changes default to running the full suite, plus a `testpick explain` command that surfaces *why* a given test was/wasn't selected.
**File(s)/URL(s):** https://dev.to/kazutaka-dev/why-vitest-changed-misses-some-tests-and-how-runtime-coverage-fixes-it-jjm
**Implication for the plan:** Steal the `explain` idea — add a `--explain <file>` / stats-file field showing which BFS seed/edge caused a given test's selection, giving a debuggable trail when a selection turns out wrong. This directly supports the existing "never silently skip" invariant.

## Finding 8: Nx affected and Turborepo both prove that graph-based selection needs periodic ground-truth reconciliation, not just fallback-on-error
**Type:** Prior-art
**Current state / mechanism:** Nx affected = git diff (base/head) + static project graph, dependents included transitively. Turborepo affected = file-hash-based task cache; documented history of hash/cache-invalidation bugs (missed dependency changes → false cache hits) fixed only in v2.0, improving one team's hit rate from ~45% to ~92%.
**File(s)/URL(s):** https://nx.dev/ci/features/affected ; https://github.com/vercel/turborepo/issues/4323
**Implication for the plan:** The steal-worthy idea isn't the graph engine (out of scope) but the lesson that a runtime/cache-derived graph silently drifts from truth over time — argues for a periodic full-suite "reconciliation run" (e.g. every N selective runs, or on a schedule) that rebuilds the cache from scratch and diffs it against the incremental one, surfacing drift before it causes an under-run.

## Finding 9: Microsoft TIA formalizes "safe fallback + stale-map detection" as first-class product features, not afterthoughts
**Type:** Prior-art
**Current state / mechanism:** Azure DevOps TIA docs: "TIA should always be implemented with safe defaults and override mechanisms" and explicitly documents stale-map risk ("Old maps may exclude relevant tests if code has changed") with automatic map rebuilds as mitigation.
**File(s)/URL(s):** https://learn.microsoft.com/en-us/azure/devops/pipelines/test/test-impact-analysis?view=azure-devops
**Implication for the plan:** Confirms Finding 8's reconciliation idea is industry-standard practice, not a novel ask — worth citing as precedent when scoping the reliability upgrade's staleness-detection bead.

## Finding 10: Harness dependencies — `execa` already present, no CLI-arg-parsing lib
**Type:** Harness-dep
**Current state / mechanism:** `package.json` devDependencies already include `execa@^9.0.0` (usable for a replay harness that shells out to `vitest run` and inspects results) and `vitest@^3.2.0` itself for self-hosted meta-tests. No CLI-arg-parsing library (`commander`, `yargs`, etc.) or snapshot/fixture-diffing utility present — `tinyglobby` (dep) could serve fixture discovery.
**File(s)/URL(s):** `/Users/craigvanheerden/Repos/neometa/software/vitest-affected/package.json`
**Implication for the plan:** A replay harness can build on `execa` directly for process orchestration without adding a new dependency; only add a CLI parser if the harness needs a standalone bin rather than being driven from within the existing vitest test suite.
