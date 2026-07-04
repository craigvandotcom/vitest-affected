/**
 * Detector — the two-tier miss detector, channel classification, and the
 * degeneration guard. This module is the canonical home of the measurement's
 * honesty rules alongside analysis.ts (denominator/exemptions).
 *
 * WHY TWO TIERS (trap #2): outcome-flip-only detection is a LOWER BOUND — an
 * under-selection whose skipped tests happen to still pass is a real coverage
 * gap that flip-detection never sees. So:
 *
 *  - STRUCTURAL (primary): any test whose fresh runtime import set at C
 *    intersects the changed files (per the ground-truth map captured at C) but
 *    which the shadow selection did NOT include. File-path identity; because
 *    the structural set is computed fresh at C, added/renamed tests are handled
 *    naturally (they appear in C's fresh map or they don't).
 *  - OUTCOME-CONFIRMED (severity subset): the structural misses whose pass/fail
 *    outcome actually changed C-1 → C.
 *
 * Reports must ALWAYS label both tiers — never a bare "miss-rate".
 */
import path from 'node:path';
import type { ReverseMap } from '../../dist/index.js';
import type { LedgerEntry } from './types.js';

// ---------------------------------------------------------------------------
// Required set + structural misses
// ---------------------------------------------------------------------------

/**
 * The set of tests the ground-truth map at C says depend on any changed file —
 * i.e. what a perfect selector would have run. Changed files absent from the
 * map contribute nothing (no runtime consumer observed).
 */
export function computeRequiredTests(
  freshMap: ReverseMap,
  changedFiles: readonly string[],
): Set<string> {
  const required = new Set<string>();
  for (const file of changedFiles) {
    const tests = freshMap.get(file);
    if (!tests) continue;
    for (const t of tests) required.add(t);
  }
  return required;
}

/**
 * The selection a LIVE selective run at C would make, simulated from the
 * reconstructed (drifted) cache — NOT from the recorded shadow decision.
 *
 * WHY NOT the recorded selection (trap #1, concretely): the harness runs the
 * full suite at every commit, and the plugin's reporter persists the clone's
 * cache with scope 'all' after each run — so the shadow selection the plugin
 * RECORDED at C was computed against a fully-fresh cache from C-1's full run.
 * A live deployment's cache drifts (unselected tests keep stale edges); using
 * the recorded selection would erase exactly that drift. The evolved
 * `cacheBefore` restores it.
 *
 * Mechanics: the runtime reverse map is already transitive (source → every
 * test that loaded it), so selection = union of cacheBefore[changedFile].
 * Plus self-selection: a changed file that is itself a test file is always
 * selected by the live plugin (BFS seeds include changed files), so changed
 * members of `testFiles` (test-ness per the fresh ground truth at C — handles
 * tests added this commit) join the selection even when absent from the stale
 * cache.
 */
export function simulateLiveSelection(
  cacheBefore: ReverseMap,
  changedFiles: readonly string[],
  testFiles: ReadonlySet<string>,
): Set<string> {
  const selection = computeRequiredTests(cacheBefore, changedFiles);
  for (const f of changedFiles) {
    if (testFiles.has(f)) selection.add(f);
  }
  return selection;
}

/** All test files observed in a runtime reverse map (the value space). */
export function testsOf(map: ReverseMap): Set<string> {
  const tests = new Set<string>();
  for (const s of map.values()) {
    for (const t of s) tests.add(t);
  }
  return tests;
}

/** A single structurally-missed test at one commit. */
export interface StructuralMiss {
  /** The test file the selection should have included but did not. */
  test: string;
  /** The changed files whose fresh edges reach this test. */
  causingFiles: string[];
  /** Deduped channels of the causing files (see classifyChannel). */
  channels: string[];
}

export interface DetectMissesInput {
  sha: string;
  /** Step-diff changed files at C (same path space as the fresh map). */
  changedFiles: readonly string[];
  /** Ground-truth full runtime map captured at C. */
  freshMap: ReverseMap;
  /** Shadow selection at C; null means full suite (selection ⊇ all). */
  selection: ReadonlySet<string> | null;
  /** Per-test outcomes at C (unused here; part of the shared commit shape). */
  outcomes: ReadonlyMap<string, string>;
}

/**
 * Structural (primary) miss detection: required-but-unselected tests, each
 * annotated with the changed files that caused the requirement and their
 * channels. A null selection (full suite) can never miss by definition.
 */
