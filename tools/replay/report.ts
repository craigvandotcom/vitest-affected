/**
 * Report — markdown rendering of a run analysis (gate essentials ONLY).
 *
 * What belongs here: the two labeled miss-rate tiers, misses by channel,
 * fallback-frequency segmentation, warm-up/unmeasurable segmentation, and the
 * BROKEN/skipped commit inventories. Selection-ratio and trigger distributions
 * belong to Tier 0 analysis, NOT here.
 *
 * HONESTY RULE: a bare "miss-rate" is never rendered — both tiers are always
 * labeled (structural = primary; outcome-confirmed = severity subset), and the
 * denominator (measurable shadow-selective decisions) is stated inline.
 */
import type { StructuralMiss } from './detector.js';

/** One inventoried commit (BROKEN or skipped). */
export interface InventoriedCommit {
  sha: string;
  reason: string;
}

/** Per-commit analysis detail (rendered only for commits with misses). */
export interface CommitAnalysis {
  sha: string;
  action: 'shadow-selective' | 'shadow-full-suite';
  reason?: string;
  /** Which measurement segment the commit landed in. */
  segment: 'warm-up' | 'selective' | 'fallback' | 'unmeasurable';
  changedFiles: number;
  /** Size of the plugin's recorded shadow selection (null = full suite). */
  recordedSelected: number | null;
  /** Size of the simulated live selection from the evolved cache (null = n/a). */
  simulatedSelected: number | null;
  structuralMisses: StructuralMiss[];
  /** Subset of structural misses confirmed by an outcome change C-1 → C. */
  outcomeConfirmed: string[];
}

/** The full analysis result — the contract between analysis.ts and this file. */
export interface RunAnalysis {
  runDir: string;
  totalCommits: number;
  okCommits: number;
  /** Recorded shadow-selective decisions (the miss-rate population). */
  selectiveDecisions: number;
  /** Leading ok full-suite commits before the first selective decision. */
  warmupCommits: number;
  /** Selective commits that could not be measured (missing artifacts). */
  unmeasurableCommits: InventoriedCommit[];
  /** commitsWithStructuralMiss / measurable selective decisions (null if 0). */
  structuralMissRate: number | null;
  /** commitsWithOutcomeConfirmedMiss / same denominator (null if 0). */
  outcomeConfirmedMissRate: number | null;
  commitsWithStructuralMiss: number;
  commitsWithOutcomeConfirmedMiss: number;
  totalStructuralMisses: number;
  totalOutcomeConfirmedMisses: number;
  /** Missed-test count per changed-file channel (see classifyChannel). */
  missesByChannel: Record<string, number>;
  /** Mid-walk designed full-suite fallbacks, segmented by original reason. */
  fallbackFrequency: Record<string, number>;
  brokenCommits: InventoriedCommit[];
  skippedCommits: InventoriedCommit[];
  commits: CommitAnalysis[];
  /**
   * Measurement-integrity warnings (e.g. the outcome-join guard: structural
   * misses exist but the C-1→C outcome join matched nothing — the
   * outcome-confirmed tier may be broken, not genuinely zero).
   */
  warnings: string[];
}

function pct(rate: number | null): string {
  if (rate === null) return 'n/a (empty denominator)';
  return `${(rate * 100).toFixed(1)}%`;
}

function renderCountTable(
  counts: Record<string, number>,
  keyHeader: string,
): string[] {
  const keys = Object.keys(counts).sort();
  if (keys.length === 0) return ['_none_', ''];
  const lines = [`| ${keyHeader} | count |`, '| --- | --- |'];
  for (const k of keys) lines.push(`| ${k} | ${counts[k]} |`);
  lines.push('');
  return lines;
}

function renderInventory(commits: readonly InventoriedCommit[]): string[] {
  if (commits.length === 0) return ['_none_', ''];
  const lines: string[] = [];
  for (const c of commits) lines.push(`- \`${c.sha}\` — ${c.reason}`);
  lines.push('');
  return lines;
}

