---
status: beadified
beadified_at: 2026-07-10
epic: va-pw0
refinement_rounds: 4
refinement_tier: medium
plan_clean_rounds: 3
source_backlog: none (born from 2026-07-09/10 correctness-audit conversation)
approved_at: 2026-07-10
---

# vitest-affected Next-Level Upgrade — blind-channel closure + regression pinning + evidence hardening

## Summary

Take vitest-affected from "good heuristic" to "trustworthy sole merge gate" now that BCA runs
affected-only per merge with ONE full suite at end of ac-loop. Close BCA's ~27 unguarded
blind-channel targets (~24 converted to `?raw` static imports; the 3 whole-tree scanner tests
always-run via a new minimal `alwaysRunTests` plugin option — 1.6s combined), fix the builder
query-handling gap, regression-pin the unpinned behaviors, verify the SHA-anchor monitoring wiring
(landed as `ebabefa8`, 2026-07-10), and add a checkpoint-freshness gate to ac-publish (ancestor +
evidence-only-commits semantics). The full `extraDependencies` config-map feature is CUT from this
wave (user decision 2026-07-10 after round-2 evidence); its completed design is banked in
Decision Log #11 for a future wave if a published-plugin consumer needs it.

**Type:** IMPROVE
**Complexity:** A LOT
**Journeys touched:** none (library + CI infrastructure)

## Assumptions

Decisions made in the Phase-0 interview (binding):
- **API shape = config map** plugin option (not colocated comments; comments may come later as sugar).
- **One cross-repo wave** spanning vitest-affected, body-compass-app, and agent-compounds (ac-publish).
  *Amended round 2 (cross-round consensus, Trimmer R1+R2):* split into **immediate chores** (Phase 1
  verification; Phase 5 publish gate — both independent of the feature) and the **feature wave**
  (Phases 2–4). Same total scope, honest sequencing.
- **Publish gate = strict SHA match** (evidence log's last checkpoint `sha` == `git rev-parse main`, else refuse).
  *Amended in refinement round 1 (Breaker, Critical):* literal equality can NEVER pass — the
  divergence-check's own `persistThroughGit` pushes an evidence commit B as a child of the tested
  commit A, so `RELEASE_SHA` is always B while the log records A. The gate's intent (nothing
  unverified lands before publish) is preserved with: `log.sha` must be an **ancestor** of
  `RELEASE_SHA` AND every commit in `log.sha..RELEASE_SHA` touches ONLY `_ci-evidence/` and/or
  `.beads/` paths (the checkpoint-persistence commits). Any other intervening commit → refuse.

**Feature-fate decision (user, 2026-07-10, after round-2 evidence):** the `extraDependencies`
config map is CUT from this wave — after `?raw` conversions, BCA's residual is 3 whole-tree
scanner tests (1.6s combined) that a minimal `alwaysRunTests: string[]` covers with far less
surface. The full design below (items 1-4 and the composeLookup spec) is BANKED for a future wave
if a published-plugin consumer needs it — see Decision Log #11.

Decisions made by the conductor absent an answer (retained as the BANKED design's record —
items 1-4 apply to `extraDependencies` if/when it is built):
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
3. **Zero-match test key fails CLOSED — scoped to matched entries** (amended round 1, Breaker High):
   a key resolving to no existing test file always emits a loud warning; it forces full suite
   (`reason: 'extra-dependencies-config-error'`) ONLY when that entry's watched rules matched a
   changed/deleted file in THIS run. Unconditional fail-closed would let one renamed test among
   ~27 entries force full suite on every run (even zero-diff), silently destroying selectivity —
   ordinary test churn, not rare misconfiguration. Scoped fail-closed keeps "typo is never silent"
   (warned every run, fatal exactly when the protection is actually needed).
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
The wave closes this by making the dependencies REAL imports (`?raw`) where possible and
always-running the whole-tree scanners where not.

