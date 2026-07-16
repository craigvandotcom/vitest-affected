/// <reference types="vitest/config" />
import { describe, test, expect, afterEach } from 'vitest';
import path from 'node:path';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  realpathSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';

import type { ReverseMap } from '../dist/internal.js';
import type { LedgerEntry, ShadowDecision } from '../tools/replay/types.js';
import {
  evolutionScope,
  reconstructCacheEvolution,
} from '../tools/replay/evolution.js';
import {
  computeRequiredTests,
  simulateLiveSelection,
  testsOf,
  detectStructuralMisses,
  detectOutcomeConfirmed,
  classifyChannel,
  countSelectiveDecisions,
  assertSelectiveDecisions,
  NoSelectiveDecisionsError,
} from '../tools/replay/detector.js';
import {
  parseGraphReverseMap,
  parseOutcomes,
  analyzeRun,
  analyzeAndReport,
  writeReport,
  flakeCheckCommit,
} from '../tools/replay/analysis.js';
import { renderReport } from '../tools/replay/report.js';
import { parseArgs } from '../tools/replay/run.js';

// ---------------------------------------------------------------------------
// Temp-dir bookkeeping (mirrors replay-core.test.ts).
// ---------------------------------------------------------------------------
const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
  tempDirs.length = 0;
});

function tmp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

/** Build a ReverseMap (source → tests) from a plain object. */
function rm(obj: Record<string, string[]>): ReverseMap {
  const m: ReverseMap = new Map();
  for (const [file, tests] of Object.entries(obj)) {
    m.set(file, new Set(tests));
  }
  return m;
}

/** Sorted members of a map entry (or [] if absent) for stable assertions. */
function edges(map: ReverseMap, file: string): string[] {
  return [...(map.get(file) ?? [])].sort();
}

function selective(selectedFiles: string[], reason?: string): ShadowDecision {
  const d: ShadowDecision = { action: 'shadow-selective', selectedFiles };
  if (reason !== undefined) d.reason = reason;
  return d;
}

function fullSuite(reason: string): ShadowDecision {
  return { action: 'shadow-full-suite', selectedFiles: null, reason };
}

// ===========================================================================
// evolution — simulated selective cache reconstruction
// ===========================================================================
describe('evolution: evolutionScope', () => {
  test('shadow-selective → the SIMULATED selection, never the recorded set', () => {
    // Recorded selection says a+b; the drifted-cache simulation says only a.
    const sim = new Set(['t/a.test.ts']);
    const scope = evolutionScope(
      selective(['t/a.test.ts', 't/b.test.ts']),
      sim,
    );
    expect(scope).toBeInstanceOf(Set);
    expect([...(scope as Set<string>)]).toEqual(['t/a.test.ts']);
  });

  test('cache-INDEPENDENT full-suite reason → "all" (live would also full-suite)', () => {
    expect(
      evolutionScope(fullSuite('config-change'), new Set(['t/a.test.ts'])),
    ).toBe('all');
    expect(evolutionScope(fullSuite('no-changes'), new Set())).toBe('all');
    expect(evolutionScope(fullSuite('full-suite-trigger'), new Set())).toBe(
      'all',
    );
    // Round-2 additions — real reasons emitStats() emits that were previously
    // (wrongly) defaulting to cache-dependent. Pin the newly-classified ones so
    // a regression in the set re-introduces the pessimistic drift bias.
    expect(
      evolutionScope(
        fullSuite('no-include-patterns'),
        new Set(['t/a.test.ts']),
      ),
    ).toBe('all');
    expect(
      evolutionScope(fullSuite('no-test-files'), new Set(['t/a.test.ts'])),
    ).toBe('all');
    expect(
      evolutionScope(
        fullSuite('import-durations-shape'),
        new Set(['t/a.test.ts']),
      ),
    ).toBe('all');
    expect(
      evolutionScope(fullSuite('error'), new Set(['t/a.test.ts'])),
    ).toBe('all');
  });

  test('cache-DEPENDENT full-suite reason → simulated selection (live would have been selective)', () => {
    const sim = new Set(['t/a.test.ts']);
    const miss = evolutionScope(fullSuite('cache-miss'), sim);
    expect([...(miss as Set<string>)]).toEqual(['t/a.test.ts']);
    const threshold = evolutionScope(fullSuite('threshold-exceeded'), sim);
    expect([...(threshold as Set<string>)]).toEqual(['t/a.test.ts']);
    // Unlisted reasons default to cache-dependent (never optimistically
    // refresh the drifted cache).
    const unknown = evolutionScope(fullSuite('some-future-reason'), sim);
    expect([...(unknown as Set<string>)]).toEqual(['t/a.test.ts']);
  });

  test('EMPTY simulated selection → "all" (live no-affected-tests fallback self-heals)', () => {
    expect(evolutionScope(selective(['t/x.test.ts']), new Set())).toBe('all');
    expect(evolutionScope(fullSuite('no-affected-tests'), new Set())).toBe(
      'all',
    );
  });
});

