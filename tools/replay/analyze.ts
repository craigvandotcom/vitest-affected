// ---------------------------------------------------------------------------
// Run analysis
// ---------------------------------------------------------------------------
// See analysis.ts (the barrel) for the full MEASUREMENT MODEL and
// DENOMINATOR & EXEMPTIONS writeup this module implements; this module (with
// detector.ts) is the canonical home of the denominator/exemption rules.
//
// IMPORT NOTE (load-bearing): mergeRuntimeEdges / ReverseMap come from the
// BUILT private entry ('../../dist/internal.js') via evolution.ts — the same
// artifact the replay harness ships against — never from src (importing src
// would measure unbuilt code). Run `npm run build` if dist is stale/missing.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ReverseMap } from '../../dist/internal.js';
import { evolveStep } from './evolution.js';
import {
  detectStructuralMisses,
  detectOutcomeConfirmed,
  assertSelectiveDecisions,
} from './detector.js';
import type {
  RunAnalysis,
  CommitAnalysis,
  InventoriedCommit,
} from './report.js';
import { parseLedger, parseGraphReverseMap, parseOutcomes } from './parsers.js';
import { loadFlakyBySha } from './flake.js';

export interface AnalyzeRunOptions {
  /** The A2a run directory (contains ledger.jsonl, graphs/, outcomes/). */
  runDir: string;
  /**
   * The CANONICAL clone root the graph paths are anchored at — used to
   * absolutize the ledger's repo-relative changed-file paths so they share
   * the graph's path space (file-path identity is the join key everywhere).
   */
  rootDir: string;
}

/**
 * Analyze a completed replay run. Throws NoSelectiveDecisionsError on an
 * all-full-suite walk (degeneration guard) — callers surface it on the report
 * path (CLI exits non-zero). Read-only over the run dir.
 */
