---
status: approved
refinement_rounds: 0
source_backlog: none (born from 2026-07-09/10 correctness-audit conversation)
approved_at: 2026-07-10
---

# vitest-affected Next-Level Upgrade — extraDependencies + regression pinning + evidence hardening

## Summary

Take vitest-affected from "good heuristic" to "trustworthy sole merge gate" now that BCA runs
affected-only per merge with ONE full suite at end of ac-loop. Ship the `extraDependencies`
option (per-test declared reverse edges closing the blind-channel class), regression-pin the
8 unpinned behaviors, commit the SHA-anchor monitoring wiring in BCA, wire BCA's ~27 unguarded
targets, and add a strict-SHA checkpoint-freshness gate to ac-publish.

**Type:** IMPROVE
**Complexity:** A LOT
**Journeys touched:** none (library + CI infrastructure)

## Assumptions

Decisions made in the Phase-0 interview (binding):
- **API shape = config map** plugin option (not colocated comments; comments may come later as sugar).
- **One cross-repo wave** spanning vitest-affected, body-compass-app, and agent-compounds (ac-publish).
- **Publish gate = strict SHA match** (evidence log's last checkpoint `sha` == `git rev-parse main`, else refuse).

Decisions made by the conductor absent an answer (pressure-test these in refinement):
1. **Watched-path matching uses fullSuiteTriggers semantics** (`Array<string | RegExp>`, string = exact
   or prefix vs repo-relative path), NOT tinyglobby expansion. Rationale: glob expansion runs against
   the filesystem and cannot see a *deleted* watched file (deletion must still select the test);
   matching changed/deleted paths against rules handles create/edit/delete uniformly, reuses
   `matchesAnyRule`, and adds zero dependencies. Every BCA target is expressible (dir globs like
   `app/**` become prefix `app/`). If refinement decides literal glob syntax is a hard UX requirement,
   swap `matchesAnyRule` for a picomatch-based matcher — the architecture is unchanged.
2. **Injected edges are recomputed per run, in-memory only — never persisted to the v3 cache.**
   Rationale: `mergeRuntimeEdges`'s `scope:'all'` per-test overwrite (runtime-merge.ts:27-33) would
   strip a persisted config edge the first time its test runs without the watched file in
   `importDurations`; and persisted edges would go stale when the config map is edited. Config is
   the source of truth; recompute is O(changed × rules) per run.
3. **Zero-match test key fails CLOSED**: if an `extraDependencies` key resolves to no existing test
   file, the plugin warns and falls back to full suite (`reason: 'extra-dependencies-config-error'`).
   A typo'd key is an absent protection; silence would be an under-selection factory.
4. **Map keys are literal test paths** (repo-relative or absolute), not test globs, in v1. BCA's 27
   targets are all single named test files.

## Backlog Items

- none (plan born from live audit conversation; research files below are the source record)

## Context & Research

Research: `_plans/research/2026-07-10-1210-correctness-audit-synthesis-vitest-affected-upgrade.md`
(the motivating three-way audit), plus `2026-07-10-1230-exploration-{patterns,dependencies,constraints}-vitest-affected-upgrade.md`
and `2026-07-10-1230-baseline-vitest-affected-upgrade.md`.

**Architecture invariant driving the design:** the authoritative reverse graph is built solely from
runtime `importDurations`; static parse is seed-only. Any channel invisible to runtime import
tracking (fs-reads, workers, execSync'd scripts) has NO reverse edge → silent under-selection.
`extraDependencies` closes this by injecting reverse edges from config.

**Key synthesized findings:**
- Insertion point: after cache load (plugin.ts step 5), build a per-run **effective lookup map**
  (loaded `reverse` + config-derived edges for matched changed/deleted files). Pass the effective
  map as `graphMembership` to `filterRelevantChangedFiles` (plugin.ts:864) so non-code watched
  extensions (.css/.sh/.yml/.mdx) survive the `DEFAULT_RELEVANT_EXTENSIONS` filter — reusing the
  proven override, zero new filter code. BFS consumes the effective map; `saveCacheSync` continues
  to receive the pristine runtime map.
- Matching runs on the RAW changed+deleted set before the relevance filter (same placement as
  fullSuiteTriggers, plugin.ts:791-810).
- All paths (map keys, matched files) route through `toCanonicalPath` at the same boundary as
  `options.changedFiles` (plugin.ts:780-782) — macOS `/var`→`/private/var` and symlinked rootDir
  would otherwise silently orphan edges.
- Failure routing: rule-compile/match errors propagate to the existing catch-all
  (plugin.ts:1080-1089) → full suite. Never a local swallow.
- Contract: every exit still emits exactly one decision line (shadow.test.ts every-exit contract);
  `explain`/`SelectionTrail` chains gain a non-import hop — label extraDependencies-sourced edges
  in explain output so provenance isn't misrepresented as an import.
- Cross-repo ordering: BCA CI builds the sibling dist from vitest-affected main HEAD (unpinned) —
  the plugin feature MUST merge first; reverse order fails loudly (TS excess-property error) at
  BCA's own gate.

## Outcome Definition

- Editing (or deleting) a watched non-imported file selects its declared test(s) — proven by tests.
- All 8 audit-ranked unpinned behaviors have regression tests.
- BCA's loop-close full run produces `shadow-selective` checkpoints over real batch diffs.
- BCA's ~27 unguarded invisible-dependency targets are declared as extraDependencies.
- ac-publish refuses on a stale/missing checkpoint with an actionable message.

## Technical Specification

### A. Plugin: `extraDependencies` (vitest-affected)

```ts
/** Declared non-import dependencies: test file → watched path rules.
 *  Key: literal test file path (repo-relative or absolute).
 *  Value: Array<string | RegExp> — string is exact path or directory prefix
 *  (repo-relative, same semantics as fullSuiteTriggers); RegExp tested against
 *  the repo-relative path. A changed/deleted file matching any rule injects a
 *  reverse edge (file → test) for THIS run. Edges are never persisted; config
 *  is re-evaluated every run. A key resolving to no on-disk test file forces
 *  full suite (fail-closed) with reason 'extra-dependencies-config-error'. */
extraDependencies?: Record<string, Array<string | RegExp>>;
```

Data flow (new step ~6a′, between fullSuiteTriggers check and relevance filter):
1. Canonicalize each key → absolute test path; verify existence (missing → warn + full-suite).
2. For each RAW changed/deleted file: `matchesAnyRule(toRepoRelative(file), rules)` per entry;
   on match, record edge `file → testPath` in `extraEdges: ReverseMap`.
3. `effectiveReverse = composeLookup(reverse, extraEdges)` (shallow union; no mutation of `reverse`).
4. Pass `effectiveReverse` as `graphMembership` (filter survival) and to BFS.
5. Stats line gains optional `extraDependencyMatches: number`; explain chains label injected hops.

### B. Regression pinning (vitest-affected, tests only)

Pin: barrels/re-exports; tsconfig `paths`/`baseUrl` native resolution; `require()` behavior
(document static-blindness); `.json` followed edge; plain-quote dynamic import literal + `${}`
template skip; shallow-clone guard FIRES (real shallow repo); plugin-level lockfile→full-suite
e2e decision; `vi.doMock` boundary.

### C. BCA wiring commit (body-compass-app — edits already made, uncommitted)

`vitest.config.mts` (`ref: process.env.VITEST_AFFECTED_REF ?? 'main'`) + `quality-gate.yml`
(anchor extraction → `VITEST_AFFECTED_REF`/`GITHUB_ENV` + `--changed-ref` alignment).

### D. BCA extraDependencies consumption (body-compass-app)

Add the map next to `fullSuiteTriggers` in vitest.config.mts covering the audit's unguarded
targets (exact files + dir prefixes for whole-tree scanners: `app/`, `components/`, `features/`,
`lib/`, `content/`, `public/workers/`, `scripts/inject-theme-script.sh`, workflow yml, …).

### E. ac-publish strict-SHA gate (agent-compounds)

One bash check inserted into Phase 1a (SKILL.md:79-94), after `RELEASE_SHA` is pinned: read last
line of `_ci-evidence/vitest-affected-divergence-log.jsonl`, require `.sha == RELEASE_SHA`; on
mismatch/missing → refuse, route to the existing Phase 3 fix-and-re-pin loop. Guard the check to
repos that have the log (BCA only), mirroring the existing `quality-gate.yml` existence guard.

## Success Criteria

1. Silver Bullet integration test green (below) — and RED when `extraDependencies` is omitted
   (proving selection came from the feature, not an import edge).
2. Full quality gate green: `npm run build && npx tsc --noEmit && npx tsc -p tsconfig.test.json
   --noEmit && VITEST_AFFECTED_DISABLED=1 npx vitest run` (baseline: 306 tests / 21 files).
3. First post-merge loop-close checkpoint line has `decisionAction: "shadow-selective"` with
   `selectedCount > 0` (observable in `_ci-evidence/vitest-affected-divergence-log.jsonl`).
4. Publish-gate script: exit 1 + message on SHA mismatch or missing log; exit 0 on match
   (unit-tested against fixture logs).

## Test Specifications

```yaml
test_specs:
  silver_bullet:
    file: 'test/extra-dependencies.test.ts'
    type: 'Integration'
    description: 'A changed watched file with NO import edge selects its declared test — and only via the feature'
    assertions:
      - 'Fixture: test T fs-reads data file W (never imported); warm v3 cache with runtime edges present'
      - 'With extraDependencies {T: [W]}: changing W → selection includes T (projectConfig.include)'
      - 'Without extraDependencies: changing W → T NOT selected (proves no accidental import edge)'
      - 'Deleting W → T selected (deletion path)'
      - 'W has a non-code extension (.txt or .css) → survives the relevance filter via effective graphMembership'

  supporting_tests:
    - name: 'extraDependencies unit — matching, canonicalization, fail-closed'
      file: 'test/extra-dependencies.test.ts'
      type: 'Unit'
      cases:
        - 'prefix-string rule matches nested file; RegExp rule matches; non-match adds no edge'
        - 'missing test-file key → full-suite fallback, reason extra-dependencies-config-error, single decision line'
        - 'rule-evaluation throw propagates to catch-all → full-suite reason=error'
        - 'injected edges NEVER appear in saved graph.json (cache stays pristine)'
        - 'shadow mode: decision line reflects extra-dep selection, include NOT mutated'
        - 'explain chain labels the injected hop as extra-dependency, not import'
    - name: 'Regression pins — audit gaps'
      file: 'test/builder.test.ts, test/git.test.ts, test/plugin.test.ts, test/integration.test.ts (extend)'
      type: 'Unit/Integration'
      cases:
        - "barrel: export * from + export {x} from produce seed edges (builder)"
        - 'tsconfig paths/baseUrl alias resolves to real file (builder, real tsconfig fixture)'
        - 'require() specifier: document current behavior (not captured statically) with pinning test'
        - '.json import is a followed edge end-to-end'
        - "plain-quote import('./x') captured; `${expr}` template skipped"
        - 'shallow clone + ref → throws the shallow-clone error (guard FIRES, real shallow repo)'
        - 'changed package-lock.json → full-suite decision at plugin level'
        - 'vi.doMock boundary documented (edge or no edge, matching vi.mock test style)'
    - name: 'Publish-gate script'
      file: 'body-compass-app scripts/ci/publish-checkpoint-gate.mjs (+ inline tests or smoke)'
      type: 'Unit'
      cases:
        - 'last sha == HEAD → exit 0'
        - 'last sha != HEAD → exit 1 with both SHAs in message'
        - 'missing/empty/corrupt log → exit 1 (fail-closed)'
```

## Implementation Phases (with cross-repo ordering)

### Phase 1: BCA wiring commit (body-compass-app) — INDEPENDENT, DO FIRST
Commit the existing uncommitted `vitest.config.mts` + `quality-gate.yml` edits.
**Done when:** `git -C ../body-compass-app status` clean for those files; next loop-close run
logs `[shadow-anchor] diff base = last checkpoint <sha>`.

### Phase 2: extraDependencies feature (vitest-affected)
Option type + JSDoc, matching step, effective lookup map, filter/graphMembership wiring, explain
labeling, stats field.
**Done when:** Silver Bullet + unit specs green; full quality gate green; cache-pristine
assertion green.

### Phase 3: Regression pinning (vitest-affected)
The 8 pinned behaviors above.
**Done when:** all new tests green AND each new test demonstrably fails when its pinned mechanism
is reverted (spot-check via temporary mutation during review).

### Phase 4: Merge plugin → then BCA consumption (ORDERING HARD CONSTRAINT)
Merge vitest-affected main first (BCA CI builds sibling dist from main HEAD). Then add BCA's
extraDependencies map for the ~27 targets.
**Done when:** BCA quality gate green with the map; changing `app/globals.css` locally selects
`globals-css-light-mode.test.ts` via `vitest-affected-explain` or a selective run.

### Phase 5: ac-publish strict-SHA gate (agent-compounds + BCA script)
Gate script + SKILL.md Phase 1a insertion (guarded to repos with the evidence log).
**Done when:** script unit cases pass; dry-run of ac-publish Phase 1a on a stale checkpoint
refuses with the actionable message.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Config-map drift (declared deps rot as tests change) | Fail-closed on missing test keys makes rot loud; audit synthesis doc records the source mapping |
| Broad prefix rules (whole-tree scanners) degrade selectivity | Accepted: those tests genuinely depend on the tree; still better than fullSuiteTriggers (only those tests run, not the world) |
| mergeRuntimeEdges interaction regressions | Cache-pristine test + effective-map composition (no mutation of `reverse`) |
| Cross-repo ordering mistake | Phase 4 ordering is explicit; wrong order fails loudly at BCA TS gate (constraint 7 evidence) |
| Publish gate false-positives (log updated by CI push racing local main) | Gate compares against `RELEASE_SHA` pinned at publish start; failure path is the existing re-pin loop |
| Shadow/stats contract break | every-exit tests already pin the contract; new early-return emits one line (spec'd) |

## Decision Log (alternatives considered)

1. **Rule matching vs tinyglobby expansion** — chose rule matching (deletion handling, zero deps,
   fullSuiteTriggers consistency). Alternative (glob expansion) rejected: blind to deleted watched
   files; picomatch matcher is the fallback if glob syntax becomes a UX requirement.
2. **Recompute vs persist injected edges** — chose recompute in-memory. Persisting rejected:
   overwrite-stripping by runtime merges + staleness on config edit.
3. **Colocated comment directives** — deferred (interview). Config map ships first; comments as sugar later.
4. **BFS-seed injection** — rejected: seeds are per-run forward hints, not reverse edges; would
   only fire when the *watched* file is in the diff being analyzed, which is exactly the working case —
   but seeds don't create the reverse hop watched→test, so the test would still not be selected.
5. **Publish gate softness** (fresh-within-loop / warn-only) — rejected by interview: strict SHA match.
6. **.snap handling / staleness forcing / new trigger machinery** — out of scope (settled; see synthesis).

## Phased Rollout

Wave order: Phase 1 (instant, unblocks evidence) → Phases 2-3 (plugin, one PR) → merge → Phase 4
(BCA PR) → Phase 5 (agent-compounds + BCA script PR). Phases 1 and 5 have no dependency on 2-4
and can proceed in parallel if beads are assigned accordingly (5's dry-run needs any checkpoint,
not the new selective kind).

## Dependencies / Blockers

- tinyglobby NOT needed for v1 (rule matching); no new libraries.
- Phase 4 blocked by Phases 2-3 merged to vitest-affected main (BCA CI sibling-dist HEAD build).
- Phase 5 touches shared skill `agent-compounds/skills/ac-land`-adjacent territory (`ac-publish`);
  guard the new check to repos with the evidence log (only BCA today) — same guard pattern as the
  quality-gate existence check.
- Evidence log currently has 3 lines, all `shadow-full-suite/no-changes`; after Phase 1 the next
  loop-close produces the first meaningful selective checkpoint (~68-file batch as of 2026-07-09).

## Validation

Full quality gate (build + 2× tsc + full vitest) on vitest-affected; BCA quality gate on the
consumption PR; publish-gate script unit cases; first real loop-close checkpoint observed as
`shadow-selective`.