describe('evolution: reconstructCacheEvolution (drives real mergeRuntimeEdges)', () => {
  test('selective evolution persists the SIMULATED selection, preserving prior edges for unselected tests', () => {
    // Warm start: testA on x.ts, testB on y.ts.
    const initial = rm({
      '/r/src/x.ts': ['/r/t/a.test.ts'],
      '/r/src/y.ts': ['/r/t/b.test.ts'],
    });

    // C1 changes y.ts → simulated selection = {testB}. Fresh ground truth
    // says testB now ALSO depends on z.ts. testA was not selected: its stale
    // edge must survive untouched.
    const steps = reconstructCacheEvolution(
      [
        {
          sha: 'c1',
          freshMap: rm({
            '/r/src/y.ts': ['/r/t/b.test.ts'],
            '/r/src/z.ts': ['/r/t/b.test.ts'],
          }),
          decision: selective(['/r/t/b.test.ts']),
          changedFiles: ['/r/src/y.ts'],
        },
      ],
      initial,
    );

    expect(steps).toHaveLength(1);
    expect([...steps[0].simulatedSelection]).toEqual(['/r/t/b.test.ts']);
    const after = steps[0].cacheAfter;
    // Preserved: testA's edge on x.ts (unselected → untouched).
    expect(edges(after, '/r/src/x.ts')).toEqual(['/r/t/a.test.ts']);
    // Refreshed: testB's edges (y.ts kept, z.ts learned).
    expect(edges(after, '/r/src/y.ts')).toEqual(['/r/t/b.test.ts']);
    expect(edges(after, '/r/src/z.ts')).toEqual(['/r/t/b.test.ts']);
    // cacheBefore is the pre-run snapshot (== initial).
    expect(steps[0].cacheBefore.has('/r/src/z.ts')).toBe(false);
  });

  test('cache-independent full-suite replaces edges for every test present in fresh', () => {
    // Stale: testA on x.ts (an edge that no longer exists at ground truth).
    const initial = rm({ '/r/src/x.ts': ['/r/t/a.test.ts'] });

    // config-change (cache-independent) → live also full-suites → scope 'all'
    // overwrites testA's edges with the fresh truth (z.ts, not x.ts).
    const steps = reconstructCacheEvolution(
      [
        {
          sha: 'c1',
          freshMap: rm({ '/r/src/z.ts': ['/r/t/a.test.ts'] }),
          decision: fullSuite('config-change'),
          changedFiles: [],
        },
      ],
      initial,
    );

    const after = steps[0].cacheAfter;
    expect(after.has('/r/src/x.ts')).toBe(false);
    expect(edges(after, '/r/src/z.ts')).toEqual(['/r/t/a.test.ts']);
  });

  test('cold cache (commit #1) warms with "all" regardless of the recorded decision', () => {
    // Even a changed test file (which self-selects into a non-empty simulated
    // set) cannot make a COLD live plugin selective — no cache file exists.
    const steps = reconstructCacheEvolution([
      {
        sha: 'c1',
        freshMap: rm({
          '/r/src/a.ts': ['/r/t/a.test.ts'],
          '/r/t/n.test.ts': ['/r/t/n.test.ts'],
        }),
        decision: selective(['/r/t/n.test.ts']),
        changedFiles: ['/r/t/n.test.ts'],
      },
    ]);
    expect(steps[0].scope).toBe('all');
    // The whole fresh map warmed in.
    expect(edges(steps[0].cacheAfter, '/r/src/a.ts')).toEqual([
      '/r/t/a.test.ts',
    ]);
    expect(edges(steps[0].cacheAfter, '/r/t/n.test.ts')).toEqual([
      '/r/t/n.test.ts',
    ]);
  });

  test('threads cacheAfter of C into cacheBefore of C+1 and scopes C+1 by ITS simulation', () => {
    const steps = reconstructCacheEvolution([
      {
        sha: 'c1',
        freshMap: rm({ '/r/src/a.ts': ['/r/t/a.test.ts'] }),
        decision: fullSuite('cache-miss'),
        changedFiles: ['/r/src/a.ts'],
      },
      {
        sha: 'c2',
        freshMap: rm({
          '/r/src/a.ts': ['/r/t/a.test.ts'],
          '/r/src/b.ts': ['/r/t/b.test.ts'],
        }),
        decision: selective(['/r/t/a.test.ts']),
        changedFiles: ['/r/src/a.ts'],
      },
    ]);
    expect(steps).toHaveLength(2);
    // C2's before == C1's after (cold-warmed).
    expect(edges(steps[1].cacheBefore, '/r/src/a.ts')).toEqual([
      '/r/t/a.test.ts',
    ]);
    // C2's simulated selection = lookup of a.ts in the evolved cache.
    expect([...steps[1].simulatedSelection]).toEqual(['/r/t/a.test.ts']);
    // testB was NOT selected → its fresh edge on b.ts is NOT persisted.
    expect(steps[1].cacheAfter.has('/r/src/b.ts')).toBe(false);
    expect(edges(steps[1].cacheAfter, '/r/src/a.ts')).toEqual([
      '/r/t/a.test.ts',
    ]);
  });

  test('DRIFT FEEDBACK LOOP: edges drifted out stay missing from simulated selections until a full-suite reason refreshes them', () => {
    const tA = '/r/t/a.test.ts';
    const tB = '/r/t/b.test.ts';
    const steps = reconstructCacheEvolution([
      // c1: cold warm-up ('all') — cache learns a.ts→tA, b.ts→tB.
      {
        sha: 'c1',
        freshMap: rm({ '/r/src/a.ts': [tA], '/r/src/b.ts': [tB] }),
        decision: fullSuite('cache-miss'),
        changedFiles: ['/r/src/a.ts'],
      },
      // c2: ground truth moves tB's dependency b.ts → c.ts, but only a.ts
      // changed → simulated selection = {tA} → tB's fresh edge is NOT
      // persisted: the live cache never learns c.ts→tB (drift).
      {
        sha: 'c2',
        freshMap: rm({ '/r/src/a.ts': [tA], '/r/src/c.ts': [tB] }),
        decision: selective([tA]),
        changedFiles: ['/r/src/a.ts'],
      },
      // c3: c.ts changes — ground truth says tB is required, but the drifted
      // cache has no c.ts edge → tB STAYS MISSING from the simulated
      // selection (the drift-caused miss persists; this is the pin).
      {
        sha: 'c3',
        freshMap: rm({ '/r/src/a.ts': [tA], '/r/src/c.ts': [tB] }),
        decision: selective([tA, tB]),
        changedFiles: ['/r/src/a.ts', '/r/src/c.ts'],
      },
      // c4: config-change (cache-independent full-suite) → 'all' refresh
      // heals the drift: c.ts→tB learned, stale b.ts→tB dropped.
      {
        sha: 'c4',
        freshMap: rm({ '/r/src/a.ts': [tA], '/r/src/c.ts': [tB] }),
        decision: fullSuite('config-change'),
        changedFiles: [],
      },
      // c5: c.ts changes again — NOW the simulation selects tB.
      {
        sha: 'c5',
        freshMap: rm({ '/r/src/a.ts': [tA], '/r/src/c.ts': [tB] }),
        decision: selective([tB]),
        changedFiles: ['/r/src/c.ts'],
      },
    ]);

    // c2 persisted only tA's edges: stale b.ts→tB kept, c.ts→tB never learned.
    expect(edges(steps[1].cacheAfter, '/r/src/b.ts')).toEqual([tB]);
    expect(steps[1].cacheAfter.has('/r/src/c.ts')).toBe(false);
    // THE PIN: at c3 the drifted simulation still misses tB — the recorded
    // selection (which included tB) must NOT leak back into the loop.
    expect(steps[2].simulatedSelection.has(tB)).toBe(false);
    expect(steps[2].simulatedSelection.has(tA)).toBe(true);
    expect(steps[2].cacheAfter.has('/r/src/c.ts')).toBe(false);
    // c4 full-suite refresh heals the cache.
    expect(edges(steps[3].cacheAfter, '/r/src/c.ts')).toEqual([tB]);
    expect(steps[3].cacheAfter.has('/r/src/b.ts')).toBe(false);
    // c5: recovered — the simulation selects tB again.
    expect(steps[4].simulatedSelection.has(tB)).toBe(true);
  });
});

