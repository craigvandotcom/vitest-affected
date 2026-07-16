/**
 * Report-path IO — renders and writes analysis.md, including the
 * degeneration-guard diagnosis path.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { renderReport } from './report.js';
import type { RunAnalysis } from './report.js';
import { NoSelectiveDecisionsError } from './detector.js';
import { analyzeRun } from './analyze.js';
import type { AnalyzeRunOptions } from './analyze.js';

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
