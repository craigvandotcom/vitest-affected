# Validation Baseline — reliability-v1 (2026-07-03)

## Current state

- **Repo:** main, clean tree, v0.5.0. Deps freshly installed (`npm install` — node_modules was absent on this Mac checkout).
- **Type-check:** `npx tsc --noEmit` → PASS.
- **Build:** `npm run build` (tsup) → PASS (ESM, dist/index.d.ts 2.01 KB).
- **Tests:** `npx vitest run` → **110 passed / 7 failed (117), 12 files, ~20s.**
  - All 7 failures in `test/git.test.ts` — macOS-only environment artifact: `mkdtempSync(tmpdir())` (test/git.test.ts:23) returns `/var/folders/...` (symlink); git emits realpath `/private/var/...`; assertions compare unresolved prefix. Files ARE detected (`Array(1)`), only the prefix mismatches. Suite was developed/green on the Linux VM.
  - **Reliability finding, not just test debt:** neither test nor `src/git.ts` calls `realpathSync` — a symlinked project rootDir in production would desync changed-file paths from graph keys (same class as the recurring Windows path bugs). Pre-seeded candidate for Stage B: canonicalize paths at all boundaries + fix the test setup.
- **Selection infra observed live:** statsFile JSONL decision logging exists (`src/plugin.ts:179-209`); headless driving surface exists (`changedFiles`/`ref` options) — replay harness needs no new plugin API.

## Tool verification ("taste the tools")

| Tool | Status |
| --- | --- |
| Unit/integration tests (`npx vitest run`) | ✅ runs (7 pre-existing env failures noted above) |
| Type-check (`tsc --noEmit`) | ✅ |
| Build (`npm run build`) | ✅ |
| Integration pattern (execa spawns real vitest against fixtures) | ✅ 9/9 passing, `test/integration.test.ts` |
| Dev server / browser | N/A (library) |
| BCA corpus access | ✅ local checkout at ../body-compass-app (clone-able offline) |

No blocked tools.

## Baseline vs Target

| Aspect | Current | Target |
| --- | --- | --- |
| Miss-rate | Unknown (never measured) | Measured over BCA history (Tier 1 + Tier 2), miss corpus on disk |
| Silent under-selection channels | ≥4 known holes (vi.mock static edges, globalSetup, CSS relevance, fs-fixtures opt-in) | Each hole closed or fallback-covered, verdicts documented |
| Reporter failure visibility | Silent no-op possible (0.5.0 class) | Zero-edge heartbeat warns loudly |
| Reporter attachment | Undocumented defineProperty interception | Supported `config.reporters` registration path (per prior-art recon) |
| Cache portability | Absolute paths (machine-locked) | v3 relative paths, v2→v3 auto-migration |
| Continuous verification | None | Shadow mode in plugin + wired into BCA quality gate |
| Suite on macOS | 7 env failures (symlink paths) | Green on macOS + Linux |
| Version | 0.5.0 | 1.0.0 |
