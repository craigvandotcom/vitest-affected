/**
 * Analysis — turns a replay run's raw per-commit artifacts (A2a layout:
 * ledger.jsonl, stats/<sha>.jsonl, outcomes/<sha>.json, graphs/<sha>.json)
 * into an honest measurement. This module (with detector.ts) is the canonical
 * home of the denominator/exemption rules.
 *
 * MEASUREMENT MODEL
 * -----------------
 * Per ok commit C (in walk order):
 *   - freshMap_C  = graphs/<sha>.json — the ground-truth full runtime edge map
 *     captured at C (the harness ran the full suite). Used for the REQUIRED set.
 *   - cacheBefore_C = the simulated live selective cache (see evolution.ts) —
 *     what a live plugin would have LOADED at C. evolveStep yields both the
 *     SIMULATED live selection at C (detection input AND — for selective /
 *     cache-dependent decisions — the persistence scope; recorded
 *     selectedFiles are never fed back, preserving the drift feedback loop)
 *     and cacheAfter_C, which threads into C+1. The harness never writes the
 *     live repo's cache — this evolution exists only in analysis memory.
 *   - misses_C (shadow-selective commits only) = required(freshMap_C, changed)
 *     minus the simulated live selection at C.
 *
 * DENOMINATOR & EXEMPTIONS (the honesty rules)
 *   - Miss-rates are computed over shadow-selective decisions ONLY. Designed
 *     full-suite fallbacks (config-change, cache-miss, threshold-exceeded, and
 *     every other full-suite reason) are miss-exempt BY DEFINITION (selection
 *     ⊇ all) — they are reported as segmented fallback-frequency instead.
 *   - Leading warm-up commits (ok full-suite decisions before the FIRST
 *     selective decision) are segmented out of both the rate and the fallback
 *     frequency: a cold cache warming up is not a fallback event.
 *   - Selective commits with missing artifacts are UNMEASURABLE: listed
 *     loudly, excluded from the denominator — never silently counted clean.
 *   - DEGENERATION GUARD: zero selective decisions across the ENTIRE walk
 *     throws (surfaced on the report path → process exit) — a silent
 *     all-full-suite walk is list-only degeneration in disguise.
 *
 * IMPORT NOTE (load-bearing): mergeRuntimeEdges / ReverseMap come from the
 * BUILT package root ('../../dist/index.js') via evolution.ts — the same
 * artifact the replay harness ships against — never from src (importing src
 * would measure unbuilt code). Run `npm run build` if dist is stale/missing.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import type { ReverseMap } from '../../dist/index.js';
import type { LedgerEntry } from './types.js';
import { evolveStep } from './evolution.js';
import {
  detectStructuralMisses,
  detectOutcomeConfirmed,
  assertSelectiveDecisions,
  NoSelectiveDecisionsError,
} from './detector.js';
import { renderReport } from './report.js';
import type {
  RunAnalysis,
  CommitAnalysis,
  InventoriedCommit,
} from './report.js';

// ---------------------------------------------------------------------------
// Artifact parsing (tolerant — a corrupt artifact degrades to "unmeasurable",
// never to a crash or a silently-clean commit)
// ---------------------------------------------------------------------------

/**
 * Parse a captured graph.json into a ReverseMap; empty map on any drift.
 * Version-aware: v2 stores ABSOLUTE canonical paths (passed through as-is);
 * v3 stores rootDir-RELATIVE paths (absolutized here against the clone's
 * rootDir, forward-slashed) — the whole analysis pipeline operates in
 * absolute canonical space, so relativity must not leak past this boundary.
 * Unknown versions degrade to an empty map (the commit becomes unmeasurable,
 * loudly — never silently clean).
 */
export function parseGraphReverseMap(content: string, rootDir?: string): ReverseMap {
  const map: ReverseMap = new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return map;
  }
  if (parsed === null || typeof parsed !== 'object') return map;
  const obj = parsed as Record<string, unknown>;
  const version = obj.version;
  if (version !== 2 && version !== 3) return map;
  if (version === 3 && !rootDir) return map; // relative paths need a base
  const abs = (p: string): string =>
    version === 3 ? `${rootDir!.replace(/\/+$/, '')}/${p}` : p;
  const raw = obj.reverseMap;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return map;
  for (const [file, tests] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(tests)) continue;
    const set = new Set<string>();
    for (const t of tests) {
      if (typeof t === 'string') set.add(abs(t));
    }
    if (set.size > 0) map.set(abs(file), set);
  }
  return map;
}

