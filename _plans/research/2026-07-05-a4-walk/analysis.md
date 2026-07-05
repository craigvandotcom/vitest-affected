# Replay analysis

Run dir: `/private/var/folders/sl/3xgpnygn73784cg0rsf8qmpr0000gn/T/vitest-affected-replay-SwLDiP/runs/2026-07-04T19-02-42-054Z`

## Denominator

- Commits walked: 99 (ok: 97, skipped: 2, BROKEN: 0)
- Warm-up commits (leading full-suite before the first selective decision, segmented out of every rate): 21
- Shadow-selective decisions (the miss-rate population): 12
- Unmeasurable selective commits (missing artifacts, excluded from the denominator, listed below): 0
- Measurable denominator: 12

## Miss-rates (both tiers — never a bare rate)

- **Structural miss-rate** (primary): 0.0% — 0/12 selective commit(s) with ≥1 required-but-unselected test (0 missed test(s) total)
- **Outcome-confirmed miss-rate** (severity subset of structural): 0.0% — 0/12 selective commit(s) whose missed test(s) actually changed outcome C-1 → C (0 test(s) total)

Structural is a superset: under-selections whose skipped tests still pass
are real coverage gaps that outcome-flip detection alone would miss.

## Misses by channel (changed-file kind that produced the miss)

_none_

## Fallback frequency (designed full-suite fallbacks — miss-exempt by definition)

| reason | count |
| --- | --- |
| no-affected-tests | 2 |
| no-changes | 62 |

## Unmeasurable selective commits

_none_

## BROKEN commits

_none_

## Skipped commits

- `1f3cb430fea251b5a27b377381f0c043313d78ae` — config/lockfile touched: package.json, pnpm-lock.yaml
- `11f30a8a8b85df3c7168a92041d4a7d9fd5800d8` — config/lockfile touched: package.json, pnpm-lock.yaml
