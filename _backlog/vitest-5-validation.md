# Vitest 5 validation (1.1)

Deferred from the 1.0.0 release. The `vitest` peerDependency is intentionally
capped at `>=3.2.0 <5.0.0` — Vitest 5 is untested against this plugin and the
upper bound prevents silent breakage on an unvalidated major.

## Why deferred

vitest-affected leans on two Vitest internals that have already drifted once
across a major:

- **`experimental.importDurations`** — the runtime reverse-graph is built
  entirely from this diagnostic. Vitest 4 gated it behind
  `experimental.importDurations.limit` (default `0`), which silently disabled
  collection (the v0.5.0 regression). Any Vitest 5 change to its shape or
  default gating could reopen the same silent-starvation class.
- **`configureVitest` hook + `project.config.include` mutation** — selection
  works by mutating `include` in the hook. A future Vitest that changes hook
  ordering, freezes the config, or reads `include` before the hook fires would
  break selection.

The **zero-edge heartbeat** and **selection self-verify** safeguards (1.0.0)
make both failure modes loud rather than silent, so a Vitest 5 regression would
surface as a warning + stats line rather than a no-op — but that is a safety
net, not validation.

## Validation checklist for 1.1

- [ ] Install `vitest@5` in a throwaway consumer and confirm `importDurations`
      still populates (no zero-edge heartbeat on a warm full run).
- [ ] Confirm `configureVitest` still fires before reporter assignment and the
      `include` mutation still takes effect (no selection-mismatch heartbeat).
- [ ] Re-run the full suite (287 tests) against `vitest@5` — replay +
      integration nested runs especially.
- [ ] Confirm `experimental.importDurations` force-enable write and the
      shape-check still hold; adjust the shape-check if the block was renamed
      out of `experimental`.
- [ ] If clean: widen the peerDependency to `>=3.2.0 <6.0.0` and ship as 1.1.
      If not: document the incompatibility and keep the cap.
