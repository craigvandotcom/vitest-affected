#!/usr/bin/env bash
#
# Single-sourced quality gate — the CANONICAL definition of the 4-step gate.
# Every caller (CI's .github/workflows/ci.yml, the local pre-commit hook, and the
# AGENTS.md/CLAUDE.md doc row) points HERE instead of re-typing the commands, so
# the gate can no longer drift between copies (the exact bug this closes: the
# VITEST_AFFECTED_DISABLED flag once lived only in some copies — hygiene round 4).
#
# SHAPE: one step per invocation — `bash scripts/quality-gate.sh <step>`:
#   build       npm run build                         (build the dist artifact)
#   types       tsc --noEmit                          (type-check production src)
#   test-types  tsc -p tsconfig.test.json --noEmit    (type-check the test suite)
#   tests       vitest run, plugin self-disabled      (full suite, every test)
#   smoke       drive the harness CLI entry (CI-only)  (main() over a fixture)
# One step per call (not a monolithic block) so CI keeps its per-step named-step
# log granularity and the local hook keeps its per-step tips + first-failure
# short-circuit.
#
# The `smoke` step is CI-ONLY and deliberately NOT part of the default local
# quality-gate loop documented in AGENTS.md/CLAUDE.md — it spins a fixture and
# exercises the `npx tsx tools/replay/run.ts` CLI entry glue (which no unit test
# imports), covering main() + its static ../../dist import chain. It MUST run
# AFTER `build` (that import chain loads at module-eval regardless of branch, so
# even `--help` needs dist/ present).
#
# ORDERING (load-bearing): `build` MUST run before types/test-types/tests. On a
# fresh checkout dist/ is absent and tools/replay imports ../../dist by design, so
# type-checking before building fails with TS2307 (commit 155bece / 2026-07-11
# race — dist freshness is the gate's job). CI + the hook invoke the steps in the
# build → types → test-types → tests order.
#
# VITEST_AFFECTED_DISABLED lives INSIDE the `tests` step here (not in caller env),
# so the plugin never selects a subset of its own suite AND the flag is
# single-sourced — it previously sat caller-side (ci.yml env block + hook inline),
# which was the drift class this script exists to eliminate.
set -euo pipefail

step="${1:-}"
case "$step" in
  build)
    npm run build
    ;;
  types)
    npx tsc --noEmit
    ;;
  test-types)
    npx tsc -p tsconfig.test.json --noEmit
    ;;
  tests)
    VITEST_AFFECTED_DISABLED=1 npx vitest run
    ;;
  smoke)
    # CI-only harness-entry smoke: no real walk, no installs. Requires dist/
    # (run `build` first). Drives the ACTUAL CLI entry twice:
    #   (1) --help  — parseArgs short-circuit; prints USAGE, exits 0.
    #   (2) --analyze-only over a copy of the tiny pre-baked fixture run dir —
    #       exercises main()'s analyze branch end-to-end and must emit a report.
    # The fixture is COPIED to a temp dir first so the analysis.md it writes
    # never dirties the checked-out tree.
    npx tsx tools/replay/run.ts --help >/dev/null
    smoke_run="$(mktemp -d)/run"
    cp -R test/fixtures/replay-smoke "$smoke_run"
    npx tsx tools/replay/run.ts --analyze-only "$smoke_run" --root /smoke-root >/dev/null
    if [ ! -f "$smoke_run/analysis.md" ]; then
      echo "smoke: --analyze-only produced no analysis.md report" >&2
      exit 1
    fi
    echo "smoke: harness CLI entry OK (--help + --analyze-only → report)"
    ;;
  *)
    echo "usage: bash scripts/quality-gate.sh <build|types|test-types|tests|smoke>" >&2
    echo "  steps run in that order; build MUST precede the rest (dist freshness)." >&2
    exit 2
    ;;
esac
