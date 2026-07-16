/// <reference types="vitest/config" />
import type { Plugin } from 'vite';
import type { Reporter, TestRunEndReason } from 'vitest/reporters';
import type { TestModule } from 'vitest/node';
import { existsSync, statSync, appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { glob } from 'tinyglobby';
import { deltaParseNewImports } from './graph/builder.js';
import { loadCachedReverseMap, saveCacheSync } from './graph/cache.js';
import type { CacheMeta } from './graph/cache.js';
import { normalizeModuleId, safeLabel, toCanonicalPath } from './graph/normalize.js';
import { getChangedFiles } from './git.js';
import { bfsAffectedTestsWithProvenance } from './selector.js';
import type { SelectionTrail } from './selector.js';
import { filterRelevantChangedFiles, isRootConfigFile, matchesAnyRule, toRepoRelative } from './changed-files.js';
import { mergeRuntimeEdges } from './runtime-merge.js';
import type { ReverseMap } from './graph/types.js';

/**
 * Narrow shape of the Vitest 4 `experimental.importDurations` config block.
 * Defined locally because v3.2 types don't include this field.
 */
interface ExperimentalImportDurations {
  importDurations?: {
    limit?: number;
    print?: boolean | 'on-warn';
    failOnDanger?: boolean;
    thresholds?: { warn?: number; danger?: number };
  };
}

export interface VitestAffectedOptions {
  disabled?: boolean;
  /**
   * Shadow-verification mode: run the FULL decision pipeline but never mutate
   * `project.config.include`, so a single `vitest run` yields ground truth (all
   * tests) alongside the would-be selection in the stats line. The env var
   * `VITEST_AFFECTED_SHADOW=1` activates shadow regardless of this option.
   * `VITEST_AFFECTED_DISABLED=1` still wins over shadow (fully inert).
   */
  shadow?: boolean;
  ref?: string;
  changedFiles?: string[];
  verbose?: boolean;
  threshold?: number;
  allowNoTests?: boolean; // If true, allow selecting 0 tests (default: false — runs full suite instead)
  cache?: boolean; // Enable graph caching (default: true)
  /**
   * Path to append JSON-line stats after each run (e.g.
   * '.vitest-affected/stats.jsonl'). Consumers/harnesses filter by `action`.
   *
   * TWO LINE CLASSES:
   * - DECISION lines — exactly ONE per `configureVitest` exit when a stats path
   *   is known. `action` is `selective` / `full-suite` (or under shadow mode,
   *   `shadow-selective` / `shadow-full-suite`). These carry the decision fields
   *   (`reason`, `changedFiles`, `deletedFiles`, `ignoredFiles`, `affectedTests`,
   *   `totalTests`, `graphSize`, `cacheHit`, `durationMs`, and under shadow
   *   `selectedFiles`).
   * - DIAGNOSTIC lines — 0..n per run, always `action: "heartbeat"`. Mostly
   *   emitted by the runtime reporter AFTER the run, so they carry ONLY fields
   *   meaningful there: `timestamp`, `action`, `reason`, plus `strayCount` on
   *   `reason: "selection-mismatch"`. They deliberately do NOT reuse decision
   *   fields (`graphSize` / `affectedTests` / `changedFiles` / `cacheHit`) — that
   *   semantics does not transfer to a post-run diagnostic. ONE diagnostic is
   *   emitted PRE-run instead: `reason: "cache-stale"` (staleness
   *   reconciliation), fired from inside `configureVitest` right after the cache
   *   loads because its trigger (cache metadata age / selective-run count) is
   *   known then, not post-run. It carries `staleCacheDays`, `cacheAgeDays`, and
   *   `selectiveRunCount`. It is a recommendation only — the plugin never
   *   force-runs the full suite (that would surprise a user mid-flow); the
   *   accompanying decision line still reflects the normal selection.
   */
  statsFile?: string;
  /**
   * Additional path prefixes or regexes to ignore from changed-file analysis.
   * Applied on top of built-in defaults (.claude/, .git/, .next/, etc).
   */
  ignoreChangedFiles?: Array<string | RegExp>;
  /**
   * Override the default extension allowlist for relevance.
   * Default: .ts, .tsx, .js, .jsx, .mts, .cts, .mjs, .cjs, .json
   */
  includeChangedExtensions?: string[];
  /**
   * If true, skip plugin-side filtering when the caller passes `changedFiles`
   * explicitly. Default false — explicit changedFiles still benefit from the
   * filter so callers don't have to reimplement the policy.
   */
  respectProvidedChangedFiles?: boolean;
  /**
   * Paths that, when changed, force a full-suite run — an escape hatch for
   * dependencies the import graph cannot see (test fixtures read via
   * `fs.readFile`, assets imported through Vite `assetsInclude`, generated
   * data, etc). Without this, changing such a file selects too FEW tests
   * (under-run / false negative) because no import edge points back to its
   * dependents.
   *
   * Each rule is a string (exact path or directory prefix, e.g.
   * `__tests__/fixtures`) or a RegExp (e.g. `/\.md$/`), matched against the
   * repo-relative path — identical semantics to `ignoreChangedFiles`. Checked
   * on the raw changed set BEFORE relevance filtering, so a trigger whose
   * extension isn't in the relevance allowlist (e.g. `.md`, `.yaml`) still
   * fires. Conservative by design: it over-runs (full suite) rather than risk
   * an under-run. Default: none (opt-in).
   */
  fullSuiteTriggers?: Array<string | RegExp>;
  /**
   * Test files that are always unioned into the selected set on every
   * SELECTIVE run, unconditionally — a bounded, user-declared list for tests
   * whose dependency surface is effectively the whole tree (repo-wide
   * scanners, snapshot-everything suites) where no single import edge is
   * meaningful and the cost of always paying for them is accepted. Each entry
   * is a path (absolute or rootDir-relative) to a single test file, resolved
   * and canonicalized exactly like `changedFiles`.
   *
   * FAILURE DIRECTION: checked once, right after `rootDir` resolves — if any
   * entry does not exist on disk, the plugin warns loudly and falls back to
   * the full suite for that run (reason `always-run-config-error`) rather
   * than silently dropping the guarantee for a typo'd or moved path.
   *
   * The union is applied AFTER the affected/total threshold check — these
   * entries are intentionally exempt from that ratio gate — but IS reflected
   * in `project.config.include`, the self-verify heartbeat's selected set
   * (via `setSelectedTests`), and the decision line's `selectedFiles`. A
   * no-op on FULL-SUITE decisions (already included by definition) and never
   * mutates `include` under shadow mode. Default: none (opt-in).
   */
  alwaysRunTests?: string[];
  /**
   * When true, a `selective` DECISION stats line additionally carries an
   * `explain` field: `{ [testPath]: { seed, chain } }` — for every selected
   * test, the changed/deleted seed it was reached from and the full edge chain
   * (seed → … → test) that caused its selection. OFF by default to keep stats
   * lines small; a chain per test can be large on deep graphs. Paths are the
   * same absolute canonical paths as `selectedFiles`. The companion
   * `vitest-affected-explain <testfile>` CLI answers the same "why / why-not"
   * question ad hoc against the cache + current git state.
   */
  explain?: boolean;
  /**
   * STALENESS RECONCILIATION threshold — age half. When the cache's
   * `lastFullRebuild` is older than this many days, the plugin emits a loud
   * `console.warn` + a `cache-stale` DIAGNOSTIC stats line recommending a full
   * run (it never force-runs the full suite — that would surprise a user
   * mid-flow; see the docs on the DECISION vs DIAGNOSTIC taxonomy). A full-suite
   * run naturally refreshes the runtime map and resets the metadata. Default 14.
   */
  staleCacheDays?: number;
  /**
   * STALENESS RECONCILIATION threshold — run-count half. When more than this
   * many SELECTIVE runs have accumulated since the last full rebuild (the graph
   * drifting through many partial updates), the same `cache-stale` warning +
   * stats line fire. Default 50.
   */
  maxSelectiveRuns?: number;
}

/** Default age threshold (days) for the staleness warning. */
const DEFAULT_STALE_CACHE_DAYS = 14;
/** Default selective-run-count threshold for the staleness warning. */
const DEFAULT_MAX_SELECTIVE_RUNS = 50;
const MS_PER_DAY = 1000 * 60 * 60 * 24;

/**
 * Config file basenames that, when changed, should trigger a full test suite run.
 * Changes to these files affect the entire project rather than specific modules.
 */
const CONFIG_BASENAMES = new Set([
  'package.json',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'tsconfig.json',
  'vitest.config.ts',
  'vitest.config.js',
  'vitest.config.mts',
  'vitest.config.mjs',
  'vitest.config.cts',
  'vitest.config.cjs',
  'vitest.workspace.ts',
  'vitest.workspace.js',
  'vitest.workspace.mts',
  'vitest.workspace.mjs',
  'vitest.workspace.cts',
  'vitest.workspace.cjs',
  'vite.config.ts',
  'vite.config.js',
  'vite.config.mts',
  'vite.config.mjs',
  'vite.config.cts',
  'vite.config.cjs',
]);

/**
 * Above this many test modules, a zero-edge run is treated as real starvation
 * and warned loudly on the console. A full-suite-scale run (many modules) that
 * collects ZERO in-project edges is the v0.5.0 `importDurations` regression
 * signature. A small selective run (1..N modules) can legitimately yield zero
 * in-project edges when its tests import only third-party modules — that stays
 * quiet on the console (the stats line is always emitted regardless, so the
 * machine signal is never lost).
 */
const ZERO_EDGE_STARVATION_MODULE_THRESHOLD = 5;

/**
 * @internal
 * Creates a Vitest reporter that collects runtime dependency edges
 * by reading importDurations from each TestModule after it runs.
 *
 * Returns the reporter object and a setRootDir function to call once the
 * resolved rootDir is known (deferred because config() runs before configureVitest()).
 */
export function createRuntimeReporter(
  onEdgesCollected: (
    edges: ReverseMap,
    wasFullSuiteRun: boolean,
  ) => void,
  diagnostics: {
    /**
     * Called on a COMPLETED run (reason !== 'interrupted', no unhandled errors)
     * where test modules actually ran (testModules.length > 0) yet the reporter
     * collected ZERO dependency edges across every module. The universal
     * silent-starvation net: whatever the cause — importDurations disabled
     * (Vitest 4's `limit` default 0, the v0.5.0 regression), the reporter
     * detached, config gating, or the importDurations API drifting to a shape
     * we can't read — the symptom is always the same (no edges), and it must be
     * observable rather than silently swallowed. Subsumes the spec's runtime
     * "importDurations presence/shape on first module" check: any shape drift
     * that breaks edge collection lands here as a zero-edge run.
     *
     * `testModuleCount` is the number of test modules that ran — the callback
     * uses it to distinguish a full-suite-scale starvation (loud) from a small
     * selective run that legitimately imports only third-party modules (quiet).
     */
    onZeroEdgeRun?: (testModuleCount: number) => void;
    /**
     * Called after a SELECTIVE run when one or more test modules ran that were
     * NOT in the selected set (ran-tests ⊄ selected). Signals the include
     * mutation silently lost effect (e.g. a future Vitest ignoring
     * `project.config.include`). `strays` are canonical paths of the offenders.
     */
    onSelectionMismatch?: (strays: string[]) => void;
  } = {},
): {
  reporter: Reporter;
  setRootDir: (dir: string) => void;
  setSelectedTests: (tests: string[]) => void;
} {
  let rootDir: string | null = null;
  const runtimeReverse: ReverseMap = new Map();
  // Canonical paths of every test module observed this run — the ran-tests set
  // for selection self-verify. Reset at each (non-interrupted) run end,
  // mirroring runtimeReverse.
  const ranTests = new Set<string>();
  // The selected set the plugin applied to project.config.include (canonical
  // paths). `null` = no selective decision was applied this run (full-suite,
  // shadow mode, or not yet decided) → self-verify is skipped.
  let selectedTests: string[] | null = null;
  // Whether the NEXT completed run is the first of this process. `configureVitest`
  // runs ONCE per process; on watch-mode re-runs Vitest re-scopes to its own
  // subset without the plugin re-selecting (and selectedTests has been reset to
  // null below), so only the first completed run may be treated as a genuine
  // full-suite rebuild. Every subsequent re-run takes the selective path,
  // regardless of selectedTests. Flipped false after the first non-interrupted
  // run end.
  let isFirstRun = true;

  function setRootDir(dir: string): void {
    rootDir = dir;
  }

  function setSelectedTests(tests: string[]): void {
    selectedTests = tests;
  }

  function onTestModuleEnd(testModule: TestModule): void {
    const rawTestPath = normalizeModuleId(testModule.moduleId);

    // Guard: rootDir not yet set
    if (!rootDir) return;

    // Guard: virtual module IDs are not absolute paths. Checked BEFORE
    // canonicalizing — a non-absolute id (e.g. "virtual:mod") is not a real
    // fs path, and realpathSync's nearest-ancestor fallback would otherwise
    // walk it up to cwd and fabricate a bogus absolute path.
    if (!path.isAbsolute(rawTestPath)) return;
    const testPath = toCanonicalPath(rawTestPath);
    // Record every real test module that ran — the ran-tests set consumed by
    // selection self-verify at run end.
    ranTests.add(testPath);

    const { importDurations } = testModule.diagnostic();
    // rootDir is canonicalized once at plugin init; reuse that form here.
    const rootPrefix = rootDir.endsWith('/') ? rootDir : rootDir + '/';

    for (const rawPath of Object.keys(importDurations)) {
      const rawModulePath = normalizeModuleId(rawPath);
      // Must be absolute (see guard above for why this precedes canonicalization)
      if (!path.isAbsolute(rawModulePath)) continue;
      // Skip node_modules before canonicalizing — cheap substring check avoids
      // a realpathSync syscall for the (often numerous) dependency modules.
      if (rawModulePath.includes('/node_modules/')) continue;
      const modulePath = toCanonicalPath(rawModulePath);
      // Must be under rootDir
      if (!modulePath.startsWith(rootPrefix)) continue;
      // Skip self-reference
      if (modulePath === testPath) continue;

      // Add reverse edge: modulePath → Set<testPath>
      if (!runtimeReverse.has(modulePath)) {
        runtimeReverse.set(modulePath, new Set());
      }
      runtimeReverse.get(modulePath)!.add(testPath);
    }
  }

  function onTestRunEnd(
    testModules: ReadonlyArray<TestModule>,
    errors: ReadonlyArray<unknown>,
    reason: TestRunEndReason,
  ): void {
    // Interrupt: skip persistence, diagnostics, and clear. `vitest list`
    // constructs the reporter but never calls onTestRunEnd, so it cannot
    // produce a false-positive heartbeat here either.
    if (reason === 'interrupted') return;

    // Was this a full-suite REBUILD? Two conditions must BOTH hold:
    //   1. selectedTests === null — no selective decision was applied (full-suite
    //      fallback, or shadow mode where all tests run), so the runtime map is
    //      (near) fully re-observed.
    //   2. isFirstRun — this is the FIRST completed run of the process. In watch
    //      mode configureVitest does NOT re-run, so selectedTests is reset to
    //      null after every run (below); a Vitest-chosen subset re-run would then
    //      spuriously read as a full-suite rebuild and falsely reset the
    //      staleness baseline (lastFullRebuild=now, runCount=0) while most edges
    //      stay stale — neutralizing the staleness warning in the primary dev
    //      workflow. Gating on the first run keeps genuine single-shot full-suite
    //      runs (disabled/fallback) correct while routing every watch re-run down
    //      the selective path (bump runCount, keep lastFullRebuild).
    // Captured BEFORE the resets below. A selective run (selectedTests !== null,
    // including the allow-no-tests empty set) or any watch re-run only partially
    // refreshes the map and instead ages the metadata.
    const wasFullSuiteRun = selectedTests === null && isFirstRun;
    isFirstRun = false;

    // SELECTION SELF-VERIFY: a selective decision was applied this run, so
    // every test that ran must be in the selected set. A stray means the
    // include mutation silently lost effect (Vitest ran tests we did not
    // select) — surface it loudly rather than trust a selection Vitest ignored.
    if (selectedTests !== null && diagnostics.onSelectionMismatch) {
      const selectedSet = new Set(selectedTests);
      const strays = [...ranTests].filter((t) => !selectedSet.has(t));
      if (strays.length > 0) diagnostics.onSelectionMismatch(strays);
    }
    // ONE-SHOT self-verify: the selection this run was checked against covers
    // exactly this run. Reset so a later watch re-run — which Vitest may
    // legitimately re-scope to a different set — is not checked against a stale
    // selection and does not fire a false 'selection-mismatch'. A fresh
    // selective decision re-arms it via setSelectedTests().
    selectedTests = null;

    if (runtimeReverse.size > 0) {
      // Snapshot: pass a copy so clear() doesn't affect the callback's data
      const snapshot = new Map(
        [...runtimeReverse].map(([k, v]) => [k, new Set(v)]),
      );
      onEdgesCollected(snapshot, wasFullSuiteRun);
    } else if (
      testModules.length > 0 &&
      errors.length === 0 &&
      diagnostics.onZeroEdgeRun
    ) {
      // ZERO-EDGE HEARTBEAT: tests ran to completion (modules present, no
      // unhandled errors) yet produced no edges. Distinct from an empty
      // selection (testModules.length === 0), which is a legitimate no-run.
      diagnostics.onZeroEdgeRun(testModules.length);
    }

    runtimeReverse.clear();
    ranTests.clear();
  }

  const reporter: Reporter = {
    onTestModuleEnd,
    onTestRunEnd,
  };

  return { reporter, setRootDir, setSelectedTests };
}

function writeStatsLine(
  statsFile: string,
  rootDir: string,
  data: {
    action: string;
    reason?: string;
    changedFiles?: number;
    deletedFiles?: number;
    ignoredFiles?: number;
    affectedTests?: number;
    totalTests?: number;
    graphSize?: number;
    cacheHit?: boolean;
    durationMs?: number;
    strayCount?: number;
    selectedFiles?: string[] | null;
    explain?: Record<string, SelectionTrail>;
    staleCacheDays?: number;
    cacheAgeDays?: number;
    selectiveRunCount?: number;
  },
  verbose = false,
  shadow = false,
): void {
  try {
    const filePath = path.isAbsolute(statsFile) ? statsFile : path.resolve(rootDir, statsFile);
    mkdirSync(path.dirname(filePath), { recursive: true });
    // Strip selectedFiles from the base payload; it only surfaces under shadow.
    const { selectedFiles, ...rest } = data;
    let payload: Record<string, unknown>;
    if (shadow) {
      // Remap the action into the shadow namespace, retaining the ORIGINAL
      // reason so downstream fallback-frequency segmentation still works.
      // shadow-selective carries the would-be selection; shadow-full-suite
      // carries null (meaning "all tests").
      const shadowAction =
        rest.action === 'selective' ? 'shadow-selective' : 'shadow-full-suite';
      const shadowSelected =
        rest.action === 'selective' ? (selectedFiles ?? []) : null;
      payload = { ...rest, action: shadowAction, selectedFiles: shadowSelected };
    } else {
      payload = { ...rest };
    }
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...payload });
    appendFileSync(filePath, line + '\n');
  } catch (err) {
    // Best-effort — never crash on stats writing
    if (verbose) {
      console.warn(
        `[vitest-affected] Failed to write stats: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/**
 * Ambient stats-emission context threaded into {@link emitStats}. Built once per
 * `configureVitest` invocation; `rootDir` is a mutable field (starts at cwd,
 * reassigned to the canonical config root once resolved) so early exits and later
 * ones both resolve relative stats paths from the right base without rebuilding
 * the object. Stable identity — captured by the runtime reporter's post-run
 * diagnostic closures too.
 */
interface EmitStatsCtx {
  statsFile?: string;
  rootDir: string;
  verbose: boolean;
  shadow: boolean;
}

/**
 * Shared stats-emission helper — the single funnel replacing every `if
 * (statsFile) writeStatsLine(...)` call site. No-op when no stats path is
 * configured. `shadowFlag` defaults to the ambient `shadow` mode but the post-run
 * reporter diagnostics (heartbeat lines) pass `false` explicitly — they are never
 * remapped into the shadow-selective/shadow-full-suite namespace.
 */
function emitStats(
  ctx: EmitStatsCtx,
  action: string,
  reason?: string,
  extra?: Record<string, unknown>,
  shadowFlag: boolean = ctx.shadow,
): void {
  if (!ctx.statsFile) return;
  writeStatsLine(
    ctx.statsFile,
    ctx.rootDir,
    { action, reason, ...extra },
    ctx.verbose,
    shadowFlag,
  );
}

/**
 * Resolve a possibly-relative config-supplied path against `rootDir` and
 * canonicalize it — the shared convergence step so caller-provided paths
 * (changedFiles, alwaysRunTests, setupFiles/globalSetup entries) land on the
 * same path identity as every other graph key.
 */
function resolveConfigPath(rootDir: string, p: string): string {
  return toCanonicalPath(path.isAbsolute(p) ? p : path.resolve(rootDir, p));
}

/**
 * True when `p` exists on disk AND is a regular file — not a directory or
 * other non-file entry. Swallows the stat error for a missing path rather
 * than letting it propagate, since "doesn't exist" and "isn't a file" are
 * both just "not usable" to every caller.
 */
function isExistingFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Twin-block helper: resolve a `string | string[]` config field
 * (setupFiles/globalSetup) into a canonicalized Set, check it against the RAW
 * changed+deleted set, and on a hit warn + emit the full-suite stats line.
 * Returns true so the caller can early-return.
 */
function checkFullSuiteConfigField(
  rawField: string | string[] | undefined,
  warnMessage: string,
  reason: string,
  rootDir: string,
  rawChanged: string[],
  changedCount: number,
  deletedCount: number,
  graphSize: number,
  startMs: number,
  statsCtx: EmitStatsCtx,
): boolean {
  const fieldRaw = rawField ?? [];
  const fieldSet = new Set(
    (Array.isArray(fieldRaw) ? fieldRaw : [fieldRaw]).map((f) =>
      resolveConfigPath(rootDir, f),
    ),
  );
  if (rawChanged.some((f) => fieldSet.has(f))) {
    console.warn(warnMessage);
    emitStats(statsCtx, 'full-suite', reason, {
      changedFiles: changedCount, deletedFiles: deletedCount,
      graphSize, durationMs: Date.now() - startMs,
    });
    return true;
  }
  return false;
}

/**
 * Union the graph-selected tests with the configured alwaysRunTests list,
 * de-duplicated. Both inputs are already canonicalized, so a plain Set is
 * sufficient (no path-normalization needed at this join point).
 */
function unionAlwaysRun(selected: string[], alwaysRunTests: string[]): string[] {
  return [...new Set([...selected, ...alwaysRunTests])];
}

/**
 * Build the `explain` field for a set of selected tests, filtered to the
 * provenance the BFS recorded. Returns undefined when explain is off so the field
 * never appears on default stats lines.
 */
function buildExplain(
  tests: string[],
  explain: boolean | undefined,
  provenance: Map<string, SelectionTrail>,
): Record<string, SelectionTrail> | undefined {
  if (!explain) return undefined;
  const out: Record<string, SelectionTrail> = {};
  for (const t of tests) {
    const trail = provenance.get(t);
    if (trail) out[t] = trail;
  }
  return out;
}

export function vitestAffected(options: VitestAffectedOptions = {}): Plugin {
  // Hoisted state — shared between config() and configureVitest()
  let reverse: ReverseMap = new Map();
  let cacheDir: string | undefined;

  return {
    name: 'vitest-affected',

    async configureVitest({ vitest, project }) {
      // 1. Env overrides + mode resolution — hoisted ABOVE the try so the
      // catch-all and every early return can emit a stats line.
      let { disabled = false } = options;
      if (process.env.VITEST_AFFECTED_DISABLED === '1') {
        disabled = true;
      }
      let { shadow = false } = options;
      if (process.env.VITEST_AFFECTED_SHADOW === '1') {
        shadow = true;
      }
      const verbose = options.verbose ?? false;
      const startMs = Date.now();

      // Stats path: the env override wins over config so historical consumer
      // configs cannot starve emission. Resolved here (before rootDir is known)
      // so the catch-all can still emit; rootDir starts at cwd and is refined
      // once vitest.config.root resolves.
      const statsFile = process.env.VITEST_AFFECTED_STATS_FILE ?? options.statsFile;
      // Ambient stats-emission context, passed to the module-level `emitStats`.
      // `rootDir` is canonicalized (the same path-identity boundary every other
      // path in the plugin routes through). It starts at a cwd fallback so the
      // catch-all can always resolve a relative/default statsFile, but is then
      // root-anchored BELOW — before ANY guard emits — whenever vitest.config.root
      // is present. The cwd fallback is retained ONLY for the genuinely-rootless
      // case (vitest.config.root absent): there is then no root to resolve to.
      const statsCtx: EmitStatsCtx = {
        statsFile,
        rootDir: toCanonicalPath(process.cwd()),
        verbose,
        shadow,
      };

      // Root-anchor the stats path as early as possible (wlm.13). The
      // workspace guard (step 3) and config-shape guard (step 4) both emit
      // BEFORE rootDir is reassigned at step 4a — so with cwd != config root and
      // a relative/default statsFile, those two decision lines would land in
      // <cwd>/.vitest-affected/stats.jsonl while every normal line lands in
      // <root>/..., and a harness segmenting on full-suite fallback events would
      // silently lose exactly those two. Resolving here, guarded on truthiness,
      // fixes the workspace guard AND any config-shape exit triggered by the
      // other three falsy checks while root is present.
      if (vitest.config?.root) {
        statsCtx.rootDir = toCanonicalPath(vitest.config.root);
      }

      try {
        // 2. Disabled check — rollback switch is fully inert: emits NOTHING.
        if (disabled) {
          return;
        }

        // 3. Workspace guard
        if (vitest.projects.length > 1) {
          console.warn(
            '[vitest-affected] Workspace with multiple projects detected — skipping test selection, running full suite',
          );
          emitStats(statsCtx, 'full-suite', 'workspace', {
            durationMs: Date.now() - startMs,
          });
          return;
        }

        // 4. Config shape validation
        if (
          !vitest.config ||
          !vitest.config.root ||
          !project.config ||
          !project.config.include
        ) {
          console.warn(
            '[vitest-affected] Unexpected config shape — running full suite',
          );
          emitStats(statsCtx, 'full-suite', 'config-shape', {
            durationMs: Date.now() - startMs,
          });
          return;
        }

        // Canonicalize once at the source: every downstream graph key (cache
        // load, resolver output, reporter module paths, changed-file resolution,
        // test-file glob) is built from or compared against this rootDir. A
        // symlinked project root (or macOS's /var → /private/var temp alias)
        // would otherwise desync those keys from git-derived changed-file paths,
        // which git itself resolves through symlinks when locating the repo
        // toplevel — a silent under-selection.
        const rootDir = toCanonicalPath(vitest.config.root);
        statsCtx.rootDir = rootDir;

        // 4a. alwaysRunTests missing-path guard. Canonicalize each configured
        // entry the same way options.changedFiles is (step 6 below) so it
        // converges with graph keys. A typo'd or moved path must fail closed to
        // the full suite rather than silently drop the always-run guarantee for
        // that entry. Its own early-return, separate from the pre-rootDir
        // workspace/config-shape guards above: this check needs rootDir to
        // canonicalize relative entries, so it cannot run before rootDir exists.
        let alwaysRunTests: string[] = [];
        if (options.alwaysRunTests?.length) {
          const resolvedAlwaysRun = options.alwaysRunTests.map((p) =>
            resolveConfigPath(rootDir, p),
          );
          // Entries must be FILES, not directories or other non-file entries —
          // a directory would silently never match a single BFS-selected test
          // and would blow up downstream logic that treats every entry as a
          // test module path.
          const missing = resolvedAlwaysRun.filter((p) => !isExistingFile(p));
          if (missing.length > 0) {
            console.warn(
              `[vitest-affected] alwaysRunTests path(s) not found or not a file: ${missing.slice(0, 5).map(safeLabel).join(', ')}${missing.length > 5 ? ` (+${missing.length - 5} more)` : ''} — running full suite`,
            );
            emitStats(statsCtx, 'full-suite', 'always-run-config-error', {
              durationMs: Date.now() - startMs,
            });
            return;
          }
          alwaysRunTests = resolvedAlwaysRun;
        }

        // Vitest 4 gates getImportDurations() on experimental.importDurations.limit
        // (defaults to 0 → empty result → reverse-graph reporter sees nothing →
        // cache never populates → silent full-suite fallback forever). Force-enable
        // here. Spread to avoid mutating the default object reference, which is
        // shared across workspace projects in v4 (cli-api: line ~10293).
        // On Vitest 3.2.x this field is harmless: getImportDurations() ignores it.
        const exp = (project.config as { experimental?: ExperimentalImportDurations })
          .experimental;
        if (exp && exp.importDurations !== undefined) {
          // IMPORTDURATIONS SHAPE-CHECK. importDurations is explicitly
          // experimental upstream and was recently expanded (print/failOnDanger/
          // thresholds) — shape drift is expected, not hypothetical. We tolerate
          // ADDITIVE drift (unknown/new fields) but bail loudly on STRUCTURAL
          // drift that would break the force-enable write below: importDurations
          // must be a plain object, and if `limit` is present it must be a
          // number (we overwrite it). Anything else means we cannot trust the
          // runtime import data → full-suite fallback, never a silent no-op.
          const id: unknown = exp.importDurations;
          const isPlainObject =
            typeof id === 'object' && id !== null && !Array.isArray(id);
          const limitOk =
            isPlainObject &&
            (!('limit' in (id as object)) ||
              typeof (id as { limit?: unknown }).limit === 'number');
          if (!isPlainObject || !limitOk) {
            console.warn(
              '[vitest-affected] experimental.importDurations has an unexpected shape — cannot trust runtime import data, running full suite',
            );
            emitStats(statsCtx, 'full-suite', 'import-durations-shape', {
              graphSize: reverse.size, durationMs: Date.now() - startMs,
            });
            return;
          }
        }
        if (exp) {
          exp.importDurations = {
            ...exp.importDurations,
            limit: Number.MAX_SAFE_INTEGER,
          };
        }

        // 5. Load cached reverse map (runtime-first: JSON read, no parsing)
        cacheDir = path.join(rootDir, '.vitest-affected');

        let cacheHit: boolean;
        // Staleness metadata — mutable `let` so the reporter closure can update
        // it across watch-mode re-runs. Defaults to no-baseline zeros.
        let cacheMeta: CacheMeta = { lastFullRebuild: 0, runCount: 0 };
        if (options.cache !== false) {
          ({ reverse, hit: cacheHit, meta: cacheMeta } = loadCachedReverseMap(cacheDir, rootDir, verbose));
        } else {
          reverse = new Map();
          cacheHit = false;
        }

        // STALENESS RECONCILIATION — emitted PRE-run because the trigger (cache
        // metadata) is known now, not after the run. Only fires when a baseline
        // exists (lastFullRebuild > 0): a freshly-migrated v2/v1 cache or a
        // pre-metadata v3 cache has none, so it is not flagged until its first
        // full-suite run seeds the timestamp. A WARNING only — never a forced
        // full suite (that would surprise a user mid-flow); the normal decision
        // line still follows.
        const staleCacheDays = options.staleCacheDays ?? DEFAULT_STALE_CACHE_DAYS;
        const maxSelectiveRuns = options.maxSelectiveRuns ?? DEFAULT_MAX_SELECTIVE_RUNS;
        if (cacheMeta.lastFullRebuild > 0) {
          const cacheAgeDays = (Date.now() - cacheMeta.lastFullRebuild) / MS_PER_DAY;
          const agedOut = cacheAgeDays > staleCacheDays;
          const runOut = cacheMeta.runCount > maxSelectiveRuns;
          if (agedOut || runOut) {
            console.warn(
              `[vitest-affected] CACHE STALE: the dependency graph was last fully rebuilt ${cacheAgeDays.toFixed(1)} day(s) ago across ${cacheMeta.runCount} selective run(s) ` +
                `(thresholds: ${staleCacheDays}d / ${maxSelectiveRuns} runs). Selective runs only refresh edges for the tests that ran, so the graph can drift. ` +
                'Run the FULL suite once (e.g. clear .vitest-affected or run without changes) to re-observe every edge and reset the baseline. Continuing with selective selection for now.',
            );
            emitStats(statsCtx, 'heartbeat', 'cache-stale', {
              staleCacheDays,
              cacheAgeDays: Number(cacheAgeDays.toFixed(2)),
              selectiveRunCount: cacheMeta.runCount,
            }, false);
          }
        }

        // Inject runtime reporter that merges runtime edges into cached reverse map.
        // On selective runs only a subset of tests execute, so we merge new edges
        // into the existing cache rather than replacing it (which would destroy
        // graph data for tests that didn't run this time).
        const { reporter, setRootDir, setSelectedTests } = createRuntimeReporter(
          (edges, wasFullSuiteRun) => {
            if (!cacheDir) return;
            try {
              // Per-test overwrite for every test that ran this cycle: strip
              // stale edges, merge fresh ones (so removed imports are reflected,
              // not accumulated forever). Persistence stays here at the call-site.
              reverse = mergeRuntimeEdges(reverse, edges, 'all');
              // STALENESS METADATA update: a full-suite run re-observes (near)
              // every edge → reset the baseline (now / 0). A selective run only
              // partially refreshes → preserve lastFullRebuild, bump runCount.
              // Reassign cacheMeta so a later watch re-run reads the fresh value.
              cacheMeta = wasFullSuiteRun
                ? { lastFullRebuild: Date.now(), runCount: 0 }
                : {
                    lastFullRebuild: cacheMeta.lastFullRebuild,
                    runCount: cacheMeta.runCount + 1,
                  };
              saveCacheSync(cacheDir, reverse, cacheMeta);
            } catch {
              // Best-effort: runtime edge persistence failed — cache will be stale next run
            }
          },
          {
            // ZERO-EDGE HEARTBEAT — fires post-run; statsFile/rootDir are
            // captured into this closure because the reporter runs AFTER
            // configureVitest returns. Emitted with shadow=false: this is a
            // post-run diagnostic, not a selection decision, so it must NOT be
            // remapped into the shadow-selective/shadow-full-suite namespace.
            onZeroEdgeRun: (testModuleCount) => {
              // Machine signal ALWAYS emitted; the loud console.warn is scoped to
              // starvation-scale runs so a small third-party-only selective run
              // stays quiet on the console.
              if (testModuleCount > ZERO_EDGE_STARVATION_MODULE_THRESHOLD) {
                console.warn(
                  '[vitest-affected] HEARTBEAT: a completed test run collected ZERO ' +
                    'dependency edges from importDurations across all modules. The reverse ' +
                    'graph cannot be built or updated, so selection will fall back to the ' +
                    'full suite indefinitely. This is the silent-starvation signal — verify ' +
                    "that Vitest's importDurations collection is enabled and its API is intact.",
                );
              }
              emitStats(statsCtx, 'heartbeat', 'zero-edges', undefined, false);
            },
            // SELECTION SELF-VERIFY mismatch — same post-run diagnostic contract.
            onSelectionMismatch: (strays) => {
              console.warn(
                `[vitest-affected] SELF-VERIFY FAILED: ${strays.length} test(s) ran that were NOT in the selected set — the include mutation silently lost effect (Vitest ran tests we did not select). First offenders: ${strays.slice(0, 5).map(safeLabel).join(', ')}${strays.length > 5 ? ` (+${strays.length - 5} more)` : ''}`,
              );
              emitStats(statsCtx, 'heartbeat', 'selection-mismatch', {
                strayCount: strays.length,
              }, false);
            },
          },
        );
        setRootDir(rootDir);

        // configureVitest fires BEFORE Vitest's createReporters assigns vitest.reporters.
        // A direct push onto the current (empty) array is lost when createReporters
        // overwrites it with a new array. Use a property setter to intercept that
        // assignment and append our reporter to whatever Vitest creates.
        const vitestAny = vitest as unknown as { reporters: Reporter[] };
        try {
          let _reporters = vitestAny.reporters;
          _reporters.push(reporter);
          Object.defineProperty(vitest, 'reporters', {
            configurable: true,
            enumerable: true,
            get() { return _reporters; },
            set(value: Reporter[]) {
              _reporters = value;
              if (!value.includes(reporter)) {
                value.push(reporter);
              }
            },
          });
        } catch {
          // Fallback: direct push (works in unit tests with plain mock objects)
          vitestAny.reporters.push(reporter);
        }

        // Register watch-mode filter: pass-through (Vitest's own module graph handles it)
        if (vitest.config.watch) {
          vitest.onFilterWatchedSpecification(() => true);
        }

        // 6. Get changed files
        let changed: string[];
        let deleted: string[];
        const changedFromCaller = options.changedFiles !== undefined;

        if (changedFromCaller) {
          // Resolve relative paths to rootDir and canonicalize so caller-provided
          // paths converge with graph keys the same way git-derived ones do.
          const resolved = options.changedFiles!.map((f) => resolveConfigPath(rootDir, f));
          changed = resolved.filter((f) => existsSync(f));
          deleted = resolved.filter((f) => !existsSync(f));
        } else {
          const result = await getChangedFiles(rootDir, options.ref);
          changed = result.changed;
          deleted = result.deleted;
        }

        // 6a. Full-suite triggers — checked on the RAW changed set before the
        // relevance filter below, since a trigger (e.g. a `.md` or `.yaml`
        // fixture) may have an extension the filter would otherwise drop. These
        // cover dependencies invisible to the import graph (fs-read fixtures,
        // assets), where the safe failure mode is to over-run.
        if (options.fullSuiteTriggers?.length) {
          const triggerHit = [...changed, ...deleted].find((f) =>
            matchesAnyRule(toRepoRelative(f, rootDir), options.fullSuiteTriggers!),
          );
          if (triggerHit) {
            console.warn(
              `[vitest-affected] Full-suite trigger matched (${safeLabel(toRepoRelative(triggerHit, rootDir))}) — running full suite`,
            );
            emitStats(statsCtx, 'full-suite', 'full-suite-trigger', {
              changedFiles: changed.length, deletedFiles: deleted.length,
              graphSize: reverse.size, durationMs: Date.now() - startMs,
            });
            return;
          }
        }

        // 6a-bis. setupFiles / globalSetup changes → full suite, evaluated on
        // the RAW changed+deleted set BEFORE relevance filtering — identical
        // placement and reasoning to 6a. A setup or globalSetup file feeds every
        // test, so an ignoreChangedFiles rule (or an irrelevant-extension drop)
        // matching one must NOT silently under-select; the safe failure mode is
        // to over-run. changedFiles/deletedFiles counts are the raw counts here,
        // matching 6a's behavior.
        const rawChangedForSetup = [...changed, ...deleted];

        if (
          checkFullSuiteConfigField(
            project.config.setupFiles,
            '[vitest-affected] Setup file change detected — running full suite',
            'setup-file-change',
            rootDir, rawChangedForSetup, changed.length, deleted.length,
            reverse.size, startMs, statsCtx,
          )
        ) {
          return;
        }

        // globalSetup is a sibling of setupFiles on the resolved config — same
        // string | string[] shape, same relative-path-resolution requirement,
        // same "invisible to the import graph" reasoning. Mirrored exactly.
        if (
          checkFullSuiteConfigField(
            project.config.globalSetup,
            '[vitest-affected] Global setup file change detected — running full suite',
            'global-setup-change',
            rootDir, rawChangedForSetup, changed.length, deleted.length,
            reverse.size, startMs, statsCtx,
          )
        ) {
          return;
        }

        // 6b. Filter irrelevant changed/deleted files before any graph analysis.
        // Caller-provided changedFiles still get filtered unless explicitly opted out.
        let ignoredCount = 0;
        if (!(changedFromCaller && options.respectProvidedChangedFiles)) {
          const filtered = filterRelevantChangedFiles(
            { changed, deleted },
            rootDir,
            {
              ignoreChangedFiles: options.ignoreChangedFiles,
              includeChangedExtensions: options.includeChangedExtensions,
              configBasenames: CONFIG_BASENAMES,
              // The cache is already loaded (step 5) by this point — pass the
              // reverse map so a changed/deleted file already tracked as a
              // graph key (e.g. a CSS-module edge the runtime reporter
              // recorded) survives the extension allowlist. See
              // ChangedFileFilterOptions.graphMembership.
              graphMembership: reverse,
            },
          );
          ignoredCount = filtered.ignored.length;
          changed = filtered.changed;
          deleted = filtered.deleted;
          if (verbose && ignoredCount > 0) {
            console.warn(
              `[vitest-affected] ignored ${ignoredCount} changed file(s) before graph analysis`,
            );
          }
        }

        // 7. No changes check — run full suite
        if (changed.length === 0 && deleted.length === 0) {
          emitStats(statsCtx, 'full-suite', 'no-changes', {
            changedFiles: 0, deletedFiles: 0, ignoredFiles: ignoredCount,
            graphSize: reverse.size,
            durationMs: Date.now() - startMs,
          });
          return;
        }

        // 8. Deleted file handling — treat as BFS seeds
        if (deleted.length > 0 && verbose) {
          console.warn(
            `[vitest-affected] ${deleted.length} deleted file(s) — will include as BFS seeds`,
          );
        }

        // 9. Force-rerun check: config file or setupFiles changes → full suite
        const allChangedFiles = [...changed, ...deleted];
        // Root-anchored: only a config at the repo root (or a shared workspace
        // config above rootDir) forces a full suite. A nested
        // packages/foo/package.json must NOT negate selection — route the
        // absolute path through toRepoRelative and share the predicate with the
        // relevance filter (changed-files.ts) so the two sites never drift.
        const hasConfigChange = allChangedFiles.some((f) =>
          isRootConfigFile(toRepoRelative(f, rootDir), CONFIG_BASENAMES),
        );
        if (hasConfigChange) {
          console.warn(
            '[vitest-affected] Config file change detected — running full suite',
          );
          emitStats(statsCtx, 'full-suite', 'config-change', {
            changedFiles: changed.length, deletedFiles: deleted.length,
            ignoredFiles: ignoredCount,
            graphSize: reverse.size, durationMs: Date.now() - startMs,
          });
          return;
        }

        // 10. Cache miss → full suite (first run collects runtime data)
        if (!cacheHit) {
          if (verbose) {
            console.warn(
              '[vitest-affected] No cached runtime graph — running full suite (will populate cache after run)',
            );
          }
          emitStats(statsCtx, 'full-suite', 'cache-miss', {
            changedFiles: changed.length, deletedFiles: deleted.length,
            ignoredFiles: ignoredCount,
            graphSize: 0, cacheHit: false,
            durationMs: Date.now() - startMs,
          });
          return;
        }

        // 11. Delta parse: find new imports in changed files not yet in cache.
        // Feed resolve.alias (Vite/Vitest config, resolved form) into the
        // resolver so the static parser can see Vite-only aliases (e.g. stub
        // packages) that tsconfig paths don't cover. project.vite is the
        // per-project Vite dev server; its resolved config always exposes
        // resolve.alias as Alias[] (string finds usable, RegExp finds are
        // skipped — see createResolver). Optional-chained defensively: unit
        // tests exercise this hook with plain mock `project` objects that
        // don't carry a `vite` server at all — undefined here is the correct
        // "no alias data available" case, not an error.
        const resolveAlias = project.vite?.config?.resolve?.alias;
        const extraSeeds = deltaParseNewImports(changed, reverse, rootDir, verbose, resolveAlias);
        const bfsSeeds = [...allChangedFiles, ...extraSeeds];

        // 12. Glob test files using project.config.include patterns
        const includePatterns = project.config.include;
        if (!includePatterns || includePatterns.length === 0) {
          console.warn(
            '[vitest-affected] No include patterns configured — running full suite',
          );
          emitStats(statsCtx, 'full-suite', 'no-include-patterns', {
            changedFiles: changed.length, deletedFiles: deleted.length,
            ignoredFiles: ignoredCount,
            graphSize: reverse.size, cacheHit, durationMs: Date.now() - startMs,
          });
          return;
        }

        // Canonicalize glob results so they converge with graph keys built off
        // the same (canonicalized) rootDir. rootDir is already canonical, so
        // for the common (non-symlinked) layout each realpath memo-hits or
        // resolves to itself.
        const testFiles = (await glob(includePatterns, {
          cwd: rootDir,
          absolute: true,
          ignore: [...(project.config.exclude ?? []), '**/node_modules/**'],
        })).map((f) => toCanonicalPath(f));

        const testFileSet = new Set(testFiles);

        // 12a. alwaysRunTests membership guard. An entry that exists on disk
        // but sits outside this project's include/exclude patterns would ride
        // selective-run unions just fine, but a FULL-SUITE decision runs
        // project.config.include verbatim — never alwaysRunTests — so that
        // same entry would silently NOT run whenever the plugin falls back to
        // the full suite. Validating membership against the glob here keeps
        // the option's "always runs" guarantee symmetric across both decision
        // branches, rather than trusting mere on-disk existence (step 4a).
        // Placed before the no-test-files and BFS steps below consume
        // testFiles, so an out-of-pattern entry fails closed before either.
        if (alwaysRunTests.length > 0) {
          const outsidePatterns = alwaysRunTests.filter((p) => !testFileSet.has(p));
          if (outsidePatterns.length > 0) {
            console.warn(
              `[vitest-affected] alwaysRunTests path(s) not matched by this project's include/exclude patterns: ${outsidePatterns.slice(0, 5).map(safeLabel).join(', ')}${outsidePatterns.length > 5 ? ` (+${outsidePatterns.length - 5} more)` : ''} — running full suite`,
            );
            emitStats(statsCtx, 'full-suite', 'always-run-config-error', {
              changedFiles: changed.length, deletedFiles: deleted.length,
              ignoredFiles: ignoredCount,
              graphSize: reverse.size, cacheHit, durationMs: Date.now() - startMs,
            });
            return;
          }
        }

        if (testFiles.length === 0) {
          console.warn(
            '[vitest-affected] No test files matched include patterns — running full suite',
          );
          emitStats(statsCtx, 'full-suite', 'no-test-files', {
            changedFiles: changed.length, deletedFiles: deleted.length,
            ignoredFiles: ignoredCount,
            graphSize: reverse.size, cacheHit, durationMs: Date.now() - startMs,
          });
          return;
        }

        // 13. BFS: find affected tests (with provenance — the explain trail).
        // Provenance is always computed (cheap: a parent map + a chain walk per
        // test) but only surfaced in the stats line when options.explain is set.
        const { tests: affectedTests, provenance } = bfsAffectedTestsWithProvenance(
          bfsSeeds,
          reverse,
          (f) => testFileSet.has(f),
        );

        // 14. Threshold check
        if (affectedTests.length === 0) {
          if (options.allowNoTests) {
            // Union in alwaysRunTests: with zero BFS-affected tests, include
            // must become exactly the alwaysRun list — never [] — when the
            // option is configured.
            const selected = unionAlwaysRun([], alwaysRunTests);
            // Shadow guards the mutation site: compute the decision, never apply it.
            if (!shadow) {
              project.config.include = selected;
              // Record the selected set so self-verify catches a future Vitest
              // that runs something outside it (an empty include, or a run
              // that ignores the alwaysRunTests union).
              setSelectedTests(selected);
            }
            emitStats(statsCtx, 'selective', 'allow-no-tests', {
              changedFiles: changed.length, deletedFiles: deleted.length,
              ignoredFiles: ignoredCount,
              affectedTests: 0, totalTests: testFiles.length,
              graphSize: reverse.size, cacheHit, durationMs: Date.now() - startMs,
              selectedFiles: selected,
              explain: buildExplain([], options.explain, provenance),
            });
            return;
          }
          console.warn(
            '[vitest-affected] No affected tests found — running full suite',
          );
          emitStats(statsCtx, 'full-suite', 'no-affected-tests', {
            changedFiles: changed.length, deletedFiles: deleted.length,
            ignoredFiles: ignoredCount,
            affectedTests: 0, totalTests: testFiles.length,
            graphSize: reverse.size, cacheHit, durationMs: Date.now() - startMs,
          });
          return;
        }

        // alwaysRunTests entries are intentionally exempt from this ratio check —
        // they are a bounded, user-declared list unioned in only after this
        // decision, not part of the graph-driven affected count it gates.
        const ratio = affectedTests.length / testFiles.length;
        const threshold = options.threshold ?? 1.0;
        if (ratio > threshold) {
          console.warn(
            `[vitest-affected] Threshold exceeded (${affectedTests.length}/${testFiles.length} = ${(ratio * 100).toFixed(1)}%) — running full suite`,
          );
          emitStats(statsCtx, 'full-suite', 'threshold-exceeded', {
            changedFiles: changed.length, deletedFiles: deleted.length,
            ignoredFiles: ignoredCount,
            affectedTests: affectedTests.length, totalTests: testFiles.length,
            graphSize: reverse.size, cacheHit, durationMs: Date.now() - startMs,
          });
          return;
        }

        // 15. Verbose summary: count of changed files not in graph (was per-file warning)
        if (options.verbose) {
          const notInGraph = changed.filter((f) => !reverse.has(f)).length;
          if (notInGraph > 0) {
            console.warn(
              `[vitest-affected] ${notInGraph} changed file(s) not in dependency graph (delta-parsed for new imports)`,
            );
          }
        }

        // 16. existsSync filter — warn on missing
        const validTests = affectedTests.filter((f) => {
          if (!existsSync(f)) {
            console.warn(
              `[vitest-affected] Affected test file not found on disk: ${safeLabel(f)}`,
            );
            return false;
          }
          return true;
        });

        // 17. Apply results
        if (validTests.length > 0) {
          // Union in alwaysRunTests, de-duplicated against the BFS-selected set.
          const selected = unionAlwaysRun(validTests, alwaysRunTests);
          // Shadow guards the mutation site: compute the selection, never apply it.
          if (!shadow) {
            project.config.include = selected;
            // Record the selected set for the reporter's post-run self-verify.
            setSelectedTests(selected);
          }
          emitStats(statsCtx, 'selective', undefined, {
            changedFiles: changed.length, deletedFiles: deleted.length,
            ignoredFiles: ignoredCount,
            affectedTests: validTests.length, totalTests: testFiles.length,
            graphSize: reverse.size, cacheHit, durationMs: Date.now() - startMs,
            selectedFiles: selected,
            explain: buildExplain(validTests, options.explain, provenance),
          });
        } else {
          emitStats(statsCtx, 'full-suite', 'no-valid-tests-on-disk', {
            changedFiles: changed.length, deletedFiles: deleted.length,
            ignoredFiles: ignoredCount,
            affectedTests: 0, totalTests: testFiles.length,
            graphSize: reverse.size, cacheHit, durationMs: Date.now() - startMs,
          });
        }
      } catch (err) {
        // 18. Catch-all: safety invariant — never crash, never skip silently.
        // Stats path was resolved above the try so this exit still emits.
        console.warn(
          `[vitest-affected] Unexpected error — running full suite: ${err instanceof Error ? err.message : String(err)}`,
        );
        emitStats(statsCtx, 'full-suite', 'error', {
          durationMs: Date.now() - startMs,
        });
      }
    },
  };
}