// ===========================================================================
// detector — required tests + two-tier miss detection
// ===========================================================================
describe('detector: computeRequiredTests', () => {
  test('unions dependent tests across all changed files', () => {
    const fresh = rm({
      '/repo/src/a.ts': ['/repo/t/a.test.ts', '/repo/t/shared.test.ts'],
      '/repo/src/b.ts': ['/repo/t/b.test.ts'],
      '/repo/src/c.ts': ['/repo/t/c.test.ts'], // not changed
    });
    const required = computeRequiredTests(fresh, [
      '/repo/src/a.ts',
      '/repo/src/b.ts',
    ]);
    expect([...required].sort()).toEqual([
      '/repo/t/a.test.ts',
      '/repo/t/b.test.ts',
      '/repo/t/shared.test.ts',
    ]);
  });

  test('changed file absent from the ground-truth map contributes nothing', () => {
    const fresh = rm({ '/repo/src/a.ts': ['/repo/t/a.test.ts'] });
    expect(computeRequiredTests(fresh, ['/repo/src/unknown.ts']).size).toBe(0);
  });
});

describe('detector: simulateLiveSelection', () => {
  test('looks up the STALE evolved cache, not ground truth', () => {
    // Stale cache knows a.ts → a.test; ground truth would also know style.css.
    const staleCache = rm({ '/repo/src/a.ts': ['/repo/t/a.test.ts'] });
    const selection = simulateLiveSelection(
      staleCache,
      ['/repo/src/a.ts', '/repo/src/style.css'],
      new Set(['/repo/t/a.test.ts', '/repo/t/style.test.ts']),
    );
    // style.css has no edge in the stale cache → style.test.ts NOT selected.
    expect([...selection].sort()).toEqual(['/repo/t/a.test.ts']);
  });

  test('a changed test file selects itself even when absent from the cache', () => {
    const selection = simulateLiveSelection(
      new Map(),
      ['/repo/t/new.test.ts'],
      new Set(['/repo/t/new.test.ts']),
    );
    expect([...selection]).toEqual(['/repo/t/new.test.ts']);
  });

  test('testsOf collects the test-file value space of a reverse map', () => {
    const map = rm({
      '/repo/src/a.ts': ['/repo/t/a.test.ts', '/repo/t/b.test.ts'],
      '/repo/src/b.ts': ['/repo/t/b.test.ts'],
    });
    expect([...testsOf(map)].sort()).toEqual([
      '/repo/t/a.test.ts',
      '/repo/t/b.test.ts',
    ]);
  });
});

