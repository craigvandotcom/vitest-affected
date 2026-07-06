#!/usr/bin/env node
// @ts-check
/**
 * Refresh the live miss-record badge from the consumer evidence log.
 *
 * The README carries a shields.io "endpoint" badge pointing at
 * _evidence/badge.json (raw.githubusercontent.com). Shields fetches that file
 * on every README view — GitHub AND npm — so the badge is live without ever
 * republishing. This script recomputes the aggregate and rewrites the JSON;
 * it runs at DEVELOPMENT time (pre-commit hook / release flow), so the badge
 * is "as of our last commit" by design — no CI cross-repo pushes, no badge
 * churn between working sessions.
 *
 * Evidence source: body-compass-app's git-tracked checkpoint log (one line per
 * full-CI-run divergence comparison, clean or divergent — see that repo's
 * scripts/ci/divergence-check.mjs). The sibling path only exists on machines
 * that host both repos; anywhere else this script exits 0 without touching
 * the badge (last committed value stands).
 *
 * Baseline: the replay harness measured 0 structural / 0 outcome-confirmed
 * misses across 12 selective decisions on 99 commits of real consumer history
 * (2026-07-05, vitest-affected _plans/research/2026-07-05-a4-walk/). Live
 * checkpoints accumulate on top of that baseline.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const badgePath = path.join(repoRoot, '_evidence', 'badge.json');
const logPath = path.resolve(
  repoRoot,
  '../body-compass-app/_ci-evidence/vitest-affected-divergence-log.jsonl'
);

const REPLAY_BASELINE = { misses: 0, selectiveDecisions: 12 };

let checkpoints = 0;
let liveSelective = 0;
let liveMisses = 0;

if (!existsSync(logPath)) {
  console.log(
    `[evidence-badge] no sibling evidence log at ${logPath} — leaving badge as committed.`
  );
  process.exit(0);
}

for (const raw of readFileSync(logPath, 'utf8').split('\n')) {
  const line = raw.trim();
  if (!line) continue;
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    continue;
  }
  checkpoints++;
  if (obj.decisionAction === 'shadow-selective') liveSelective++;
  if ((obj.missedFileCount ?? 0) > 0) liveMisses += obj.missedFileCount;
}

const totalMisses = REPLAY_BASELINE.misses + liveMisses;
const totalDecisions = REPLAY_BASELINE.selectiveDecisions + liveSelective;
const asOf = new Date().toISOString().slice(0, 10);

const badge = {
  schemaVersion: 1,
  label: 'measured miss record',
  message: `${totalMisses} misses · ${totalDecisions} selective decisions · ${checkpoints} live checkpoints (${asOf})`,
  color: totalMisses === 0 ? 'brightgreen' : 'red',
};

writeFileSync(badgePath, JSON.stringify(badge, null, 2) + '\n');
console.log(`[evidence-badge] ${badge.message} → ${badgePath}`);