export function detectStructuralMisses(
  input: DetectMissesInput,
): StructuralMiss[] {
  const { changedFiles, freshMap, selection } = input;
  if (selection === null) return [];
  const required = computeRequiredTests(freshMap, changedFiles);
  const misses: StructuralMiss[] = [];
  for (const test of [...required].sort()) {
    if (selection.has(test)) continue;
    const causingFiles = changedFiles
      .filter((f) => freshMap.get(f)?.has(test) ?? false)
      .sort();
    const channels = [...new Set(causingFiles.map(classifyChannel))].sort();
    misses.push({ test, causingFiles, channels });
  }
  return misses;
}

/**
 * Outcome-confirmed (severity subset): structural misses whose pass/fail
 * outcome actually changed C-1 → C. A missed test absent at C-1 (added this
 * commit) whose outcome at C is a failure also counts — there was no prior
 * "same" outcome to compare against, and a skipped new failure is the severest
 * form of miss.
 */
export function detectOutcomeConfirmed(
  structural: readonly StructuralMiss[],
  prevOutcomes: ReadonlyMap<string, string>,
  curOutcomes: ReadonlyMap<string, string>,
): string[] {
  const confirmed: string[] = [];
  for (const miss of structural) {
    const cur = curOutcomes.get(miss.test);
    if (cur === undefined) continue; // no outcome data at C — cannot confirm
    const prev = prevOutcomes.get(miss.test);
    if (prev === undefined) {
      // New test: confirmed only if it fails (a passing new test's outcome
      // carries no severity signal).
      if (cur === 'failed') confirmed.push(miss.test);
      continue;
    }
    if (prev !== cur) confirmed.push(miss.test);
  }
  return confirmed;
}

// ---------------------------------------------------------------------------
// Channel classification
// ---------------------------------------------------------------------------

/**
 * Classify a changed file into a coarse "channel" — which kind of file
 * produced a miss. Test files (by conventional .test./.spec. infix) classify
 * as 'test' regardless of extension; everything else classifies by extension.
 * Deliberately coarse: the report only needs miss-by-kind segmentation.
 */
export function classifyChannel(file: string): string {
  const base = path.posix.basename(file.replace(/\\/g, '/'));
  if (/\.(test|spec)\.[a-z]+$/i.test(base)) return 'test';
  const ext = path.posix.extname(base).slice(1).toLowerCase();
  switch (ext) {
    case 'ts':
    case 'mts':
    case 'cts':
      return 'ts';
    case 'tsx':
      return 'tsx';
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'js';
    case 'jsx':
      return 'jsx';
    case 'css':
    case 'scss':
    case 'sass':
    case 'less':
      return 'style';
    case 'json':
      return 'json';
    case 'md':
    case 'mdx':
      return 'md';
    case '':
      return 'other';
    default:
      return ext;
  }
}

// ---------------------------------------------------------------------------
// Degeneration guard
// ---------------------------------------------------------------------------

/**
 * Thrown when an entire walk contains ZERO shadow-selective decisions. A
 * silent all-full-suite walk is list-only degeneration in disguise — every
 * commit is miss-exempt, the miss-rate is vacuously 0, and the per-commit
 * BROKEN guard cannot catch it. The run must fail loudly instead.
 */
export class NoSelectiveDecisionsError extends Error {
  constructor(okCommits: number) {
    super(
      `degeneration guard: 0 shadow-selective decisions across ${okCommits} ` +
        'ok commit(s) — an all-full-suite walk measures nothing (list-only ' +
        'degeneration in disguise); a miss-rate over an empty denominator ' +
        'would be vacuously clean',
    );
    this.name = 'NoSelectiveDecisionsError';
  }
}

/** Count ok commits whose shadow decision was selective. */
export function countSelectiveDecisions(
  entries: readonly LedgerEntry[],
): number {
  let n = 0;
  for (const e of entries) {
    if (e.status === 'ok' && e.decision?.action === 'shadow-selective') n++;
  }
  return n;
}

/**
 * Fail the run loudly when the walk produced zero selective decisions.
 * Callers surface the thrown error on the report path (process exit).
 */
export function assertSelectiveDecisions(
  entries: readonly LedgerEntry[],
): void {
  if (countSelectiveDecisions(entries) > 0) return;
  const okCommits = entries.filter((e) => e.status === 'ok').length;
  throw new NoSelectiveDecisionsError(okCommits);
}
