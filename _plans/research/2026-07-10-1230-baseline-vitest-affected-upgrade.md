# Validation Baseline — vitest-affected next-level upgrade

_Captured 2026-07-10 12:29 on `main` (clean tree)._

## Validation method

| Task type | Primary validation | Secondary |
|---|---|---|
| Plugin feature (extraDependencies) | New unit + integration tests (vitest) | Full quality gate |
| Regression pinning | New tests must pass AND fail when the pinned mechanism is broken | tsc strict |
| BCA wiring + publish gate | Loop-close full run produces a `shadow-selective` checkpoint; gate script exit codes | quality-gate.yml run |

## Tool Verification Checklist (tasted 2026-07-10)

- **Build (tsup):** ✅ `npm run build` — ESM + DTS success
- **Type-check src:** ✅ `npx tsc --noEmit` — PASS
- **Type-check tests:** ✅ `npx tsc -p tsconfig.test.json --noEmit` — PASS
- **Unit/Integration tests:** ✅ `VITEST_AFFECTED_DISABLED=1 npx vitest run` — 21 files, 306 tests, all pass (34.17s)
- **Browser/dev server:** N/A (library — no runtime surface)
- **BCA side:** sibling repo present at `../body-compass-app`; quality-gate.yml YAML validated earlier; anchor SHA extraction smoke-tested against the real evidence log (3 lines, last sha `31388bee` resolves, 68 files in anchored diff)

**Status: all validation tools working. Nothing blocked.**

## Current state (baseline)

- Plugin: no `extraDependencies` option exists. Blind channels (fs-reads, workers, execSync
  targets) have no reverse edges; consumer mitigation is blunt `fullSuiteTriggers` only.
- Tests: 306 passing; zero coverage for barrels/re-exports, tsconfig paths/baseUrl,
  require(), .json edges, shallow-clone-fires, plain-quote dynamic import.
- BCA: `VITEST_AFFECTED_REF` wiring exists as UNCOMMITTED edits (vitest.config.mts +
  quality-gate.yml). Evidence log: 3 checkpoints, all `shadow-full-suite/no-changes`
  (empty-diff bug). ~27 unguarded invisible-dependency targets.
- ac-publish: no checkpoint-freshness gate; a silently-missing loop-close run is invisible.

## Target state

- `extraDependencies` config map ships with glob support; watched-file edit selects declared
  tests (proven by integration test on a fixture with NO import edge).
- All 8 ranked coverage gaps pinned with tests; suite grows accordingly, all green.
- BCA wiring committed; next loop-close checkpoint is `shadow-selective` over a real diff.
- BCA declares its unguarded targets as extraDependencies entries.
- ac-publish refuses on stale checkpoint (last log SHA != main HEAD) with a loud message.