/** Render the analysis as markdown. Pure — no filesystem access. */
export function renderReport(analysis: RunAnalysis): string {
  const measurable =
    analysis.selectiveDecisions - analysis.unmeasurableCommits.length;
  const lines: string[] = [
    '# Replay analysis',
    '',
    `Run dir: \`${analysis.runDir}\``,
    '',
    ...(analysis.warnings.length > 0
      ? [
          '## ⚠ Warnings (measurement integrity)',
          '',
          ...analysis.warnings.map((w) => `- **${w}**`),
          '',
        ]
      : []),
    '## Denominator',
    '',
    `- Commits walked: ${analysis.totalCommits} (ok: ${analysis.okCommits}, ` +
      `skipped: ${analysis.skippedCommits.length}, BROKEN: ${analysis.brokenCommits.length})`,
    `- Warm-up commits (leading full-suite before the first selective decision, ` +
      `segmented out of every rate): ${analysis.warmupCommits}`,
    `- Shadow-selective decisions (the miss-rate population): ${analysis.selectiveDecisions}`,
    `- Unmeasurable selective commits (missing artifacts, excluded from the ` +
      `denominator, listed below): ${analysis.unmeasurableCommits.length}`,
    `- Measurable denominator: ${measurable}`,
    '',
    '## Miss-rates (both tiers — never a bare rate)',
    '',
    `- **Structural miss-rate** (primary): ${pct(analysis.structuralMissRate)} ` +
      `— ${analysis.commitsWithStructuralMiss}/${measurable} selective commit(s) ` +
      `with ≥1 required-but-unselected test (${analysis.totalStructuralMisses} ` +
      `missed test(s) total)`,
    `- **Outcome-confirmed miss-rate** (severity subset of structural): ` +
      `${pct(analysis.outcomeConfirmedMissRate)} — ` +
      `${analysis.commitsWithOutcomeConfirmedMiss}/${measurable} selective ` +
      `commit(s) whose missed test(s) actually changed outcome C-1 → C ` +
      `(${analysis.totalOutcomeConfirmedMisses} test(s) total)`,
    '',
    'Structural is a superset: under-selections whose skipped tests still pass',
    'are real coverage gaps that outcome-flip detection alone would miss.',
    '',
    '## Misses by channel (changed-file kind that produced the miss)',
    '',
    ...renderCountTable(analysis.missesByChannel, 'channel'),
    '## Fallback frequency (designed full-suite fallbacks — miss-exempt by definition)',
    '',
    ...renderCountTable(analysis.fallbackFrequency, 'reason'),
    '## Unmeasurable selective commits',
    '',
    ...renderInventory(analysis.unmeasurableCommits),
    '## BROKEN commits',
    '',
    ...renderInventory(analysis.brokenCommits),
    '## Skipped commits',
    '',
    ...renderInventory(analysis.skippedCommits),
  ];

  const missCommits = analysis.commits.filter(
    (c) => c.structuralMisses.length > 0,
  );
  if (missCommits.length > 0) {
    lines.push('## Miss detail (per commit)', '');
    for (const c of missCommits) {
      lines.push(
        `### \`${c.sha}\` — ${c.changedFiles} changed file(s), ` +
          `recorded selection ${c.recordedSelected ?? 'full'}, ` +
          `simulated live selection ${c.simulatedSelected ?? 'n/a'}`,
        '',
      );
      for (const m of c.structuralMisses) {
        const confirmed = c.outcomeConfirmed.includes(m.test)
          ? ' **[outcome-confirmed]**'
          : '';
        lines.push(
          `- \`${m.test}\`${confirmed} — caused by ${m.causingFiles
            .map((f) => `\`${f}\``)
            .join(', ')} (channel: ${m.channels.join(', ')})`,
        );
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}
