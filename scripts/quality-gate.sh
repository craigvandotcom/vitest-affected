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
# One step per call (not a monolithic block) so CI keeps its per-step named-step
# log granularity and the local hook keeps its per-step tips + first-failure
# short-circuit.
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
  *)
    echo "usage: bash scripts/quality-gate.sh <build|types|test-types|tests>" >&2
    echo "  steps run in that order; build MUST precede the rest (dist freshness)." >&2
    exit 2
    ;;
esac