describe('detector: detectStructuralMisses', () => {
  test('flags required-but-unselected tests with causing files + channels', () => {
    const fresh = rm({
      '/repo/src/a.ts': ['/repo/t/a.test.ts'],
      '/repo/src/style.css': ['/repo/t/style.test.ts'],
    });
    // Changed a.ts + style.css; selection only picked a.test.ts → style.test.ts
    // is a structural miss (the stale cache didn't know it depended on style.css).
    const misses = detectStructuralMisses({
      sha: 'c1',
      changedFiles: ['/repo/src/a.ts', '/repo/src/style.css'],
      freshMap: fresh,
      selection: new Set(['/repo/t/a.test.ts']),
      outcomes: new Map(),
    });
    expect(misses).toHaveLength(1);
    expect(misses[0].test).toBe('/repo/t/style.test.ts');
    expect(misses[0].causingFiles).toEqual(['/repo/src/style.css']);
    expect(misses[0].channels).toEqual(['style']);
  });

  test('no misses when selection covers all required tests', () => {
    const fresh = rm({ '/repo/src/a.ts': ['/repo/t/a.test.ts'] });
    const misses = detectStructuralMisses({
      sha: 'c1',
      changedFiles: ['/repo/src/a.ts'],
      freshMap: fresh,
      selection: new Set(['/repo/t/a.test.ts']),
      outcomes: new Map(),
    });
    expect(misses).toEqual([]);
  });

  test('full-suite selection (null) can never miss', () => {
    const fresh = rm({ '/repo/src/a.ts': ['/repo/t/a.test.ts'] });
    const misses = detectStructuralMisses({
      sha: 'c1',
      changedFiles: ['/repo/src/a.ts'],
      freshMap: fresh,
      selection: null,
      outcomes: new Map(),
    });
    expect(misses).toEqual([]);
  });

  test('added test (fresh-only edge, not selected) is caught structurally', () => {
    // t/new.test.ts appears in the fresh map at C (added this commit) depending
    // on the changed file; selection (from a stale cache) omits it.
    const fresh = rm({ '/repo/src/a.ts': ['/repo/t/new.test.ts'] });
    const misses = detectStructuralMisses({
      sha: 'c1',
      changedFiles: ['/repo/src/a.ts'],
      freshMap: fresh,
      selection: new Set<string>(),
      outcomes: new Map(),
    });
    expect(misses.map((m) => m.test)).toEqual(['/repo/t/new.test.ts']);
  });
});

describe('detector: classifyChannel', () => {
  test('classifies by extension and test-path', () => {
    expect(classifyChannel('/repo/src/a.ts')).toBe('ts');
    expect(classifyChannel('/repo/src/Comp.tsx')).toBe('tsx');
    expect(classifyChannel('/repo/src/util.js')).toBe('js');
    expect(classifyChannel('/repo/src/styles.css')).toBe('style');
    expect(classifyChannel('/repo/src/data.json')).toBe('json');
    expect(classifyChannel('/repo/test/a.test.ts')).toBe('test');
    expect(classifyChannel('/repo/src/a.spec.tsx')).toBe('test');
    expect(classifyChannel('/repo/README.md')).toBe('md');
    expect(classifyChannel('/repo/Makefile')).toBe('other');
  });
});

describe('detector: detectOutcomeConfirmed (severity subset)', () => {
  test('confirmed = structural misses whose pass/fail flipped C-1 → C', () => {
    const structural = [
      { test: '/repo/t/flip.test.ts', causingFiles: [], channels: [] },
      { test: '/repo/t/stable.test.ts', causingFiles: [], channels: [] },
      { test: '/repo/t/added.test.ts', causingFiles: [], channels: [] },
    ];
    const prev = new Map<string, string>([
      ['/repo/t/flip.test.ts', 'passed'],
      ['/repo/t/stable.test.ts', 'passed'],
    ]);
    const cur = new Map<string, string>([
      ['/repo/t/flip.test.ts', 'failed'], // flipped → confirmed
      ['/repo/t/stable.test.ts', 'passed'], // unchanged
      ['/repo/t/added.test.ts', 'failed'], // new failing test → confirmed
    ]);
    const confirmed = detectOutcomeConfirmed(structural, prev, cur);
    expect(confirmed.sort()).toEqual([
      '/repo/t/added.test.ts',
      '/repo/t/flip.test.ts',
    ]);
  });
});

