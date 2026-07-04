/**
 * Shared types for the replay harness (tools/replay).
 *
 * The harness replays a consumer repo's git history through the REAL plugin
 * (driven via the consumer's own vitest config) to measure the plugin's true
 * miss-rate. This module holds the vocabulary shared across walker / workdir /
 * exec / run — the source-of-truth for the per-commit ledger and the
 * fail-closed shadow-decision contract.
 */

/** Per-commit terminal status recorded in the run ledger. */
export type CommitStatus = 'ok' | 'skipped' | 'BROKEN';

/**
 * Classification of a single commit on the first-parent chain: whether it is
 * skipped (lockfile / config-touching) and, if so, which files triggered it.
 * `skipTriggers` is always itemized so skips are flagged in output, never
 * silently dropped.
 */
export interface CommitClassification {
  sha: string;
  /** Step-diff file list vs the commit's first parent (C-1 -> C). */
  changedFiles: string[];
  skip: boolean;
  /** Subset of changedFiles that triggered the skip (empty when skip=false). */
  skipTriggers: string[];
}

/**
 * The plugin's shadow every-exit-emission, parsed from a per-commit stats file.
 * `action` is remapped into the shadow namespace by the plugin; a
 * shadow-full-suite decision carries `selectedFiles: null` (meaning "all
 * tests"), while shadow-selective carries the would-be selection.
 */
export interface ShadowDecision {
  action: 'shadow-selective' | 'shadow-full-suite';
  selectedFiles: string[] | null;
  /** Original (pre-shadow) reason, retained by the plugin for segmentation. */
  reason?: string;
}

/** One line per commit in <run>/ledger.jsonl. */
export interface LedgerEntry {
  sha: string;
  status: CommitStatus;
  /** Human-readable reason (skip triggers, BROKEN cause, or 'ok'). */
  reason: string;
  timings: { totalMs: number };
  /** Present for status 'ok': the parsed shadow decision. */
  decision?: ShadowDecision;
  /**
   * Step-diff file list vs the commit's first parent (repo-relative). Recorded
   * so the analysis layer can compute the per-commit required-test set without
   * re-walking git — the run dir stays self-contained.
   */
  changedFiles?: string[];
}