**Key synthesized findings** (bullets 1-2 and the effective-map machinery describe the BANKED
extraDependencies design — see Decision Log #11; retained as its record):
- Insertion point: after cache load (plugin.ts step 5), build a per-run **effective lookup map**
  (loaded `reverse` + config-derived edges for matched changed/deleted files). Pass the effective
  map as `graphMembership` to `filterRelevantChangedFiles` (plugin.ts:864) so non-code watched
  extensions (.css/.sh/.yml/.mdx) survive the `DEFAULT_RELEVANT_EXTENSIONS` filter — reusing the
  proven override, zero new filter code. BFS consumes the effective map; `saveCacheSync` continues
  to receive the pristine runtime map.
- Matching runs on the RAW changed+deleted set before the relevance filter (same placement as
  fullSuiteTriggers, plugin.ts:791-810).
- All paths (map keys, matched files) route through `toCanonicalPath` — config-provided paths at
  the `options.changedFiles` boundary (plugin.ts:780-782); git-derived paths canonicalize
  separately inside `classify()` (git.ts:197). Both converge; macOS `/var`→`/private/var` and
  symlinked rootDir would otherwise silently orphan edges.
- Failure routing: rule-compile/match errors propagate to the existing catch-all
  (plugin.ts:1080-1089) → full suite. Never a local swallow.
- Contract: every exit still emits exactly one decision line (shadow.test.ts every-exit contract).
  `explain`/`SelectionTrail` chains will contain a non-import hop shown unlabeled in v1 —
  hop-labeling deferred to v1.1 (Decision Log #10).
- Cross-repo ordering: BCA CI builds the sibling dist from vitest-affected main HEAD (unpinned) —
  the plugin feature MUST merge first; reverse order fails loudly (TS excess-property error) at
  BCA's own gate.

## Outcome Definition

- Every one of BCA's ~27 blind-channel targets is closed: editing a formerly-invisible dependency
  either selects its test via a real (`?raw`) import edge, or the test is in `alwaysRunTests` and
  runs regardless — proven by tests.
- The audit-ranked unpinned behaviors have regression tests (6 audit pins + query-handling pin).
- BCA's loop-close full run produces `shadow-selective` checkpoints over real batch diffs.
- ac-publish refuses when any real (non-evidence) commit landed after the last checkpoint, and
  finds the existing loop-close run instead of redundantly re-firing.
- Scope note: selection re-evaluation is single-shot per process (`configureVitest`); live
  watch-mode re-matching is out of scope, same as all existing selection inputs.

## Technical Specification

### A. Plugin: `alwaysRunTests` + builder query-handling (vitest-affected)

**CUT (user decision 2026-07-10):** the full `extraDependencies` config map. Replaced by the
minimal option actually needed once `?raw` conversions cover the single-file targets:

```ts
/** Test files to include in EVERY selective run, unconditionally. For tests
 *  whose dependency surface is the whole tree (repo-wide scanners) — no
 *  per-file edge is meaningful, and their cost is accepted as always-paid.
 *  Paths repo-relative or absolute; canonicalized via toCanonicalPath. After
 *  the affected set is computed, these are unioned in (dedup'd). A path that
 *  resolves to no on-disk file → loud warning + full-suite fallback
 *  (reason: 'always-run-config-error') — with a handful of entries in the
 *  consumer's own config, a typo is rare and fail-closed is cheap.
 *  No-op under full-suite decisions (already included). Shadow mode: the
 *  decision line's selectedFiles reflects the union, include NOT mutated. */
alwaysRunTests?: string[];
```

Data flow (two small, independent changes):
1. **alwaysRunTests union** — at selection finalization. Requirements:
   - Cover BOTH selective-path `project.config.include` write sites: plugin.ts:993 (the
     `allowNoTests` zero-affected branch) AND plugin.ts:1060 (the normal `validTests > 0`
     branch) — union before whichever writes. With `allowNoTests` + zero affected, include
     becomes exactly the alwaysRun list (never `[]`).
   - Canonicalize each configured path via
     `toCanonicalPath(path.isAbsolute(p) ? p : path.resolve(rootDir, p))` — the same boundary
     as `options.changedFiles` (plugin.ts:780-782).
   - Verify on-disk existence: missing path → warn + full-suite
     `reason: 'always-run-config-error'`.
   - Union with dedup into the selected set.
   - Threshold (plugin.ts:1020-1033) evaluates BEFORE the union and alwaysRunTests entries are
     INTENTIONALLY exempt from the ratio check — a bounded, user-declared list cannot
     meaningfully change the ratio.
   - The union must also flow through `setSelectedTests` (plugin.ts:1057-1071) — updating only
     `include` would leave the selection self-verify heartbeat comparing against the pre-union
     set and fire a spurious `selection-mismatch` on every run that executes an alwaysRun test.
   - The decision line's `selectedFiles` reflects the union; the every-exit one-decision-line
     contract is unchanged; shadow mode never mutates include; the persisted cache is untouched
     (this never touches `reverse`).
2. **builder.ts query-handling** — a specifier carrying a query suffix (`?raw`/`?url`/…) is a
   REAL module import regardless of the underlying extension: strip the query for RESOLUTION but
   BYPASS `isBinarySpecifier` exclusion for query-suffixed specifiers. (Naive stripping alone is
   self-defeating: post-strip `.css` hits the binary-exclusion list and drops the seed anyway.)
   Bare `./x.css` stays excluded as before. Small fix + regression pin. This makes
   `?raw`-converted tests statically seedable in addition to the runtime edge they already get.

Deferred (design banked, Decision Log #11): the full `extraDependencies` config map — per-test
declared reverse edges, rule matching, copy-on-write effective-map composition, scoped
fail-closed. Fully spec'd across refinement rounds 1-2; build it when a published-plugin consumer
demonstrates the need.

### B. Regression pinning (vitest-affected, tests only)

Pin 7 behaviors: barrels/re-exports; tsconfig `paths`/`baseUrl` native resolution; `.json`
followed edge; plain-quote dynamic import literal + `${}` template skip; shallow-clone guard
FIRES (real shallow repo); plugin-level lockfile→full-suite e2e decision; query-suffixed
specifier (`./x.css?raw`) statically seeds after the query-handling fix (Section A item 2).
(`require()` and `vi.doMock` pins were considered and cut — the former pins a permanent absence,
the latter duplicates the vi.mock boundary suite at runtime.test.ts:567-598.)

### C. BCA wiring — ALREADY LANDED; verify + observe

The wiring shipped in BCA commit `ebabefa8` (2026-07-10 08:45, bead bd-mnj98 — which also engaged
affected-mode on PR runs): `vitest.config.mts` reads `VITEST_AFFECTED_REF`, `quality-gate.yml`
extracts the last-checkpoint anchor. Nothing to commit. The remaining gap: the evidence log's 3
lines all predate the wiring (`shadow-full-suite/no-changes`) — no full run has executed since.
Phase 1 is now: verify `ebabefa8` content matches the plan's intent, then observe the FIRST
post-wiring loop-close run and confirm its checkpoint line is `shadow-selective` with
`selectedCount > 0`.

### D. BCA blind-channel closure — per-target decision tree

BCA's own 2026-07-05 fixture-trigger audit (`_plans/research/2026-07-05-fixture-trigger-audit.md:123-152`)
already recommended converting single-file `fs.readFileSync` reads to Vite `?raw` static imports.
vitest-affected tracks these as real edges via the RUNTIME path (normalizeModuleId strips the
query in plugin.ts; the edge forms the first time the test executes and self-heals from there —
the conversion commit itself selects the test as its own seed, so no unprotected window). The
STATIC seed path currently drops `?raw` specifiers safely (extname `.css?raw` bypasses
isBinarySpecifier; oxc-resolver errors → `continue` at builder.ts:211) — Phase 2's query-handling
fix (Section A item 2) makes them statically seedable too. Consumption is a decision tree per
target, cheapest mechanism first:

1. **`?raw` static import** (~24 targets, the audit's rows 9-23,25,28,30-32 + convertible
   stragglers): single/few-file raw reads (`lib/db/symptoms.ts`, `app/globals.css`,
   `public/sw.js`, `page.tsx` wiring reads, the worker file, `content/` entries where a finite
   file list exists, execSync'd script sources) — mechanical test-file conversion, BCA-side only.
2. **`alwaysRunTests`** (the residual 3 whole-tree scanners: `no-hardcoded-theme-colors`,
   `bundle-hygiene`, `ci-hygiene` — dir rules would match nearly every diff anyway, and the three
   run in 1.6s combined): declared in BCA's config, unioned into every selective run.
3. **`fullSuiteTriggers`**: nothing new (already-guarded entries stay).

Any target that resists `?raw` conversion in practice joins the `alwaysRunTests` list (bounded,
visible cost) rather than resurrecting per-target machinery.

### E. ac-publish checkpoint-freshness gate (agent-compounds)

One bash check inserted into Phase 1a (SKILL.md:79-94), after `RELEASE_SHA` is pinned. Literal
`.sha == RELEASE_SHA` can NEVER pass: divergence-check.mjs records `sha: GITHUB_SHA` (tested
commit A) then `persistThroughGit` pushes the log-append as child commit B — main is always ≥1
commit past the recorded SHA after every legitimate checkpoint. Correct check:

```bash
set -euo pipefail   # a git/pathspec failure REFUSES, never silently passes
# `|| refuse` is attached DIRECTLY to each assignment: under set -e a bare VAR=$(cmd) failure
# aborts before any refuse message — accidentally fail-closed but silent. Attaching the test
# exempts the assignment from -e and routes through the actionable message.
LOG_SHA=$(tail -1 _ci-evidence/vitest-affected-divergence-log.jsonl | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).sha') \
  || refuse "evidence log missing/corrupt"
# (1) checkpoint must be an ancestor of the release SHA
git merge-base --is-ancestor "$LOG_SHA" "$RELEASE_SHA" || refuse "checkpoint $LOG_SHA not an ancestor of $RELEASE_SHA"
# (2) everything after the checkpoint must be evidence-persistence only.
# ':(exclude)' long-form pathspec REQUIRED — the ':!' short form throws "Unimplemented pathspec
# magic" on git 2.49, and $(…) capture would swallow the error and read empty = pass: the gate
# would fail OPEN. Long form verified live against BCA's git.
NON_EVIDENCE=$(git log --format='%H' "$LOG_SHA..$RELEASE_SHA" -- . ':(exclude)_ci-evidence' ':(exclude).beads') \
  || refuse "git log pathspec evaluation failed"
[ -z "$NON_EVIDENCE" ] || refuse "real (non-evidence) commit(s) after checkpoint: $NON_EVIDENCE"
```

Missing/empty/corrupt log → refuse (fail-closed). On refusal route to the existing Phase 3
fix-and-re-pin loop. Guard the whole check to repos that have the evidence log (BCA only),
mirroring the existing `quality-gate.yml` existence guard.

**Deliverable form:** the gate logic ships as `body-compass-app/scripts/ci/publish-checkpoint-gate.mjs`
(a standalone, unit-testable Node script mirroring the divergence-check.mjs pattern — the bash
above is its logic SPEC, not the shipped artifact). ac-publish's SKILL.md Phase 1a inserts a thin
guarded invocation: if the repo has the script, run it with `--release-sha "$RELEASE_SHA"` and
treat non-zero exit as refuse. One implementation, no duplicated logic across repos.

**Trust boundary:** this gate defends against STALENESS, not forgery —
path-scope cannot verify a log line's provenance (routine `.beads/`-only commits are common in BCA
history, and a hand-edited `_ci-evidence/` commit would pass the path check). Light sanity checks,
implemented in the .mjs script (the bash spec above shows only the core ancestry/path checks):
the last line must parse, carry a non-null `runId`, and its `sha` must be a reachable commit. Full provenance (cross-checking `runId` against `gh run view`) is deliberately out of
scope — the threat model is agent/script error, not adversarial commits to one's own repo.

**Companion fix:** the EXISTING Phase 1a lookup
`gh run list --workflow=quality-gate.yml --commit "$RELEASE_SHA"` (SKILL.md:87-96) has the same
exact-SHA flaw this section fixes — `RELEASE_SHA` sits ON TOP of the evidence commit, so the
lookup can essentially never match the loop-close run and every publish silently re-fires a full
run, defeating the "SHA-pinned read" optimization. Phase 5 also repoints that lookup to query by
the checkpoint's SHA (`LOG_SHA`) instead of `RELEASE_SHA`.

## Success Criteria

1. Silver Bullet integration test green (below) — with the control assertions proving the `?raw`
   edge and the `alwaysRunTests` union each did the selecting (not an accidental import edge).
2. Full quality gate green: `npm run build && npx tsc --noEmit && npx tsc -p tsconfig.test.json
   --noEmit && VITEST_AFFECTED_DISABLED=1 npx vitest run` (baseline: 306 tests / 21 files).
3. First post-merge loop-close checkpoint line has `decisionAction: "shadow-selective"` with
   `selectedCount > 0` (observable in `_ci-evidence/vitest-affected-divergence-log.jsonl`).
4. Publish-gate script: exit 0 on the normal post-checkpoint state (ancestor + evidence-only
   commits after); exit 1 + actionable message when any real commit landed after the checkpoint,
   on non-ancestry, or on missing/corrupt log (unit-tested against fixture repos/logs).
5. BCA closure lands end-to-end: the `?raw` conversions merged (spot-checked via
   `vitest-affected-explain` on a converted target), `alwaysRunTests` present in BCA's config
   with the 3 scanners, the backlog sketch annotated, and the sibling checkout `ref:`-pinned —
   i.e. Phase 4's Done-when checks all pass.

## Test Specifications

```yaml
test_specs:
  silver_bullet:
    file: 'test/blind-channel-closure.test.ts'
    type: 'Integration'
    description: 'Both closure mechanisms proven end-to-end: a ?raw-imported file edit selects its test; an alwaysRunTests entry rides every selective run. PREREQUISITES: add a raw-importable asset to a fixture (test/fixtures/simple or a new fixture) and extend the integration harness (setupFixture at test/integration.test.ts:44-70 hardcodes plugin config) to accept plugin options'
    assertions:
      - "Fixture: test T imports data file W via './w.txt?raw' (no other edge); warm cache from a prior run"
      - 'Changing W → selection includes T (the ?raw edge is live)'
      - 'Control: sibling file X with no edge → changing X does NOT select T'
      - 'Test S (no relation to the diff) listed in alwaysRunTests → S included in the selective run alongside BFS results'
      - 'Without alwaysRunTests: same diff → S NOT selected (proves the union came from the option)'

  supporting_tests:
    - name: 'alwaysRunTests + query-handling unit'
      file: 'test/blind-channel-closure.test.ts'
      type: 'Unit'
      cases:
        - 'union dedups (an alwaysRun test already BFS-selected appears once)'
        - 'allowNoTests + zero affected + alwaysRunTests → include = the alwaysRun list, not [] (BOTH write sites covered)'
        - 'run executing an alwaysRun test produces NO selection-mismatch heartbeat (setSelectedTests reflects the union)'
        - 'missing alwaysRunTests path → warn + full-suite fallback, reason always-run-config-error, single decision line'
        - 'relative path canonicalized against rootDir (symlinked rootDir converges)'
        - 'full-suite decision → option is a no-op (no double-include, decision line unchanged)'
        - 'shadow mode: selectedFiles reflects the union, include NOT mutated'
        - "builder query handling: './x.css?raw' and './y.ts?url' specifiers resolve to real files in static seeding (query stripped for resolution, binary-exclusion BYPASSED for query-suffixed specifiers); bare './x.css' still excluded as binary"
    - name: 'Regression pins — audit gaps'
      file: 'test/builder.test.ts, test/git.test.ts, test/plugin.test.ts, test/integration.test.ts (extend)'
      type: 'Unit/Integration'
      cases:
        - "barrel: export * from + export {x} from produce seed edges (builder)"
        - 'tsconfig paths/baseUrl alias resolves to real file (builder, real tsconfig fixture)'
        - '.json import is a followed edge end-to-end'
        - "plain-quote import('./x') captured; `${expr}` template skipped"
        - 'shallow clone + ref → throws the shallow-clone error (guard FIRES, real shallow repo)'
        - 'changed package-lock.json → full-suite decision at plugin level'
        - "query-suffixed specifier './x.css?raw' resolves to the real file in static seeding (post query-handling fix)"
    - name: 'Publish-gate script'
      file: 'body-compass-app scripts/ci/publish-checkpoint-gate.mjs (+ inline tests or smoke)'
      type: 'Unit'
      cases:
        - 'log sha == RELEASE_SHA → exit 0 (degenerate exact case)'
        - 'log sha is ancestor + only _ci-evidence/.beads commits after → exit 0 (the NORMAL post-checkpoint state)'
        - 'log sha is ancestor + a real (non-evidence) commit after → exit 1 with both SHAs and the offending commit in message'
        - 'log sha not an ancestor of RELEASE_SHA (history rewrite) → exit 1'
        - 'missing/empty/corrupt log → exit 1 (fail-closed)'
```

## Implementation Phases (with cross-repo ordering)

### Phase 1: BCA wiring verification (body-compass-app) — ALREADY LANDED, verify + observe
Wiring shipped as `ebabefa8` (bd-mnj98). Verify the committed content matches Section C intent
(anchor extraction guarded, `--changed-ref` aligned), then observe the first post-wiring
loop-close run.
**Done when:** the next loop-close checkpoint line in the evidence log has
`decisionAction: "shadow-selective"` and `selectedCount > 0` (or a documented legitimate
full-suite reason), and the run logged `[shadow-anchor] diff base = last checkpoint <sha>`.

### Phase 2: alwaysRunTests option + builder query-handling (vitest-affected)
Option type + JSDoc, selection-finalization union (both write sites + setSelectedTests),
fail-closed missing-path handling; specifier query-handling in builder.ts. Includes the test
prerequisites the Silver Bullet depends on: a raw-importable fixture asset and integration-harness
plugin-option injection (see Test Specifications).
**Done when:** Silver Bullet + unit specs green; full quality gate green.

### Phase 3: Regression pinning (vitest-affected)
The 7 pinned behaviors above (6 audit pins post-trim + the query-handling pin).
**Done when:** all new tests green AND each new test demonstrably fails when its pinned mechanism
is reverted (spot-check via temporary mutation during review).

### Phase 4: Merge plugin → then BCA blind-channel closure (ORDERING HARD CONSTRAINT for 4b)
4a. Convert the ~24 single-file fs-read targets to `?raw` static imports (BCA-side, per the
2026-07-05 audit's candidate rows — NO plugin dependency, can start before Phases 2-3 merge).
4b. After vitest-affected main has the option (BCA CI builds sibling dist from main HEAD), three
deliverables:
   - Add `alwaysRunTests` to BCA's vitest.config.mts with the 3 whole-tree scanners (+ any 4a
     stragglers).
   - Annotate `_backlog/intelligent-test-selection.md:227`'s old inverted sketch as superseded
     by this plan — one API shape in the pipeline.
   - PIN the sibling checkout: `quality-gate.yml`'s vitest-affected checkout gets an explicit
     `ref:` recorded in BCA (the SHA its config was validated against, bumped deliberately) —
     today it builds main HEAD at checkout time, so a BCA PR can silently retest against a
     different plugin commit between pushes. (Longer-term: npm-versioned dependency per
     `_backlog/publicize-plugin.md`.)
**Done when:** BCA quality gate green; changing `app/globals.css` locally selects
`globals-css-light-mode.test.ts` (via `?raw` edge after a full run, shown by
`vitest-affected-explain` or a selective run); a selective run on an unrelated diff includes the
3 `alwaysRunTests` scanners in its selected set (visible in the stats decision line);
`grep -n "superseded by" _backlog/intelligent-test-selection.md`
hits the annotated sketch line; `grep -n "ref:" ../body-compass-app/.github/workflows/quality-gate.yml`
shows the pinned checkout.

### Phase 5: ac-publish checkpoint-freshness gate (agent-compounds + BCA script)
Gate script (ancestor + evidence-only-commits semantics + sanity checks per Section E) + SKILL.md
Phase 1a insertion (guarded to repos with the evidence log) + repoint the existing Phase 1a
`gh run list --commit` lookup to `LOG_SHA` (Section E companion fix).
**Done when:** all 5 gate script cases pass (including the NORMAL post-checkpoint state passing
and a real intervening commit refusing); dry-run of ac-publish Phase 1a on a stale checkpoint
refuses with the actionable message; dry-run on a fresh checkpoint FINDS the existing loop-close
run (no redundant full-run fire).

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| `?raw` conversion changes test semantics (content served by Vite transform vs raw disk read) | Per-file review during 4a; any test where the loaded content differs (e.g. needs untransformed bytes) stays on the alwaysRunTests list instead |
| alwaysRunTests list rots (scanner test renamed) | Fail-closed: missing path → warn + full suite (3 entries, consumer's own config — rare and loud) |
| Cold-cache window on a `?raw` edge (edge forms at first executed run) | Self-healing: the conversion commit selects the test as its own seed; query-handling fix makes static seeding work too |
| Cross-repo ordering mistake | Phase 4 ordering is explicit; wrong order fails loudly at BCA TS gate (see the cross-repo ordering bullet in Context & Research) |
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
7. **(Round 1) Supersedes the master-plan sketch** `_backlog/intelligent-test-selection.md:227`
   (`Record<source-glob, test-globs[]>` — inverted direction). This plan's `test → watched rules`
   direction is the user-approved shape; Phase 4b annotates the old sketch as superseded.
8. **(Round 1) `?raw`-first decision tree for BCA consumption** — see Section D for the full
   rationale (collapsed round 3; was a near-verbatim duplicate). Non-duplicated remainder:
   the alternative (declare all ~27 targets as config-map entries) was rejected as a 5× larger
   config-drift surface for zero benefit on convertible targets. Residual handling moved to
   `alwaysRunTests` per Decision Log #11.
9. **(Round 1) Gate semantics: ancestor + evidence-only-commits** replaces literal SHA equality —
   equality is structurally impossible after every legitimate checkpoint (evidence commit is a
   child of the tested SHA). Alternatives (record parent SHA in the log; ancestry-only check)
   rejected: parent-SHA requires changing divergence-check.mjs's persisted format; ancestry-only
   would pass with unverified real commits on top.
10. **(Round 1) Stats field + explain-hop labeling deferred to v1.1** (Builder+Trimmer consensus):
    `SelectionTrail.chain` is a flat `string[]` with no per-hop metadata slot; labeling requires a
    4-file type change (selector/explain-core/explain-cli/plugin) the wave doesn't need to prove
    correctness.
11. **(User decision 2026-07-10, post round 2) `extraDependencies` CUT from the wave; design
    BANKED.** Round-2 Trimmer measured the post-`?raw` residual: 3 whole-tree scanner tests whose
    dir rules match nearly every diff (degenerate always-run) costing 1.6s combined — a minimal
    `alwaysRunTests: string[]` achieves the same coverage with a fraction of the surface. The
    complete extraDependencies design (Assumptions 1-4: rule-matching semantics, per-run in-memory
    recompute, scoped fail-closed, literal keys; plus the round-1 copy-on-write composeLookup spec
    and the three call-site enumeration) is recorded in this document and buildable later if a
    published-plugin consumer (see `_backlog/publicize-plugin.md`) demonstrates the need. Trigger to
    revisit: a real consumer with fs-read tests they cannot restructure to `?raw`.

## Phased Rollout

Restructured round 2 (cross-round consensus):
- **Chores, ship immediately, independent of the feature:** Phase 1 (verification-only) and
  Phase 5 (publish gate + existing-lookup fix). Phase 4a (`?raw` conversions) is also
  plugin-independent and may start any time.
- **Feature wave, strictly ordered:** Phases 2-3 (plugin, one PR) → merge → Phase 4b (BCA
  residual map + checkout pin, one PR).

## Dependencies / Blockers

- No new libraries (alwaysRunTests is a union + existsSync; query-handling is string handling).
- Merge-conflict watch: open bead `va-hygiene-20260706-deferred-wlm.1` ("refactor configureVitest
  into a staged discriminated-result pipeline") touches the same function Phase 2 edits —
  coordinate or sequence the bead behind this wave.
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

## Refinement Log

### Round 1 (Medium: Builder, Breaker, Trimmer — 3x Opus)

- **Changes:** 7 applied (3 Critical, 3 High, 1 same-round consensus)
- **Key fixes:** Publish gate redesigned (literal SHA equality can never pass — evidence commit is
  a child of the tested SHA; now ancestor + evidence-only-commits). BCA consumption rescoped to a
  ?raw-first decision tree (~20 targets convert to native imports per BCA's own 2026-07-05 audit;
  extraDependencies covers the ~3-6 residual). Phase 1 rewritten — wiring already landed as
  ebabefa8. composeLookup precisely spec'd (copy-on-write, Set-identity test) to prevent cache
  leakage. Fail-closed scoped to matched keys. Explain labeling + stats field deferred to v1.1.
- **Consensus:** Builder+Trimmer independently flagged explain-labeling as undesigned/premature
  (cut). All three found different Criticals in different sections — low overlap, high coverage.
- **Trajectory:** major structural changes (gate semantics, consumption strategy, phase rewrite) →
  convergence: major → continue to Round 2 (mandatory: Criticals found this round).

### Round 2 (Medium: Builder, Breaker, Trimmer — 3x Opus)

- **Changes:** 7 applied (1 Critical, 4 High, 2 cross-round consensus)
- **Key fixes:** Gate trust boundary documented + sanity checks (staleness, not forgery — .beads-only
  commits are routine). ?raw claim corrected: runtime-path-only today; Phase 2 gains the builder.ts
  query-handling fix + pin. extraDependencyConfigErrors added to the decision line (autonomous-loop
  visibility). Existing ac-publish Phase 1a lookup repointed to LOG_SHA (same exact-SHA flaw as the
  gate, found in neighboring code). Sibling checkout pinned (ref: in quality-gate.yml). Wave split:
  chores (1, 5, 4a) vs feature wave (2-3 → 4b). require()/vi.doMock pins cut (cross-round).
- **Consensus:** cross-round ×2 (wave split, pin cuts). Trimmer's keep-or-cut Critical on the
  feature itself → DESIGN_DECISION, presented to user before round 3.
- **Trajectory:** major (gate scope, feature-value question open) → Round 3 after the design
  decision settles the plan's shape.

### Design decision (user, 2026-07-10, between rounds 2 and 3)

- **extraDependencies CUT; design banked (Decision Log #11).** Wave rescoped: `?raw` conversions
  (~24) + minimal `alwaysRunTests` option (3 scanners, 1.6s) + query-handling fix + pins + gate.
  Plan sections rewritten accordingly (Summary, A, D, Outcome, specs, Phases 2/4, Risks).

### Round 3 (Medium: Builder, Breaker, Trimmer — 3x Opus, on the rescoped plan)

- **Changes:** 8 applied (3 Critical incl. 1 same-round duplicate, 2 High, 2 Medium, 1 registry
  cross-round: Decision Log #8 collapse)
- **Key fixes:** Query handling corrected — naive stripping was self-defeating (post-strip .css
  hits binary exclusion); now strip-for-resolution + bypass-exclusion for query-suffixed
  specifiers. Gate pathspec syntax fixed to ':(exclude)' long form + set -euo pipefail — the
  ':!' form threw on git 2.49 and the error would have been swallowed, failing the gate OPEN.
  alwaysRunTests union spec now covers BOTH include write sites (:993 allowNoTests branch and
  :1060) AND setSelectedTests (spurious selection-mismatch heartbeat otherwise). Threshold
  exemption documented as intentional. Stale Phase-4b extraDependencies criterion replaced.
  Silver Bullet prerequisites (fixture asset + harness option injection) added.
- **Consensus:** Builder+Trimmer same-round on the stale Phase-4b criterion; Builder Critical and
  Breaker High converged on the allowNoTests drop from opposite directions.
- **Trajectory:** all findings were in refinement-added text or newly-scoped surface, none in the
  core approach — but Criticals were found, so Rule 1 mandates Round 4 (final; MAX_ROUNDS=4).

### Round 4 (verification: Builder + Breaker — 2x Opus; Trimmer omitted, structure cleared in R3)

- **Changes:** 1 applied (Medium: `|| refuse` attached to gate assignments — bare VAR=$() under
  set -e aborts before the actionable message; accidentally fail-closed but silent)
- **Verification:** Builder — ZERO findings, all citations re-verified, plan judged
  self-sufficient. Breaker — 3 of 4 round-3 fixes HOLD under live attack (pathspec run against
  BCA's actual git 2.49; binary-bypass traced: resolved targets never re-parsed; heartbeat clean
  in shadow/watch).
- **Trajectory:** two consecutive rounds without Critical/High → CONVERGED at MAX_ROUNDS=4.

### Conductor triage (Phase 5)

- AUTO_IMPLEMENT: bead-collision watch line (va-hygiene-20260706-deferred-wlm.1 vs Phase 2, from
  R1 registry); canonicalization dual-boundary precision (git.ts:197, from R1 registry).
- Already applied earlier: watch-mode scope-out (Outcome), pin cuts (R3), wave split (R2),
  Decision Log #8 collapse (R3).
- DISCARDED (no consensus, pre-existing behavior unchanged by this wave): non-JS graph-member
  files reaching delta-parse parseSync — exists today for CSS runtime edges, warn-and-continue.
- No DESIGN_DECISION / SCOPE_ESCALATION items remain (feature fate resolved by user mid-flow).