// ===========================================================================
// detector — degeneration guard
// ===========================================================================
describe('detector: degeneration guard', () => {
  const okSelective: LedgerEntry = {
    sha: 's1',
    status: 'ok',
    reason: 'ok',
    timings: { totalMs: 1 },
    decision: selective(['t/a.test.ts']),
  };
  const okFull: LedgerEntry = {
    sha: 'f1',
    status: 'ok',
    reason: 'ok',
    timings: { totalMs: 1 },
    decision: fullSuite('cache-miss'),
  };

  test('countSelectiveDecisions counts only shadow-selective ok commits', () => {
    expect(countSelectiveDecisions([okSelective, okFull])).toBe(1);
    expect(countSelectiveDecisions([okFull, okFull])).toBe(0);
  });

  test('assertSelectiveDecisions throws NoSelectiveDecisionsError on all-full-suite walk', () => {
    expect(() => assertSelectiveDecisions([okFull, okFull])).toThrow(
      NoSelectiveDecisionsError,
    );
    // A single selective decision is enough to pass.
    expect(() => assertSelectiveDecisions([okFull, okSelective])).not.toThrow();
  });
});

// ===========================================================================
// analysis — artifact parsing
// ===========================================================================
describe('analysis: artifact parsing', () => {
  test('parseGraphReverseMap parses the v2 graph.json into a ReverseMap', () => {
    const content = JSON.stringify({
      version: 2,
      builtAt: 123,
      reverseMap: {
        '/repo/src/a.ts': ['/repo/t/a.test.ts', '/repo/t/b.test.ts'],
      },
    });
    const map = parseGraphReverseMap(content);
    expect(edges(map, '/repo/src/a.ts')).toEqual([
      '/repo/t/a.test.ts',
      '/repo/t/b.test.ts',
    ]);
  });

  test('parseGraphReverseMap tolerates corrupt / non-v2 content (empty map)', () => {
    expect(parseGraphReverseMap('not json').size).toBe(0);
    expect(parseGraphReverseMap(JSON.stringify({ version: 9 })).size).toBe(0);
  });

  test('parseOutcomes reads the vitest json reporter testResults', () => {
    const content = JSON.stringify({
      testResults: [
        { name: '/repo/t/a.test.ts', status: 'passed' },
        { name: '/repo/t/b.test.ts', status: 'failed' },
      ],
    });
    const outcomes = parseOutcomes(content);
    expect(outcomes.get('/repo/t/a.test.ts')).toBe('passed');
    expect(outcomes.get('/repo/t/b.test.ts')).toBe('failed');
  });

  test('parseOutcomes tolerates unparseable stdout (empty map)', () => {
    expect(parseOutcomes('vitest crashed, no json').size).toBe(0);
  });
});

