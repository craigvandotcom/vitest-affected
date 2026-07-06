/// <reference types="vitest/config" />
/**
 * Replay harness self-test (A2c) — the planted-miss silver bullet.
 *
 * A miss-rate of 0 from an unproven harness is worthless: a clean report is
 * indistinguishable from a broken harness unless we can plant a miss the harness
 * DETECTS. These specs drive the REAL replay pipeline end-to-end (workdir →
 * walker → exec.runCommit per commit → analysis) over tiny synthetic consumer
 * repos with scripted git history, then assert the analysis layer's verdicts.
 *
 * FINDING (documented in the bead result, load-bearing for the PLANTED-MISS
 * design): a real, source-only commit sequence provably CANNOT produce a
 * structural miss in this harness. The structural detector compares the
 * ground-truth runtime map at C against the SIMULATED live selection, which is
 * a pure transitive-cache lookup plus self-selection of changed test files
 * (detector.ts: simulateLiveSelection — no delta-parse). Because:
 *   (a) the warm-up full run captures every edge a test truly has (runtime is
 *       alias/resolution transparent — an aliased import is recorded under its
 *       real resolved path just like a relative one), and
 *   (b) any NEWLY-true edge F→T at C requires editing a file on T's import
 *       chain, and that file is either T itself (self-selected) or a file T
 *       transitively imported at warm-up (hence already cached to T, so T is
 *       selected and its edges refresh),
 * the simulated selection always covers the required set. The alias channel the
 * bead names (a string `resolve.alias` the oxc delta-parser can't resolve)
 * breaks the LIVE plugin's delta-parse seed augmentation, but the cache itself
 * is populated by the runtime reporter (alias-transparent), so a
 * full-suite-every-commit walk never drifts.
 *
 * So the planted miss is realized by reconstructing the DRIFTED cache the alias
 * channel produces LIVE: a warm-up graph trimmed of the aliased edge (a live
 * cache that never learned it). Everything else — the per-commit runtime maps,
 * the shadow decisions, the pass/fail outcomes — is captured from REAL nested
 * vitest runs, and the miss is detected by the REAL analyzeRun (evolution +
 * detector + outcome join + report), not a hand-built run dir.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  realpathSync,
  symlinkSync,
  existsSync,
} from 'node:fs';
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execa } from 'execa';

import {
  resolveWorkdirRoot,
  symlinkDist,
  cloneConsumer,
  createRunDir,
} from '../tools/replay/workdir.js';
import {
  getFirstParentChain,
  getCommitChangedFiles,
  classifyCommit,
} from '../tools/replay/walker.js';
import { runCommit } from '../tools/replay/exec.js';
import {
  analyzeRun,
  analyzeAndReport,
  parseGraphReverseMap,
  NoSelectiveDecisionsError,
} from '../tools/replay/analysis.js';
import { reconstructCacheEvolution } from '../tools/replay/evolution.js';
import type { CommitEdgeInput } from '../tools/replay/evolution.js';
import type { LedgerEntry } from '../tools/replay/types.js';
import type { ReverseMap } from '../dist/index.js';

const projectRoot = path.resolve(import.meta.dirname, '..');
const distPath = path.join(projectRoot, 'dist');
const nodeModules = path.join(projectRoot, 'node_modules');

// ---------------------------------------------------------------------------
// Temp-dir bookkeeping — every source repo and every workdir is tracked and
// removed at the end (walks are heavy but self-contained).
// ---------------------------------------------------------------------------
const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
  tempDirs.length = 0;
});

// The fixture vitest config mirrors BCA's real pattern: resolve the plugin
// through the SIBLING path (../vitest-affected/dist — the workdir layout) with a
// graceful no-op fallback when the dist symlink is absent. `ref: 'main'` matches
// the harness's ref control (exec.setRefToParent force-moves main to C^). The
// `@app` string alias is the silent coupling channel: the oxc delta-parser
// (builder.ts createResolver) has no alias feed, only tsconfig paths.
const VITEST_CONFIG = `
import { defineConfig } from 'vitest/config';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let plugin;
try {
  const mod = require('../vitest-affected/dist/index.js');
  plugin = mod.vitestAffected({ verbose: false, ref: 'main' });
} catch {
  // Silent no-op fallback — dist symlink absent. This is the fail-closed target
  // of the NO-OP fixture: no shadow stats line ever gets emitted.
  plugin = { name: 'vitest-affected-noop' };
}
export default defineConfig({
  plugins: [plugin],
  resolve: { alias: { '@app': new URL('./src/', import.meta.url).pathname } },
  test: { include: ['tests/**/*.test.ts'] },
});
`;

interface RepoFile {
  path: string;
  content: string;
}

/**
 * A pristine base env for the nested vitest runs. The replay harness (run.ts) is
 * normally invoked via `npx tsx`, where no VITEST_ or TINYPOOL_ vars exist. Here
 * we drive runCommit from WITHIN vitest, so the parent run's worker/pool env
 * would leak into the child vitest and derail it (no shadow line → false BROKEN).
 * buildRunEnv re-adds VITEST_AFFECTED_SHADOW + STATS_FILE, so stripping the whole
 * VITEST prefix is safe.
 */
function cleanBaseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(VITEST|TINYPOOL|npm_)/.test(k)) continue;
    env[k] = v;
  }
  return env;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execa('git', args, { cwd });
  return stdout.trim();
}

function writeRepoFile(dir: string, file: string, content: string): void {
  const full = path.join(dir, file);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

async function commitAll(cwd: string, msg: string): Promise<string> {
  await execa('git', ['add', '-A'], { cwd });
  await execa('git', ['commit', '-m', msg], { cwd });
  return git(cwd, ['rev-parse', 'HEAD']);
}

/** Baseline files shared by every fixture repo (config + two tests). */
function baselineFiles(): RepoFile[] {
  return [
    {
      path: 'package.json',
      content: JSON.stringify(
        { name: 'replay-consumer', type: 'module', private: true },
        null,
        2,
      ),
    },
    {
      path: 'tsconfig.json',
      content: JSON.stringify(
        {
          compilerOptions: {
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
          },
        },
        null,
        2,
      ),
    },
    { path: 'vitest.config.mts', content: VITEST_CONFIG },
    { path: 'src/a.ts', content: 'export const a = 1;\n' },
    { path: 'src/mod.ts', content: 'export const mod = 1;\n' },
    {
      path: 'tests/a.test.ts',
      content: `import { test, expect } from 'vitest';\nimport { a } from '../src/a';\ntest('a', () => { expect(a).toBe(1); });\n`,
    },
    // Depends on src/mod.ts ONLY through the @app string alias (the channel).
    {
      path: 'tests/mod.test.ts',
      content: `import { test, expect } from 'vitest';\nimport { mod } from '@app/mod';\ntest('mod', () => { expect(mod).toBe(1); });\n`,
    },
  ];
}

async function initRepo(prefix: string, files: RepoFile[]): Promise<string> {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  tempDirs.push(base);
  for (const f of files) writeRepoFile(base, f.path, f.content);
  await execa('git', ['init'], { cwd: base });
  await execa('git', ['config', 'user.email', 't@t.com'], { cwd: base });
  await execa('git', ['config', 'user.name', 'Test'], { cwd: base });
  await execa('git', ['config', 'commit.gpgsign', 'false'], { cwd: base });
  await execa('git', ['checkout', '-b', 'main'], { cwd: base });
  return base;
}

interface WalkResult {
  runDir: string;
  cloneDir: string;
  graphsDir: string;
  entries: LedgerEntry[];
}

/**
 * Drive the REAL replay walk over `base`'s history in `range` using the
 * harness's own workdir/walker/exec functions. `withDist` toggles the sibling
 * dist symlink — off exercises the consumer config's no-op fallback (the
 * fail-closed path). Dependencies are supplied by symlinking THIS repo's
 * node_modules into the clone (mirrors integration.test.ts) — no pnpm install.
 */
async function walk(
  base: string,
  range: string,
  { withDist }: { withDist: boolean },
): Promise<WalkResult> {
  const workdir = resolveWorkdirRoot();
  tempDirs.push(workdir);
  if (withDist) symlinkDist(workdir, distPath);
  const cloneDir = await cloneConsumer(workdir, base);
  symlinkSync(nodeModules, path.join(cloneDir, 'node_modules'));
  const dirs = createRunDir(workdir);

  const chain = await getFirstParentChain(cloneDir, range);
  const entries: LedgerEntry[] = [];
  for (const sha of chain) {
    const changedFiles = await getCommitChangedFiles(cloneDir, sha);
    const cls = classifyCommit(sha, changedFiles);
    if (cls.skip) {
      const entry: LedgerEntry = {
        sha,
        status: 'skipped',
        reason: cls.skipTriggers.join(', '),
        timings: { totalMs: 0 },
        changedFiles,
      };
      entries.push(entry);
      appendLedger(dirs.ledgerPath, entry);
      continue;
    }
    const result = await runCommit({
      cloneDir,
      sha,
      statsDir: dirs.statsDir,
      outcomesDir: dirs.outcomesDir,
      graphsDir: dirs.graphsDir,
      baseEnv: cleanBaseEnv(),
    });
    const entry: LedgerEntry = {
      sha: result.sha,
      status: result.status,
      reason: result.reason,
      timings: { totalMs: result.totalMs },
      ...(result.decision ? { decision: result.decision } : {}),
      changedFiles,
    };
    entries.push(entry);
    appendLedger(dirs.ledgerPath, entry);
  }

  return { runDir: dirs.runDir, cloneDir, graphsDir: dirs.graphsDir, entries };
}

function appendLedger(ledgerPath: string, entry: LedgerEntry): void {
  appendFileSync(ledgerPath, JSON.stringify(entry) + '\n', 'utf-8');
}

/** The first key in `map` whose path ends with `suffix` (basename join). */
function keyEndingWith(map: ReverseMap, suffix: string): string | undefined {
  for (const k of map.keys()) if (k.endsWith(suffix)) return k;
  return undefined;
}

/** Sorted basenames of the tests attached to the first key ending `suffix`. */
function testBasenames(map: ReverseMap, suffix: string): string[] {
  const k = keyEndingWith(map, suffix);
  if (k === undefined) return [];
  return [...(map.get(k) ?? [])].map((t) => path.basename(t)).sort();
}

const WALK_TIMEOUT = 180_000;

beforeAll(async () => {
  // The analysis layer imports mergeRuntimeEdges/ReverseMap from dist at module
  // load; the fixtures load the plugin from the sibling dist. Build once.
  await execa('npm', ['run', 'build'], { cwd: projectRoot });
}, 120_000);

// ===========================================================================
// PLANTED-MISS FIXTURE — the silver bullet.
//
// tests/mod.test.ts depends on src/mod.ts ONLY through the @app string alias.
// Commit sequence: C1 warm-up (edits an unrelated file → cold cache → full
// suite → the plugin's shadow decision is full-suite and the runtime reporter
// captures mod.ts→mod.test), C2 planted (breaks src/mod.ts → the plugin records
// a shadow-SELECTIVE decision picking mod.test, and mod.test flips passed→failed).
//
// The plant: trim the aliased edge (src/mod.ts→mod.test) out of the WARM-UP
// graph — reconstructing the drifted cache a LIVE plugin would hold. The edge
// is a REVERSE edge (mod.test imports mod.ts through the @app alias) and at C2
// the only changed file is the SOURCE (src/mod.ts). Delta-parse re-parses only
// the changed files' OWN outgoing imports, so it never re-reads the unchanged
// test that holds the aliased import — the reverse edge is unrecoverable from a
// drifted cache regardless of the delta-parser's alias support (which is real:
// project.vite.config.resolve.alias DOES reach the resolver — see
// test/alias-integration.test.ts). Runtime importDurations captured the edge at
// warm-up (alias-transparent), so we remove it here. analyzeRun then simulates
// the live selection from that drifted cache, MISSES mod.test at C2, and — since
// the planted commit broke the test — the outcome-confirmed tier labels the flip.
// ===========================================================================
describe('replay: planted-miss silver bullet (real walk + drifted cache)', () => {
  test(
    'harness DETECTS the planted structural + outcome-confirmed miss',
    async () => {
      const base = await initRepo('replay-plant-', baselineFiles());
      const c0 = await commitAll(base, 'C0 init');
      writeRepoFile(base, 'src/a.ts', 'export const a = 1; // warm-up\n');
      await commitAll(base, 'C1 warm-up (unrelated edit)');
      // PLANTED: break the aliased dependency of the (unchanged) mod.test.ts.
      writeRepoFile(base, 'src/mod.ts', 'export const mod = 999; // BROKEN\n');
      const cTip = await commitAll(base, 'C2 break aliased mod');

      const { runDir, cloneDir, graphsDir, entries } = await walk(
        base,
        `${c0}..${cTip}`,
        { withDist: true },
      );

      // The walk must be clean plumbing: no BROKEN commits, a warm-up full-suite
      // then a selective decision that (with a fresh cache) correctly picks
      // mod.test — the miss is a property of the DRIFTED cache, not the plugin.
      expect(entries.every((e) => e.status === 'ok')).toBe(true);
      const warmup = entries[0];
      const planted = entries[1];
      expect(warmup.decision?.action).toBe('shadow-full-suite');
      expect(planted.decision?.action).toBe('shadow-selective');
      expect(planted.decision?.selectedFiles?.some((f) => f.endsWith('mod.test.ts'))).toBe(true);

      // PLANT the drift: remove the aliased edge from the warm-up graph.
      const warmupGraphPath = path.join(graphsDir, `${warmup.sha}.json`);
      const graph = JSON.parse(readFileSync(warmupGraphPath, 'utf-8')) as {
        reverseMap: Record<string, string[]>;
      };
      // Sanity: the runtime reporter DID capture the aliased edge at warm-up
      // (alias-transparent). Once removed, a live plugin can't rebuild it: at C2
      // only the source changed, and delta-parse never re-reads the unchanged
      // test that owns the aliased import — so this reverse edge stays missed.
      const modKey = Object.keys(graph.reverseMap).find((k) => k.endsWith('src/mod.ts'));
      expect(modKey).toBeDefined();
      delete graph.reverseMap[modKey as string];
      writeFileSync(warmupGraphPath, JSON.stringify(graph));

      const analysis = await analyzeRun({ runDir, rootDir: cloneDir });

      // Denominator: 1 warm-up + 1 measurable selective decision.
      expect(analysis.warmupCommits).toBe(1);
      expect(analysis.selectiveDecisions).toBe(1);
      expect(analysis.unmeasurableCommits).toEqual([]);
      expect(analysis.brokenCommits).toEqual([]);

      // STRUCTURAL: the detector fires on the planted commit.
      expect(analysis.commitsWithStructuralMiss).toBe(1);
      expect(analysis.structuralMissRate).toBe(1);
      expect(analysis.totalStructuralMisses).toBe(1);
      // Attributed to the changed file's channel (src/mod.ts → 'ts').
      expect(analysis.missesByChannel['ts']).toBe(1);
      const missCommit = analysis.commits.find((c) => c.segment === 'selective');
      expect(missCommit?.structuralMisses[0].test.endsWith('mod.test.ts')).toBe(true);
      expect(missCommit?.structuralMisses[0].channels).toEqual(['ts']);
      // The simulated live selection missed the required test entirely.
      expect(missCommit?.simulatedSelected).toBe(0);

      // OUTCOME-CONFIRMED: the planted change broke the test → passed→failed
      // flip is labeled (join over real reporter paths is healthy, no warning).
      expect(analysis.commitsWithOutcomeConfirmedMiss).toBe(1);
      expect(analysis.outcomeConfirmedMissRate).toBe(1);
      expect(analysis.totalOutcomeConfirmedMisses).toBe(1);
      expect(analysis.warnings).toEqual([]);
    },
    WALK_TIMEOUT,
  );
});

// ===========================================================================
// CONTROL FIXTURE — the false-positive guard: an equivalent corpus with NO
// planted drift must report ZERO misses. Also the source of the
// cache-evolution assertion (its real per-commit graphs are reused below).
// ===========================================================================
describe('replay: control fixture (no planted miss → zero misses)', () => {
  // Cache the walk so the cache-evolution spec can reuse its real artifacts.
  let control: WalkResult | undefined;

  async function runControl(): Promise<WalkResult> {
    if (control) return control;
    const base = await initRepo('replay-control-', baselineFiles());
    const c0 = await commitAll(base, 'C0 init');
    writeRepoFile(base, 'src/a.ts', 'export const a = 1; // warm-up\n');
    await commitAll(base, 'C1 warm-up');
    writeRepoFile(base, 'src/a.ts', 'export const a = 1; // edit a\n');
    await commitAll(base, 'C2 edit a (selective → a.test)');
    writeRepoFile(base, 'src/mod.ts', 'export const mod = 1; // edit mod\n');
    const cTip = await commitAll(base, 'C3 edit mod (selective → mod.test)');
    control = await walk(base, `${c0}..${cTip}`, { withDist: true });
    return control;
  }

  test(
    'a clean corpus reports zero structural and zero outcome misses',
    async () => {
      const { runDir, cloneDir, entries } = await runControl();

      // Real walk plumbing: warm-up then two selective decisions, no BROKEN.
      expect(entries.every((e) => e.status === 'ok')).toBe(true);
      const selective = entries.filter(
        (e) => e.decision?.action === 'shadow-selective',
      );
      expect(selective.length).toBe(2);

      const analysis = await analyzeRun({ runDir, rootDir: cloneDir });
      expect(analysis.selectiveDecisions).toBe(2);
      expect(analysis.warmupCommits).toBe(1);
      // The false-positive guard: not a single miss on a clean corpus.
      expect(analysis.commitsWithStructuralMiss).toBe(0);
      expect(analysis.totalStructuralMisses).toBe(0);
      expect(analysis.structuralMissRate).toBe(0);
      expect(analysis.commitsWithOutcomeConfirmedMiss).toBe(0);
      expect(analysis.totalOutcomeConfirmedMisses).toBe(0);
      expect(analysis.outcomeConfirmedMissRate).toBe(0);
      expect(analysis.warnings).toEqual([]);
      expect(analysis.brokenCommits).toEqual([]);
    },
    WALK_TIMEOUT,
  );

  // -------------------------------------------------------------------------
  // CACHE-EVOLUTION ASSERTION — over the control walk's REAL per-commit graphs:
  // commit #1 (cold cache) warms the FULL fresh map; a later selective step
  // refreshes only the shadow-selected test's edges while preserving prior
  // edges for the unselected test.
  // -------------------------------------------------------------------------
  test(
    'simulated cache warms cold on #1, then refreshes only selected edges',
    async () => {
      const { runDir, cloneDir, graphsDir, entries } = await runControl();
      // parseGraphReverseMap is fed the run dir's captured v2 graph.json (the
      // ground-truth runtime map), keyed off the same clone rootDir the analysis
      // uses — so this exercises the harness's own artifact parsing.
      void runDir;

      const okEntries = entries.filter((e) => e.status === 'ok');
      const inputs: CommitEdgeInput[] = okEntries.map((e) => {
        const graph = parseGraphReverseMap(
          readFileSync(path.join(graphsDir, `${e.sha}.json`), 'utf-8'),
          cloneDir,
        );
        const changedFiles = (e.changedFiles ?? []).map((f) =>
          path.resolve(cloneDir, f),
        );
        return {
          sha: e.sha,
          freshMap: graph,
          // decision is present on every ok entry (fail-closed ledger contract).
          decision: e.decision as NonNullable<LedgerEntry['decision']>,
          changedFiles,
        };
      });
      expect(inputs.length).toBe(3); // warm-up + 2 selective

      const steps = reconstructCacheEvolution(inputs);
      expect(steps).toHaveLength(3);

      // Step 0 (C1 warm-up): cold cache → scope 'all' → the WHOLE fresh map warms
      // in (both the direct a.ts→a.test and the aliased mod.ts→mod.test edges).
      expect(steps[0].scope).toBe('all');
      expect(testBasenames(steps[0].cacheAfter, '/src/a.ts')).toEqual([
        'a.test.ts',
      ]);
      expect(testBasenames(steps[0].cacheAfter, '/src/mod.ts')).toEqual([
        'mod.test.ts',
      ]);

      // Step 1 (C2 edit a.ts → selective, simulated selection = {a.test}):
      // a.test's edge refreshes; mod.test (unselected) keeps its prior edge.
      expect([...steps[1].simulatedSelection].map((t) => path.basename(t))).toEqual([
        'a.test.ts',
      ]);
      expect(testBasenames(steps[1].cacheAfter, '/src/a.ts')).toEqual([
        'a.test.ts',
      ]);
      // The unselected test's PRIOR edge survives untouched (fresh edges for
      // tests outside the scope set are ignored).
      expect(testBasenames(steps[1].cacheAfter, '/src/mod.ts')).toEqual([
        'mod.test.ts',
      ]);

      // Step 2 (C3 edit mod.ts → selective, selection = {mod.test}): the mirror.
      expect([...steps[2].simulatedSelection].map((t) => path.basename(t))).toEqual([
        'mod.test.ts',
      ]);
      expect(testBasenames(steps[2].cacheAfter, '/src/mod.ts')).toEqual([
        'mod.test.ts',
      ]);
      expect(testBasenames(steps[2].cacheAfter, '/src/a.ts')).toEqual([
        'a.test.ts',
      ]);
    },
    WALK_TIMEOUT,
  );
});

// ===========================================================================
// NO-OP-PLUGIN FIXTURE — fail-closed guard. Built WITHOUT the sibling dist
// symlink, so the consumer config's silent no-op fallback loads: no shadow stats
// line is ever emitted, so EVERY commit must be flagged BROKEN and the run must
// NOT read as clean.
// ===========================================================================
describe('replay: no-op plugin fixture (fail-closed → BROKEN, never clean)', () => {
  test(
    'a missing plugin flags every commit BROKEN and the run refuses to read clean',
    async () => {
      const base = await initRepo('replay-noop-', baselineFiles());
      const c0 = await commitAll(base, 'C0 init');
      writeRepoFile(base, 'src/a.ts', 'export const a = 1; // edit\n');
      const cTip = await commitAll(base, 'C1 edit a');

      const { runDir, cloneDir, entries } = await walk(base, `${c0}..${cTip}`, {
        withDist: false,
      });

      // Every measured commit is BROKEN via the missing-shadow-line guard — a
      // false-clean report is impossible when the plugin silently no-ops.
      const measured = entries.filter((e) => e.status !== 'skipped');
      expect(measured.length).toBeGreaterThan(0);
      expect(measured.every((e) => e.status === 'BROKEN')).toBe(true);
      expect(measured.every((e) => /shadow stats line/.test(e.reason))).toBe(
        true,
      );

      // And the run must NOT analyze as a clean 0-miss report: zero selective
      // decisions trips the degeneration guard (loud failure, not vacuous 0).
      await expect(
        analyzeAndReport({ runDir, rootDir: cloneDir }),
      ).rejects.toThrow(NoSelectiveDecisionsError);
    },
    WALK_TIMEOUT,
  );
});

// ===========================================================================
// DEGENERATION-GUARD ASSERTION — a corpus yielding ZERO selective decisions
// across the walk (here: a single warm-up commit, cold cache → full suite) must
// fail loudly (NoSelectiveDecisionsError) AND still write a DEGENERATE
// analysis.md so the expensive walk stays diagnosable without a re-walk.
// ===========================================================================
describe('replay: degeneration guard (zero selective decisions fails loudly)', () => {
  test(
    'an all-full-suite walk throws and still writes a DEGENERATE analysis.md',
    async () => {
      const base = await initRepo('replay-degen-', baselineFiles());
      const c0 = await commitAll(base, 'C0 init');
      writeRepoFile(base, 'src/a.ts', 'export const a = 1; // warm-up\n');
      const cTip = await commitAll(base, 'C1 warm-up only (no selective)');

      const { runDir, cloneDir, entries } = await walk(base, `${c0}..${cTip}`, {
        withDist: true,
      });

      // The single measured commit is a cold-cache full-suite — no selective.
      const okEntries = entries.filter((e) => e.status === 'ok');
      expect(okEntries.length).toBe(1);
      expect(okEntries[0].decision?.action).toBe('shadow-full-suite');

      await expect(
        analyzeAndReport({ runDir, rootDir: cloneDir }),
      ).rejects.toThrow(NoSelectiveDecisionsError);

      // The diagnosis is written before the rethrow (walks are ~320s/commit for
      // real corpora — diagnosing must never require a re-walk).
      const reportPath = path.join(runDir, 'analysis.md');
      expect(existsSync(reportPath)).toBe(true);
      const md = readFileSync(reportPath, 'utf-8');
      expect(md).toMatch(/DEGENERATE/);
      expect(md).toMatch(/shadow-full-suite/); // segmentation table
      expect(md).toMatch(/--analyze-only/); // recovery instruction
    },
    WALK_TIMEOUT,
  );
});
