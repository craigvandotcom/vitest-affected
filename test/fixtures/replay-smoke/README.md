# replay-smoke fixture

A tiny pre-baked A2a run dir (ledger + graphs/ + outcomes/) used ONLY by the
CI-only `smoke` stage of `scripts/quality-gate.sh`. It drives the real harness
CLI entry (`npx tsx tools/replay/run.ts --analyze-only <copy> --root /smoke-root`)
to prove `main()` + its static `../../dist/internal.js` import chain load and
produce a report — coverage `test/replay-core.test.ts` cannot give (it imports
the planning fns, never the CLI glue).

Graph keys are anchored under the sentinel root `/smoke-root` (never touched on
disk — `analyzeRun` only `path.resolve`s against it) so the changed-file→graph
join is deterministic regardless of checkout location; the smoke passes
`--root /smoke-root` to match. Two commits (a warm-up full-suite + one clean
selective hit) keep the walk non-degenerate with zero misses and zero warnings.