// ===========================================================================
// analysis — full run over a synthetic run-dir fixture (A2a layout)
// ===========================================================================
describe('analysis: analyzeRun over a synthetic run dir', () => {
  interface CommitFixture {
    sha: string;
    status: 'ok' | 'skipped' | 'BROKEN';
    reason?: string;
    changedFiles?: string[];
    decision?: ShadowDecision;
    reverseMap?: Record<string, string[]>;
    outcomes?: Record<string, string>;
  }

  /** Materialize the A2a artifact layout for a list of commits. */
  function buildRunDir(commits: CommitFixture[]): {
    runDir: string;
    rootDir: string;
  } {
    const base = tmp('replay-analysis-');
    const rootDir = path.join(base, 'clone');
    const runDir = path.join(base, 'runs', 'ts');
    const graphsDir = path.join(runDir, 'graphs');
    const outcomesDir = path.join(runDir, 'outcomes');
    mkdirSync(graphsDir, { recursive: true });
    mkdirSync(outcomesDir, { recursive: true });

    const ledgerLines: string[] = [];
    for (const c of commits) {
      const entry: LedgerEntry = {
        sha: c.sha,
        status: c.status,
        reason: c.reason ?? c.status,
        timings: { totalMs: 1 },
      };
      if (c.changedFiles) entry.changedFiles = c.changedFiles;
      if (c.decision) entry.decision = c.decision;
      ledgerLines.push(JSON.stringify(entry));

      if (c.reverseMap) {
        writeFileSync(
          path.join(graphsDir, `${c.sha}.json`),
          JSON.stringify({ version: 2, builtAt: 1, reverseMap: c.reverseMap }),
        );
      }
      if (c.outcomes) {
        writeFileSync(
          path.join(outcomesDir, `${c.sha}.json`),
          JSON.stringify({
            testResults: Object.entries(c.outcomes).map(([name, status]) => ({
              name,
              status,
            })),
          }),
        );
      }
    }
    writeFileSync(
      path.join(runDir, 'ledger.jsonl'),
      ledgerLines.join('\n') + '\n',
    );
    return { runDir, rootDir };
  }

  test('segments warm-up, exempts full-suite fallbacks, and detects misses over the selective denominator', async () => {
    const abs = (p: string): string => `/repo/${p}`;
    const { runDir } = buildRunDir([
      // Warm-up: leading full-suite (cold cache) before any selective decision.
      {
        sha: 'w1',
        status: 'ok',
        changedFiles: ['src/a.ts'],
        decision: fullSuite('cache-miss'),
        reverseMap: { [abs('src/a.ts')]: [abs('t/a.test.ts')] },
        outcomes: { [abs('t/a.test.ts')]: 'passed' },
      },
      // First selective decision — a clean hit (selection covers required).
      {
        sha: 's1',
        status: 'ok',
        changedFiles: ['src/a.ts'],
        decision: selective([abs('t/a.test.ts')]),
        reverseMap: { [abs('src/a.ts')]: [abs('t/a.test.ts')] },
        outcomes: { [abs('t/a.test.ts')]: 'passed' },
      },
      // Mid-walk designed full-suite fallback — exempt, NOT warm-up.
      {
        sha: 'f1',
        status: 'ok',
        changedFiles: ['vitest.config.ts'],
        decision: fullSuite('config-change'),
        reverseMap: { [abs('src/a.ts')]: [abs('t/a.test.ts')] },
        outcomes: { [abs('t/a.test.ts')]: 'passed' },
      },
      // Selective MISS: style.css changed, only a.test.ts selected, but
      // ground truth says style.test.ts depends on style.css → structural miss.
      // Its outcome flips passed→failed → outcome-confirmed.
      {
        sha: 's2',
        status: 'ok',
        changedFiles: ['src/a.ts', 'src/style.css'],
        decision: selective([abs('t/a.test.ts')]),
        reverseMap: {
          [abs('src/a.ts')]: [abs('t/a.test.ts')],
          [abs('src/style.css')]: [abs('t/style.test.ts')],
        },
        outcomes: {
          [abs('t/a.test.ts')]: 'passed',
          [abs('t/style.test.ts')]: 'failed',
        },
      },
      // A skipped and a BROKEN commit for the inventory.
      { sha: 'skip1', status: 'skipped', reason: 'config/lockfile touched' },
      { sha: 'brk1', status: 'BROKEN', reason: 'no shadow stats line emitted' },
    ]);

    const analysis = await analyzeRun({ runDir, rootDir: '/repo' });

    expect(analysis.selectiveDecisions).toBe(2); // s1, s2
    expect(analysis.warmupCommits).toBe(1); // w1
    // Fallback frequency segmented by reason (mid-walk full-suite only).
    expect(analysis.fallbackFrequency['config-change']).toBe(1);
    expect(analysis.fallbackFrequency['cache-miss']).toBeUndefined(); // that was warm-up
    // One selective commit (s2) had a structural + confirmed miss.
    expect(analysis.commitsWithStructuralMiss).toBe(1);
    expect(analysis.commitsWithOutcomeConfirmedMiss).toBe(1);
    expect(analysis.structuralMissRate).toBeCloseTo(0.5); // 1 / 2
    expect(analysis.outcomeConfirmedMissRate).toBeCloseTo(0.5);
    expect(analysis.missesByChannel['style']).toBe(1);
    // Inventories.
    expect(analysis.brokenCommits.map((b) => b.sha)).toEqual(['brk1']);
    expect(analysis.skippedCommits.map((s) => s.sha)).toEqual(['skip1']);
    // Healthy outcome join → no integrity warnings.
    expect(analysis.warnings).toEqual([]);
  });

  test('normalizes RELATIVE outcome paths into the graph path space (outcome tier joins)', async () => {
    const abs = (p: string): string => `/repo/${p}`;
    const { runDir } = buildRunDir([
      {
        sha: 'w1',
        status: 'ok',
        changedFiles: ['src/a.ts'],
        decision: fullSuite('cache-miss'),
        reverseMap: { [abs('src/a.ts')]: [abs('t/a.test.ts')] },
        // Relative reporter names — must resolve against rootDir to join.
        outcomes: { 't/a.test.ts': 'passed' },
      },
      {
        sha: 's1',
        status: 'ok',
        changedFiles: ['src/a.ts', 'src/style.css'],
        decision: selective([abs('t/a.test.ts')]),
        reverseMap: {
          [abs('src/a.ts')]: [abs('t/a.test.ts')],
          [abs('src/style.css')]: [abs('t/style.test.ts')],
        },
        outcomes: { 't/a.test.ts': 'passed', 't/style.test.ts': 'failed' },
      },
    ]);
    const analysis = await analyzeRun({ runDir, rootDir: '/repo' });
    // The miss joined its outcome (failed, no prior entry) → confirmed.
    expect(analysis.totalStructuralMisses).toBe(1);
    expect(analysis.totalOutcomeConfirmedMisses).toBe(1);
    expect(analysis.warnings).toEqual([]);
  });

  test('LOUD GUARD: structural misses with a zero outcome join warn instead of silently reporting 0', async () => {
    const abs = (p: string): string => `/repo/${p}`;
    const { runDir } = buildRunDir([
      {
        sha: 'w1',
        status: 'ok',
        changedFiles: ['src/a.ts'],
        decision: fullSuite('cache-miss'),
        reverseMap: { [abs('src/a.ts')]: [abs('t/a.test.ts')] },
        outcomes: { '/elsewhere/t/a.test.ts': 'passed' },
      },
      {
        sha: 's1',
        status: 'ok',
        changedFiles: ['src/a.ts', 'src/style.css'],
        decision: selective([abs('t/a.test.ts')]),
        reverseMap: {
          [abs('src/a.ts')]: [abs('t/a.test.ts')],
          [abs('src/style.css')]: [abs('t/style.test.ts')],
        },
        // Outcome names live in a DIFFERENT path space — the join finds
        // nothing for the missed test.
        outcomes: {
          '/elsewhere/t/a.test.ts': 'passed',
          '/elsewhere/t/style.test.ts': 'failed',
        },
      },
    ]);
    const analysis = await analyzeRun({ runDir, rootDir: '/repo' });
    expect(analysis.totalStructuralMisses).toBe(1);
    // The flip existed but the join is broken → 0 confirmed + a LOUD warning.
    expect(analysis.totalOutcomeConfirmedMisses).toBe(0);
    expect(analysis.warnings).toHaveLength(1);
    expect(analysis.warnings[0]).toMatch(/outcome tier may be broken/);
    // The warning is rendered into the report.
    expect(renderReport(analysis)).toMatch(/outcome tier may be broken/);
  });

  test('all-full-suite walk fails loudly (degeneration guard)', async () => {
    const { runDir } = buildRunDir([
      {
        sha: 'f1',
        status: 'ok',
        changedFiles: ['src/a.ts'],
        decision: fullSuite('cache-miss'),
        reverseMap: { '/repo/src/a.ts': ['/repo/t/a.test.ts'] },
        outcomes: { '/repo/t/a.test.ts': 'passed' },
      },
    ]);
    await expect(analyzeRun({ runDir, rootDir: '/repo' })).rejects.toThrow(
      NoSelectiveDecisionsError,
    );
  });

  test('degeneration still writes a diagnosis analysis.md (analyzeAndReport) before rethrowing', async () => {
    const { runDir } = buildRunDir([
      {
        sha: 'f1',
        status: 'ok',
        changedFiles: ['src/a.ts'],
        decision: fullSuite('cache-miss'),
        reverseMap: { '/repo/src/a.ts': ['/repo/t/a.test.ts'] },
        outcomes: { '/repo/t/a.test.ts': 'passed' },
      },
      { sha: 'brk1', status: 'BROKEN', reason: 'install failed' },
    ]);
    await expect(
      analyzeAndReport({ runDir, rootDir: '/repo' }),
    ).rejects.toThrow(NoSelectiveDecisionsError);
    // The walk data stays diagnosable without a ~320s/commit re-walk.
    const reportPath = path.join(runDir, 'analysis.md');
    expect(existsSync(reportPath)).toBe(true);
    const md = readFileSync(reportPath, 'utf-8');
    expect(md).toMatch(/DEGENERATE/);
    expect(md).toMatch(/shadow-full-suite \(cache-miss\)/); // segmentation table
    expect(md).toMatch(/BROKEN/);
    expect(md).toMatch(/--analyze-only/); // recovery instruction
  });

  test('writeReport emits analysis.md into the run dir', async () => {
    const { runDir } = buildRunDir([
      {
        sha: 's1',
        status: 'ok',
        changedFiles: ['src/a.ts'],
        decision: selective(['/repo/t/a.test.ts']),
        reverseMap: { '/repo/src/a.ts': ['/repo/t/a.test.ts'] },
        outcomes: { '/repo/t/a.test.ts': 'passed' },
      },
    ]);
    const analysis = await analyzeRun({ runDir, rootDir: '/repo' });
    const reportPath = await writeReport(runDir, analysis);
    expect(reportPath).toBe(path.join(runDir, 'analysis.md'));
  });
});