/**
 * Parse a captured vitest `--reporter=json` stdout into test-file → status
 * ('passed' / 'failed' / ...). Empty map when the run crashed pre-JSON.
 */
export function parseOutcomes(content: string): Map<string, string> {
  const outcomes = new Map<string, string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return outcomes;
  }
  if (parsed === null || typeof parsed !== 'object') return outcomes;
  const results = (parsed as Record<string, unknown>).testResults;
  if (!Array.isArray(results)) return outcomes;
  for (const r of results) {
    if (r === null || typeof r !== 'object') continue;
    const { name, status } = r as Record<string, unknown>;
    if (typeof name === 'string' && typeof status === 'string') {
      outcomes.set(name, status);
    }
  }
  return outcomes;
}

/** Parse ledger.jsonl into entries (malformed lines dropped, never fatal). */
export function parseLedger(content: string): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== 'object') continue;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.sha !== 'string' || typeof obj.status !== 'string') continue;
    entries.push(obj as unknown as LedgerEntry);
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Flake guard
// ---------------------------------------------------------------------------

export interface FlakeCheckResult {
  sha: string;
  /** Tests newly failing at C (not failing at C-1). */
  newFailures: string[];
  /** New failures that still failed on the plugin-disabled re-run. */
  confirmed: string[];
  /** New failures that passed on the re-run — flakes, not real flips. */
  flaky: string[];
  /** Whether a re-run was actually spawned. */
  reran: boolean;
  /** True when this commit established the baseline (no prior outcomes). */
  baseline: boolean;
}

/**
 * Flake guard: when a commit introduces NEW failures (failed at C, not failed
 * at C-1), re-run ONCE via `rerun` and split confirmed failures from flakes.
 * The re-runner is injected so tests never spawn vitest; production wiring
 * uses `spawnDisabledRerun` (plugin fully inert → no cache/stats side
 * effects). No new failures → no re-run at all.
 *
 * BASELINE RULE: `prevOutcomes === null` marks the FIRST measurable commit —
 * there is nothing to compare against, so every failure would spuriously look
 * "new" (spurious re-runs, and a baseline-broken test could get laundered
 * into 'flaky'). No re-run; the commit's outcomes simply become the baseline.
 */
export async function flakeCheckCommit(
  sha: string,
  prevOutcomes: ReadonlyMap<string, string> | null,
  curOutcomes: ReadonlyMap<string, string>,
  rerun: () => Promise<Map<string, string>>,
): Promise<FlakeCheckResult> {
  if (prevOutcomes === null) {
    return {
      sha,
      newFailures: [],
      confirmed: [],
      flaky: [],
      reran: false,
      baseline: true,
    };
  }
  const newFailures: string[] = [];
  for (const [test, status] of curOutcomes) {
    if (status !== 'failed') continue;
    if (prevOutcomes.get(test) === 'failed') continue; // already failing
    newFailures.push(test);
  }
  newFailures.sort();
  if (newFailures.length === 0) {
    return {
      sha,
      newFailures,
      confirmed: [],
      flaky: [],
      reran: false,
      baseline: false,
    };
  }
  const rerunOutcomes = await rerun();
  const confirmed: string[] = [];
  const flaky: string[] = [];
  for (const test of newFailures) {
    // Absent from the re-run (e.g. renamed mid-flight) counts as confirmed —
    // fail-closed: never launder a failure into a flake without evidence.
    if (rerunOutcomes.get(test) === 'passed') flaky.push(test);
    else confirmed.push(test);
  }
  return { sha, newFailures, confirmed, flaky, reran: true, baseline: false };
}

/**
 * Production re-runner: spawn the consumer suite exactly like exec.ts does,
 * but with VITEST_AFFECTED_DISABLED=1 — the plugin's kill-switch makes it
 * fully inert (no include mutation, no reporter, no cache write, no stats
 * emission), so the re-run has zero side effects on the walk's artifacts.
 */