export async function analyzeRun(
  opts: AnalyzeRunOptions,
): Promise<RunAnalysis> {
  const { runDir, rootDir } = opts;
  const ledgerContent = await readFile(
    path.join(runDir, 'ledger.jsonl'),
    'utf-8',
  );
  const entries = parseLedger(ledgerContent);

  // DEGENERATION GUARD — before any per-commit work, fail the run loudly.
  assertSelectiveDecisions(entries);

  const flakyBySha = await loadFlakyBySha(runDir);

  const brokenCommits: InventoriedCommit[] = [];
  const skippedCommits: InventoriedCommit[] = [];
  const unmeasurableCommits: InventoriedCommit[] = [];
  const commits: CommitAnalysis[] = [];
  const fallbackFrequency: Record<string, number> = {};
  const missesByChannel: Record<string, number> = {};

  let warmupDone = false;
  let warmupCommits = 0;
  let okCommits = 0;
  let selectiveDecisions = 0;
  let commitsWithStructuralMiss = 0;
  let commitsWithOutcomeConfirmedMiss = 0;
  let totalStructuralMisses = 0;
  let totalOutcomeConfirmedMisses = 0;
  // Outcome-join guard: how many structurally-missed tests were FOUND in the
  // commit's outcome map. Structural misses with ZERO joins across the whole
  // walk means the outcome-confirmed tier is likely path-broken, not clean.
  let outcomeJoinMatches = 0;
  // Structural-join guard: how many changed files (in the graph's path space)
  // were FOUND as keys of the fresh ground-truth map — i.e. actually joined the
  // structural tier (computeRequiredTests does freshMap.get(file)). If NO
  // selective commit's changed files ever join, yet some selective commit HAD
  // changed files, the changed-file→graph path space is desynced and an empty
  // structural miss-set is vacuous, not clean. A DIFFERENT join than
  // outcomeJoinMatches (which counts missed tests present in the outcome map).
  let structuralJoinMatches = 0;
  let sawSelectiveChanges = false;

  // The simulated live selective cache, threaded commit → commit.
  let cache: ReverseMap = new Map();
  // Outcomes at the previous OK commit with outcome data (C-1 for flips).
  let prevOutcomes: Map<string, string> = new Map();

  for (const entry of entries) {
    if (entry.status === 'skipped') {
      skippedCommits.push({ sha: entry.sha, reason: entry.reason });
      continue;
    }
    if (entry.status === 'BROKEN') {
      brokenCommits.push({ sha: entry.sha, reason: entry.reason });
      continue;
    }
    okCommits++;
    const decision = entry.decision;
    if (!decision) {
      // An ok commit without a decision violates A2a's fail-closed contract;
      // treat as BROKEN rather than silently clean.
      brokenCommits.push({
        sha: entry.sha,
        reason: 'ok entry without shadow decision (ledger contract violation)',
      });
      continue;
    }

    // Load per-commit artifacts.
    const graphPath = path.join(runDir, 'graphs', `${entry.sha}.json`);
    const freshMap = existsSync(graphPath)
      ? parseGraphReverseMap(await readFile(graphPath, 'utf-8'), rootDir)
      : null;
    const outcomesPath = path.join(runDir, 'outcomes', `${entry.sha}.json`);
    // Outcome test names are normalized into the graphs' canonical path space
    // (path.resolve against the canonical rootDir — same realpath'd cloneDir)
    // so the C-1→C outcome join uses the same file-path identity as the edge
    // maps. A mismatch here would silently zero the outcome-confirmed tier;
    // the join guard below catches whatever normalization cannot.
    const outcomes = existsSync(outcomesPath)
      ? normalizeOutcomePaths(
          parseOutcomes(await readFile(outcomesPath, 'utf-8')),
          rootDir,
        )
      : new Map<string, string>();

    const changedRel = entry.changedFiles ?? null;
    const changedAbs = (changedRel ?? []).map((f) => path.resolve(rootDir, f));

    const selective = decision.action === 'shadow-selective';
    if (selective && !warmupDone) warmupDone = true;

    // Evolution step — computed ONCE per commit with a graph artifact, for
    // EVERY segment (warm-up 'all' warming, fallbacks, selective): it yields
    // both the simulated live selection (detection) and the persisted
    // cacheAfter (threaded into C+1). See evolution.ts for the scope rules —
    // the recorded selectedFiles are never fed back into the cache (that
    // would break the drift feedback loop).
    const step =
      freshMap !== null
        ? evolveStep(cache, {
            sha: entry.sha,
            freshMap,
            decision,
            changedFiles: changedAbs,
          })
        : null;

    let segment: CommitAnalysis['segment'];
    let structuralMisses: CommitAnalysis['structuralMisses'] = [];
    let outcomeConfirmed: string[] = [];
    let simulatedSelected: number | null = null;

    if (!warmupDone) {
      // Leading full-suite before the first selective decision: warm-up —
      // segmented out of the rate AND the fallback frequency.
      segment = 'warm-up';
      warmupCommits++;
    } else if (!selective) {
      // Designed full-suite fallback: miss-exempt by definition (selection ⊇
      // all); reported as segmented fallback frequency, never in the rate.
      segment = 'fallback';
      const reason = decision.reason ?? 'unknown';
      fallbackFrequency[reason] = (fallbackFrequency[reason] ?? 0) + 1;
    } else {
      selectiveDecisions++;
      if (freshMap === null || changedRel === null) {
        segment = 'unmeasurable';
        unmeasurableCommits.push({
          sha: entry.sha,
          reason:
            freshMap === null
              ? 'missing graphs/<sha>.json (no ground-truth edge map)'
              : 'ledger entry lacks changedFiles',
        });
      } else {
        segment = 'selective';
        // Structural-join bookkeeping: a changed file that IS a key of the
        // fresh map actually joined the structural tier. Count this join (and
        // whether this selective commit had any changed files at all) for the
        // structural-join guard below — deliberately NOT keyed on misses>0,
        // which a broken join would make circular.
        if (changedAbs.length > 0) sawSelectiveChanges = true;
        for (const f of changedAbs) {
          if (freshMap.has(f)) structuralJoinMatches++;
        }
        // Simulated LIVE selection from the evolved (drifted) cache — the
        // recorded shadow selection was computed against a fully-fresh cache
        // (the harness full-runs every commit) and would erase the drift.
        // step is non-null here (freshMap !== null in this branch).
        const selection = (step as NonNullable<typeof step>).simulatedSelection;
        simulatedSelected = selection.size;
        structuralMisses = detectStructuralMisses({
          sha: entry.sha,
          changedFiles: changedAbs,
          freshMap,
          selection,
          outcomes,
        });
        // Join guard bookkeeping: count missed tests present in the outcomes.
        for (const miss of structuralMisses) {
          if (outcomes.has(miss.test)) outcomeJoinMatches++;
        }
        const flaky = flakyBySha.get(entry.sha) ?? new Set<string>();
        outcomeConfirmed = detectOutcomeConfirmed(
          structuralMisses,
          prevOutcomes,
          outcomes,
        ).filter((t) => !flaky.has(t)); // flake-guard: flakes are not flips
        if (structuralMisses.length > 0) {
          commitsWithStructuralMiss++;
          totalStructuralMisses += structuralMisses.length;
          for (const miss of structuralMisses) {
            for (const ch of miss.channels) {
              missesByChannel[ch] = (missesByChannel[ch] ?? 0) + 1;
            }
          }
        }
        if (outcomeConfirmed.length > 0) {
          commitsWithOutcomeConfirmedMiss++;
          totalOutcomeConfirmedMisses += outcomeConfirmed.length;
        }
      }
    }

    commits.push({
      sha: entry.sha,
      action: decision.action,
      ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
      segment,
      changedFiles: changedAbs.length,
      recordedSelected: decision.selectedFiles?.length ?? null,
      simulatedSelected,
      structuralMisses,
      outcomeConfirmed,
    });

    // Thread the evolved cache into the next commit (see evolution.ts for the
    // live-persistence scope rules).
    if (step !== null) cache = step.cacheAfter;
    // EMPTY-OUTCOME BASELINE (intentional skip — do NOT advance on empty):
    // prevOutcomes is the C-1 flip baseline fed to detectOutcomeConfirmed, and
    // it must hold the last-KNOWN per-test outcome, not merely the previous
    // commit's. An empty outcome map — whether a broken/errored commit that
    // produced no per-test outcomes OR a legitimate zero-test commit — is the
    // ABSENCE of an observation, not an observation that every test now lacks
    // an outcome. Overwriting the baseline with it would (a) erase flip
    // detection against the last real observation (every subsequent miss would
    // see prev===undefined → treated as "new") and (b) misclassify a
    // persistent failure as a brand-new failure. So carry the last non-empty
    // baseline across empty commits. detectOutcomeConfirmed already fail-safes
    // the OTHER direction: an empty CURRENT map yields cur===undefined and the
    // commit confirms nothing. Same rule mirrored at run.ts:~345 (live
    // flake-guard re-run baseline); pinned by the analyzeRun unit test.
    if (outcomes.size > 0) prevOutcomes = outcomes;
  }

  // OUTCOME-JOIN GUARD: structural misses exist but not a single missed test
  // was found in any commit's outcome map — the C-1→C join is likely
  // path-broken (normalization mismatch), so an outcome-confirmed tier of 0
  // must NOT be read as clean. Warn loudly in the report.
  const warnings: string[] = [];
  if (totalStructuralMisses > 0 && outcomeJoinMatches === 0) {
    warnings.push(
      'outcome tier may be broken — the C-1→C outcome path-join produced no ' +
        'matches across ALL commits despite structural misses; treat the ' +
        'outcome-confirmed miss-rate as unknown, not zero',
    );
  }

  // STRUCTURAL-JOIN GUARD: some selective commit had changed files, yet NOT a
  // single changed file joined the fresh ground-truth map as a key across the
  // WHOLE walk — the changed-file→graph path space is desynced (repo-relative
  // vs absolute, or a foreign root). computeRequiredTests then silently returns
  // empty for every commit, structuralMisses is empty, and the structural
  // miss-rate reads a vacuous 0. This is the STRUCTURAL sibling of the outcome
  // guard above, but its trigger is intentionally ASYMMETRIC: the outcome guard
  // keys on "misses > 0 && zero outcome joins", which is impossible here (a
  // broken structural join yields zero misses, making a misses-based trigger
  // circular). Key on sawSelectiveChanges instead.
  if (sawSelectiveChanges && structuralJoinMatches === 0) {
    warnings.push(
      'structural tier may be broken — the changed-file→graph path-join ' +
        'produced no matches across ALL selective commits; treat the ' +
        'structural miss-rate as unknown, not zero',
    );
  }

  const measurable = selectiveDecisions - unmeasurableCommits.length;
  return {
    runDir,
    totalCommits: entries.length,
    okCommits,
    selectiveDecisions,
    warmupCommits,
    unmeasurableCommits,
    structuralMissRate:
      measurable > 0 ? commitsWithStructuralMiss / measurable : null,
    outcomeConfirmedMissRate:
      measurable > 0 ? commitsWithOutcomeConfirmedMiss / measurable : null,
    commitsWithStructuralMiss,
    commitsWithOutcomeConfirmedMiss,
    totalStructuralMisses,
    totalOutcomeConfirmedMisses,
    missesByChannel,
    fallbackFrequency,
    brokenCommits,
    skippedCommits,
    commits,
    warnings,
  };
}

/**
 * Remap outcome test names into the canonical absolute path space the graph
 * keys live in. `path.resolve` against the canonical rootDir absolutizes
 * relative reporter names and normalizes already-absolute ones — mirroring
 * how the graphs' keys arrive (canonical paths under the realpath'd clone).
 */
function normalizeOutcomePaths(
  outcomes: Map<string, string>,
  rootDir: string,
): Map<string, string> {
  const normalized = new Map<string, string>();
  for (const [name, status] of outcomes) {
    normalized.set(path.resolve(rootDir, name), status);
  }
  return normalized;
}