// ===========================================================================
// report — markdown rendering smoke
// ===========================================================================
describe('report: renderReport smoke', () => {
  test('renders both miss-rate tiers, channels, fallbacks and BROKEN inventory', () => {
    const md = renderReport({
      runDir: '/run',
      totalCommits: 6,
      okCommits: 4,
      selectiveDecisions: 2,
      warmupCommits: 1,
      unmeasurableCommits: [],
      structuralMissRate: 0.5,
      outcomeConfirmedMissRate: 0.5,
      commitsWithStructuralMiss: 1,
      commitsWithOutcomeConfirmedMiss: 1,
      totalStructuralMisses: 1,
      totalOutcomeConfirmedMisses: 1,
      missesByChannel: { style: 1 },
      fallbackFrequency: { 'config-change': 1 },
      brokenCommits: [{ sha: 'brk1', reason: 'no shadow stats line emitted' }],
      skippedCommits: [{ sha: 'skip1', reason: 'lockfile touched' }],
      commits: [],
      warnings: ['outcome tier may be broken — example warning'],
    });
    // Both tiers labeled — never a bare "miss-rate".
    expect(md).toMatch(/structural miss-rate/i);
    expect(md).toMatch(/outcome-confirmed miss-rate/i);
    // Segmentation + inventory present.
    expect(md).toMatch(/config-change/);
    expect(md).toMatch(/style/);
    expect(md).toMatch(/brk1/);
    expect(md).toMatch(/warm-?up/i);
    // Integrity warnings render loudly.
    expect(md).toMatch(/Warnings/);
    expect(md).toMatch(/outcome tier may be broken/);
  });
});