export async function spawnDisabledRerun(
  cloneDir: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<Map<string, string>> {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  delete env.CI;
  delete env.GITHUB_ACTIONS;
  delete env.VITEST_AFFECTED_SHADOW;
  delete env.VITEST_AFFECTED_STATS_FILE;
  env.VITEST_AFFECTED_DISABLED = '1';
  const result = await execa('npx', ['vitest', 'run', '--reporter=json'], {
    cwd: cloneDir,
    env,
    reject: false,
    // Same trap as runCommit (see exec.ts): execa's default extendEnv re-merges
    // the parent process.env, re-introducing the CI / GITHUB_ACTIONS keys
    // deleted above — an inherited CI=1 would enable retry masking in exactly
    // the re-run whose job is to confirm a failure. The env above is a full
    // copy of the base env, so PATH etc. carry through.
    extendEnv: false,
  });
  return parseOutcomes(result.stdout);
}

/** One flake-log.jsonl line, written by run.ts whenever a re-run happened. */
export interface FlakeLogEntry {
  sha: string;
  newFailures: string[];
  confirmed: string[];
  flaky: string[];
}

/** Load flake-log.jsonl → sha → set of known-flaky tests at that commit. */
async function loadFlakyBySha(runDir: string): Promise<Map<string, Set<string>>> {
  const flaky = new Map<string, Set<string>>();
  const logPath = path.join(runDir, 'flake-log.jsonl');
  if (!existsSync(logPath)) return flaky;
  const content = await readFile(logPath, 'utf-8');
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== 'object') continue;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.sha !== 'string' || !Array.isArray(obj.flaky)) continue;
    flaky.set(
      obj.sha,
      new Set(obj.flaky.filter((t): t is string => typeof t === 'string')),
    );
  }
  return flaky;
}

// ---------------------------------------------------------------------------
// Run analysis
// ---------------------------------------------------------------------------

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

/** Render + write <runDir>/analysis.md; returns the report path. */
export async function writeReport(
  runDir: string,
  analysis: RunAnalysis,
): Promise<string> {
  const reportPath = path.join(runDir, 'analysis.md');
  await writeFile(reportPath, renderReport(analysis), 'utf-8');
  return reportPath;
}

/**
 * Degeneration diagnosis report — written into the run dir when the
 * degeneration guard trips, so the expensive walk data stays diagnosable
 * without a re-walk. Returns the report path.
 */
export async function writeDegenerationReport(
  runDir: string,
  err: NoSelectiveDecisionsError,
): Promise<string> {
  const lines: string[] = [
    '# Replay analysis — DEGENERATE RUN (no measurement)',
    '',
    `**${err.message}**`,
    '',
    '## Decision segmentation (why every commit was full-suite)',
    '',
    '| segment | count |',
    '| --- | --- |',
  ];
  for (const key of Object.keys(err.segmentation).sort()) {
    lines.push(`| ${key} | ${err.segmentation[key]} |`);
  }
  lines.push(
    '',
    'Fix the cause (see segmentation reasons above), then re-analyze without',
    're-walking: `npx tsx tools/replay/run.ts --analyze-only <runDir>`.',
    '',
  );
  const reportPath = path.join(runDir, 'analysis.md');
  await writeFile(reportPath, lines.join('\n'), 'utf-8');
  return reportPath;
}

/**
 * The report-path entry: analyze and write analysis.md. On degeneration the
 * DIAGNOSIS is still written into the run dir before the error is rethrown
 * (the CLI then exits non-zero) — failing loudly must not mean failing
 * blindly. Returns the report path.
 */
export async function analyzeAndReport(
  opts: AnalyzeRunOptions,
): Promise<string> {
  let analysis: RunAnalysis;
  try {
    analysis = await analyzeRun(opts);
  } catch (err) {
    if (err instanceof NoSelectiveDecisionsError) {
      await writeDegenerationReport(opts.runDir, err);
    }
    throw err;
  }
  return writeReport(opts.runDir, analysis);
}

// Re-export the guard error so run.ts (and tests) reach it via one module.
export { NoSelectiveDecisionsError } from './detector.js';
