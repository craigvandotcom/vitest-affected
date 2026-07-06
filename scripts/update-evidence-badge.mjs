#!/usr/bin/env node
// @ts-check
/**
 * Regenerate the README hero card (_evidence/hero.svg) from the consumer
 * evidence log.
 *
 * The README embeds the SVG via raw.githubusercontent.com — fetched fresh on
 * every view (GitHub AND npm), so the card is live without republishing. This
 * script rewrites it at DEVELOPMENT time (pre-commit hook / release flow):
 * the numbers are "as of our last commit" by design — no CI cross-repo
 * pushes, no badge churn between working sessions.
 *
 * Evidence source: body-compass-app's git-tracked checkpoint log (one line
 * per full-CI-run divergence comparison, clean or divergent — see that repo's
 * scripts/ci/divergence-check.mjs). The sibling path only exists on machines
 * hosting both repos; anywhere else this script exits 0 without touching the
 * card (last committed value stands). `--seed` forces a baseline-only render.
 *
 * Baseline: the replay harness measured 0 structural / 0 outcome-confirmed
 * misses across 12 selective decisions on 99 commits of real consumer history
 * (2026-07-05, _plans/research/2026-07-05-a4-walk/). Live checkpoints
 * accumulate on top.
 *
 * Card design: self-surfaced dark card (identical on GitHub light/dark and
 * npm), system font stacks only (README <img> SVGs load no external
 * resources). Left: vitest-style runner line. Right: the affected-tests
 * story drawn literally — a ringed green root (the changed file) propagating
 * through green edges to the affected tests, inside a muted wider graph.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const heroPath = path.join(repoRoot, '_evidence', 'hero.svg');
const logPath = path.resolve(
  repoRoot,
  '../body-compass-app/_ci-evidence/vitest-affected-divergence-log.jsonl'
);

// Baseline is decision-shaped (see _plans/research/2026-07-05-a4-walk/analysis.md):
// 0 missed selective DECISIONS and 0 missed test FILES across 12 selective decisions.
const REPLAY_BASELINE = { missedDecisions: 0, missedFiles: 0, selectiveDecisions: 12 };
const seedMode = process.argv.includes('--seed');

let checkpoints = 0;
let liveSelective = 0; // count of shadow-selective DECISIONS
let liveMissedDecisions = 0; // shadow-selective decisions with >=1 missed file (0/1 per line)
let liveMissedFiles = 0; // total missed FILE count (kept for display, not the accuracy metric)

if (!seedMode) {
  if (!existsSync(logPath)) {
    console.log(
      `[evidence-hero] no sibling evidence log at ${logPath} — leaving hero.svg as committed.`
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
    // Miss accrual is guarded to shadow-selective lines EXACTLY as liveSelective
    // is: a shadow-full-suite line can never miss (divergence is structurally
    // impossible when the shadow ran the whole suite), so a stray missedFileCount
    // on one must not inflate the record with no matching verified increment.
    if (obj.decisionAction === 'shadow-selective') {
      liveSelective++;
      const missedFiles = (obj.missedFileCount ?? 0) > 0 ? obj.missedFileCount : 0;
      if (missedFiles > 0) {
        liveMissedDecisions++; // one missed DECISION, regardless of how many files
        liveMissedFiles += missedFiles; // aggregate missed-FILE count
      }
    }
  }
}

// Accuracy is DECISIONS-over-DECISIONS: missed selective decisions vs verified
// selective decisions (never files-over-decisions — that mixes units and can go
// negative). The total missed-FILE count is kept alongside for honest display.
const missedDecisions = REPLAY_BASELINE.missedDecisions + liveMissedDecisions;
const verified = REPLAY_BASELINE.selectiveDecisions + liveSelective;
const missedFiles = REPLAY_BASELINE.missedFiles + liveMissedFiles;
const asOf = new Date().toISOString().slice(0, 10);
const clean = missedDecisions === 0;

// Validated palette (dataviz reference): status good #0ca30c (5.19:1 on the
// dark card), serious #ec835a; text #ffffff / #c3c2b7 / #78776f on #1a1a19.
const accent = clean ? '#0ca30c' : '#ec835a';
const accentBright = clean ? '#17c817' : '#ec835a';
const mark = clean ? '✓' : '✗';
const verdict = clean ? 'PASS' : 'FAIL';
const rawPct =
  verified === 0 ? null : ((verified - missedDecisions) / verified) * 100;
// Clamp defensively: the rendered percentage can never fall outside [0, 100]
// regardless of malformed input.
const clampedPct = rawPct === null ? null : Math.min(100, Math.max(0, rawPct));
const pct =
  clampedPct === null
    ? '—'
    : `${clampedPct.toFixed(missedDecisions === 0 ? 0 : 1)}%`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="170" viewBox="0 0 720 170" role="img" aria-label="selection accuracy ${pct}, ${verdict}: ${missedDecisions} missed decisions across ${verified} verified selections">
  <defs>
    <clipPath id="card"><rect x="0" y="0" width="720" height="170" rx="12"/></clipPath>
  </defs>
  <rect x="0.5" y="0.5" width="719" height="169" rx="12" fill="#1a1a19" stroke="#ffffff21"/>
  <circle cx="26" cy="26" r="5" fill="#ffffff2e"/>
  <circle cx="44" cy="26" r="5" fill="#ffffff1f"/>
  <circle cx="62" cy="26" r="5" fill="#ffffff14"/>

  <g clip-path="url(#card)">
    <g stroke="#ffffff17" stroke-width="1.5" fill="none">
      <path d="M497 143 L471 100 M471 100 L505 62 M505 62 L472 24 M505 62 L553 20 M553 20 L607 34 M607 34 L648 12 M648 12 L700 26 M607 34 L586 66 M700 26 L706 74 M666 96 L706 74 M666 96 L697 132 M697 132 L649 154 M649 154 L597 140 M597 140 L560 158 M497 143 L540 122 M540 122 L597 140 M471 100 L540 122 M553 20 L586 66"/>
    </g>
    <g stroke="${accent}" stroke-opacity="0.75" stroke-width="2" fill="none">
      <path d="M540 122 L586 66 M586 66 L640 92 M640 92 L666 96 M586 66 L620 46"/>
    </g>
    <g fill="#26261f" stroke="#ffffff30" stroke-width="1.5">
      <circle cx="497" cy="143" r="6"/>
      <circle cx="471" cy="100" r="6"/>
      <circle cx="505" cy="62" r="6"/>
      <circle cx="472" cy="24" r="6"/>
      <circle cx="553" cy="20" r="6"/>
      <circle cx="607" cy="34" r="6"/>
      <circle cx="648" cy="12" r="6"/>
      <circle cx="700" cy="26" r="6"/>
      <circle cx="706" cy="74" r="6"/>
      <circle cx="697" cy="132" r="6"/>
      <circle cx="649" cy="154" r="6"/>
      <circle cx="597" cy="140" r="6"/>
      <circle cx="560" cy="158" r="6"/>
    </g>
    <circle cx="540" cy="122" r="8" fill="${accent}"/>
    <circle cx="540" cy="122" r="13" fill="none" stroke="${accent}59" stroke-width="2"/>
    <circle cx="586" cy="66" r="7" fill="${accent}"/>
    <circle cx="620" cy="46" r="7" fill="${accent}"/>
    <circle cx="640" cy="92" r="7" fill="${accent}"/>
    <circle cx="666" cy="96" r="7" fill="${accent}"/>
  </g>

  <g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace">
    <text x="32" y="86" font-size="21" fill="${accent}" font-weight="700">${mark}</text>
    <text x="58" y="86" font-size="19" fill="#c3c2b7">selection accuracy</text>
    <text x="292" y="86" font-size="21" fill="#ffffff" font-weight="700">${pct}</text>
    <rect x="372" y="68" width="64" height="26" rx="6" fill="${accent}26"/>
    <text x="404" y="86" font-size="15" fill="${accentBright}" font-weight="700" text-anchor="middle">${verdict}</text>

    <text x="58" y="116" font-size="15" fill="#c3c2b7">${missedDecisions} misses · ${verified} verified selections</text>
    <text x="58" y="142" font-size="12.5" fill="#78776f">replay-measured + live CI checkpoints · ${asOf}</text>
  </g>
</svg>
`;

writeFileSync(heroPath, svg);
console.log(
  `[evidence-hero] ${verdict} — ${missedDecisions} missed decision(s) (${missedFiles} missed file(s)) / ${verified} verified / ${checkpoints} live checkpoints (${asOf}) → ${heroPath}`
);