// ===========================================================================
// flake guard — re-run a new failure once with the kill-switch
// ===========================================================================
describe('flake guard: flakeCheckCommit', () => {
  test('re-runs new failures; separates confirmed from flaky, and does not run when none', async () => {
    const prev = new Map<string, string>([
      ['/repo/t/a.test.ts', 'passed'],
      ['/repo/t/b.test.ts', 'passed'],
    ]);
    const cur = new Map<string, string>([
      ['/repo/t/a.test.ts', 'failed'], // new failure → re-run
      ['/repo/t/b.test.ts', 'failed'], // new failure → re-run
    ]);
    // Fake re-runner: a.test.ts still fails (confirmed), b.test.ts passes (flake).
    let runnerCalls = 0;
    const rerun = async (): Promise<Map<string, string>> => {
      runnerCalls++;
      return new Map<string, string>([
        ['/repo/t/a.test.ts', 'failed'],
        ['/repo/t/b.test.ts', 'passed'],
      ]);
    };
    const result = await flakeCheckCommit('c1', prev, cur, rerun);
    expect(runnerCalls).toBe(1);
    expect(result.newFailures.sort()).toEqual([
      '/repo/t/a.test.ts',
      '/repo/t/b.test.ts',
    ]);
    expect(result.confirmed).toEqual(['/repo/t/a.test.ts']);
    expect(result.flaky).toEqual(['/repo/t/b.test.ts']);

    // No new failures → runner never spawned.
    let calls2 = 0;
    const rerun2 = async (): Promise<Map<string, string>> => {
      calls2++;
      return new Map();
    };
    const clean = await flakeCheckCommit('c2', prev, prev, rerun2);
    expect(calls2).toBe(0);
    expect(clean.newFailures).toEqual([]);
    expect(clean.baseline).toBe(false);
  });

  test('first measurable commit (null baseline) never re-runs — failures become the baseline, not flakes', async () => {
    // With an empty prior map every failure would look "new": spurious
    // DISABLED re-runs, and a baseline-broken test laundered into 'flaky'.
    // A null baseline marks commit #1: no comparison, no re-run.
    let calls = 0;
    const rerun = async (): Promise<Map<string, string>> => {
      calls++;
      return new Map<string, string>([['/repo/t/broken.test.ts', 'passed']]);
    };
    const cur = new Map<string, string>([
      ['/repo/t/broken.test.ts', 'failed'], // baseline-broken test
      ['/repo/t/a.test.ts', 'passed'],
    ]);
    const result = await flakeCheckCommit('c0', null, cur, rerun);
    expect(calls).toBe(0);
    expect(result.baseline).toBe(true);
    expect(result.reran).toBe(false);
    expect(result.newFailures).toEqual([]);
    expect(result.confirmed).toEqual([]);
    expect(result.flaky).toEqual([]); // never laundered into 'flaky'
  });
});

// ===========================================================================
// run — --analyze-only CLI mode (analysis iterates fast on expensive walks)
// ===========================================================================
describe('run: --analyze-only arg parsing', () => {
  test('parseArgs accepts --analyze-only without --repo/--range', () => {
    const args = parseArgs(['--analyze-only', '/work/runs/2026-07-04']);
    expect(args.analyzeOnly).toBe('/work/runs/2026-07-04');
    expect(args.help).toBe(false);
  });

  test('parseArgs accepts --root alongside --analyze-only', () => {
    const args = parseArgs([
      '--analyze-only',
      '/work/runs/x',
      '--root',
      '/work/body-compass-app',
    ]);
    expect(args.analyzeOnly).toBe('/work/runs/x');
    expect(args.root).toBe('/work/body-compass-app');
  });

  test('parseArgs still requires --repo/--range when --analyze-only is absent', () => {
    expect(() => parseArgs(['--root', '/x'])).toThrow(/--repo is required/);
  });
});
