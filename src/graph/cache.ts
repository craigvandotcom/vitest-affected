import {
  mkdirSync,
  renameSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
  existsSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { toCanonicalPath } from './normalize.js';
import type { ReverseMap } from './types.js';

const GRAPH_FILE = 'graph.json';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * JSON.parse reviver that rejects prototype-pollution keys.
 * Applied to all cache file reads as a defense-in-depth measure.
 */
function safeJsonReviver(_key: string, value: unknown): unknown {
  if (_key === '__proto__' || _key === 'constructor' || _key === 'prototype') {
    return undefined;
  }
  return value;
}

/**
 * Age threshold (ms) for `.tmp-*` reaping in {@link cleanupOrphanedTmp}. A
 * `saveCacheSync` in another concurrently-running process writes its temp file
 * moments before renaming it into place; without an age guard, a load that
 * happens to run mid-write would delete that in-flight temp out from under the
 * concurrent writer, corrupting its atomic rename (renameSync would then throw
 * ENOENT). Only a temp file OLDER than this threshold is presumed genuinely
 * orphaned (left behind by a process that crashed between writeFileSync and
 * renameSync) and safe to reap. 60s comfortably exceeds any realistic
 * writeFileSync→renameSync gap for this cache's payload size.
 */
const ORPHANED_TMP_MAX_AGE_MS = 60_000;

/**
 * Clean up any orphaned `.tmp-*` files left by a previous interrupted write.
 * Spares any temp file younger than {@link ORPHANED_TMP_MAX_AGE_MS} — see that
 * constant's doc for why a fresh temp must not be reaped.
 */
function cleanupOrphanedTmp(cacheDir: string): void {
  if (!existsSync(cacheDir)) return;
  try {
    const entries = readdirSync(cacheDir);
    const now = Date.now();
    for (const entry of entries) {
      if (entry.startsWith('.tmp-')) {
        const entryPath = path.join(cacheDir, entry);
        try {
          const { mtimeMs } = statSync(entryPath);
          if (now - mtimeMs < ORPHANED_TMP_MAX_AGE_MS) continue; // in-flight — spare it
          rmSync(entryPath);
        } catch {
          // best-effort
        }
      }
    }
  } catch {
    // best-effort
  }
}

/**
 * Returns true if `filePath` is under `rootDir` (same boundary check as
 * builder.ts). Accepts exact match or prefix + path.sep.
 */
function isUnderRootDir(filePath: string, rootDir: string): boolean {
  // Cache paths are Vite-normalized (always forward slashes), so use '/' not path.sep
  const rootPrefix = rootDir.endsWith('/') ? rootDir : rootDir + '/';
  return filePath === rootDir || filePath.startsWith(rootPrefix);
}

/**
 * Build the in-memory reverse map from a raw source→tests object, canonicalizing
 * every key and value (toCanonicalPath) and confining entries to the
 * already-canonicalized rootDir. Canonicalizing on LOAD is what lets a cache
 * written before canonicalization existed — or through a different path alias
 * (macOS /var vs /private/var, a symlinked project root) — converge with
 * today's canonical graph keys instead of silently orphaning. Distinct raw
 * keys that canonicalize to the same path are merged, not overwritten.
 * Shared by the v2 load path and the v1 migration path.
 *
 * Realpath-storm avoidance: `saveCacheSync` writes canonical paths (the reporter
 * + mergeRuntimeEdges operate on canonical paths), so any entry already prefixed
 * by `canonicalRoot + '/'` was written canonically by this plugin and is trusted
 * as-is — skipping a `toCanonicalPath` (hence a `realpathSync` syscall) per key
 * AND per value on every cache load. INVARIANT: prefix-matching entries are
 * already canonical. Entries written by an older version or through a different
 * alias (e.g. `/var` vs `/private/var`) do NOT match the prefix and still get
 * canonicalized, so the alias-convergence guarantee is preserved. A stale entry
 * that somehow slips through the prefix trusted-as-is simply orphans (misses its
 * graph key) and self-heals on the next full-suite run that re-records it.
 */
function toConfinedReverseMap(
  rawMap: Record<string, string[]>,
  canonicalRoot: string,
): ReverseMap {
  const rootPrefix = canonicalRoot.endsWith('/') ? canonicalRoot : canonicalRoot + '/';
  // Paths already under the canonical root were written canonically on save →
  // trust them; only alias/legacy paths pay the realpath cost.
  const canonicalize = (p: string): string =>
    p.startsWith(rootPrefix) ? p : toCanonicalPath(p);

  const reverse: ReverseMap = new Map();
  for (const [file, tests] of Object.entries(rawMap)) {
    const canonicalFile = canonicalize(file);
    if (!isUnderRootDir(canonicalFile, canonicalRoot)) continue;
    const confinedTests = tests
      .map((t) => canonicalize(t))
      .filter((t) => isUnderRootDir(t, canonicalRoot));
    if (confinedTests.length === 0) continue;
    const existing = reverse.get(canonicalFile);
    if (existing) {
      for (const t of confinedTests) existing.add(t);
    } else {
      reverse.set(canonicalFile, new Set(confinedTests));
    }
  }
  return reverse;
}

/**
 * Validates a plain object where all keys are strings and all values are
 * arrays of strings. Used for v3/v2 reverseMap and v1 runtimeEdges.
 */
function isValidReverseMapObject(
  value: unknown,
): value is Record<string, string[]> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  for (const v of Object.values(value as Record<string, unknown>)) {
    if (!Array.isArray(v)) return false;
    for (const item of v as unknown[]) {
      if (typeof item !== 'string') return false;
    }
  }
  return true;
}

/**
 * Convert an absolute canonical path to a path relative to `canonicalRoot`,
 * forward-slash normalized. This is the save-side half of the v3
 * relative-path boundary: the in-memory reverse map stays absolute (the
 * whole selector/reporter pipeline expects that), and relativization happens
 * only here, right before the value is written to disk.
 *
 * The prefix-strip is the common case (every entry in the in-memory map is
 * already confined under canonicalRoot by construction). `path.relative` is
 * a defensive fallback only — it degrades gracefully instead of throwing if
 * an out-of-root entry were ever to slip through.
 */
function toRootRelative(absPath: string, canonicalRoot: string): string {
  const rootPrefix = canonicalRoot.endsWith('/') ? canonicalRoot : canonicalRoot + '/';
  if (absPath.startsWith(rootPrefix)) return absPath.slice(rootPrefix.length);
  return path.relative(canonicalRoot, absPath).replaceAll('\\', '/');
}

/**
 * Convert a rootDir-relative raw reverseMap (as persisted in v3) back into an
 * absolute-path raw reverseMap, by joining every key/value onto
 * `canonicalRoot`. This is the load-side half of the v3 relative-path
 * boundary: once rejoined, the map is in exactly the shape v2 raw maps were
 * (absolute paths), so it flows through the existing `toConfinedReverseMap`
 * canonicalization + confinement pipeline unchanged — including the
 * defense-in-depth `isUnderRootDir` filter, which also catches a relative
 * entry crafted with `../` segments to escape rootDir (`path.join` resolves
 * those before the confinement check runs).
 */
function relativeMapToAbsolute(
  rawMap: Record<string, string[]>,
  canonicalRoot: string,
): Record<string, string[]> {
  const toAbsolute = (relPath: string): string =>
    path.join(canonicalRoot, relPath).replaceAll('\\', '/');

  const absolute: Record<string, string[]> = {};
  for (const [relFile, relTests] of Object.entries(rawMap)) {
    absolute[toAbsolute(relFile)] = relTests.map(toAbsolute);
  }
  return absolute;
}

/**
 * PRIVATE. Read-only raw read of the on-disk v3 reverse map, for the
 * save-path concurrency union ONLY (item 1b of the cache-robustness spec) —
 * NOT for `loadCachedReverseMap`, which additionally runs
 * `cleanupOrphanedTmp` and the full v1/v2 migration pipeline: paying that cost
 * on every SAVE (not just every load) would be wasteful, and a migration
 * write-back has no business happening from inside a save.
 *
 * GUARDED to `version === 3` only: a missing/corrupt file, or any other
 * version (v1, v2, unknown), returns an EMPTY map rather than attempting to
 * migrate it here. That makes the union a self-healing NO-OP against a
 * legacy on-disk format — the legacy cache still gets migrated correctly the
 * next time `loadCachedReverseMap` runs — and, just as importantly, it
 * prevents ever double-joining an absolute-path v1/v2 map through the
 * relative-path v3 rejoin logic below (which would silently corrupt paths).
 *
 * Returns entries confined and canonicalized against `canonicalRoot`, in
 * exactly the same absolute in-memory shape `loadCachedReverseMap` produces —
 * callers union this directly into their own absolute-path working map.
 */
function readConfinedDiskMapV3(cacheDir: string, canonicalRoot: string): ReverseMap {
  const cachePath = path.join(cacheDir, GRAPH_FILE);
  let raw: string;
  try {
    raw = readFileSync(cachePath, 'utf-8');
  } catch {
    return new Map();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw, safeJsonReviver);
  } catch {
    return new Map();
  }

  if (typeof parsed !== 'object' || parsed === null) return new Map();
  const obj = parsed as Record<string, unknown>;
  if (obj['version'] !== CACHE_VERSION_V3) return new Map();

  const reverseMapRaw = obj['reverseMap'];
  if (!isValidReverseMapObject(reverseMapRaw)) return new Map();

  const absoluteRaw = relativeMapToAbsolute(reverseMapRaw, canonicalRoot);
  return toConfinedReverseMap(absoluteRaw, canonicalRoot);
}

// ---------------------------------------------------------------------------
// Disk format v3 — rootDir-relative paths (current)
// ---------------------------------------------------------------------------
//
// v3 stores paths relative to the canonicalized rootDir instead of absolute
// (v1/v2 stored absolute paths, which machine-locks the cache — a fresh
// checkout on a different machine/CI runner, or even a differently-mounted
// checkout on the same machine, could never hit). Relativizing at the
// persistence boundary makes a cache produced at one checkout path load
// correctly at another, as long as the relative structure under rootDir is
// identical. In-memory representation is unaffected: still absolute
// canonical paths, always.

interface CacheDiskFormatV3 {
  version: 3;
  builtAt: number;
  /**
   * STALENESS METADATA (additive since the v3 landing — older v3 caches, and
   * every v2/v1 cache, simply lack these fields; load defaults them to
   * `{ lastFullRebuild: 0, runCount: 0 }`, which the staleness check reads as
   * "no baseline yet, do not warn").
   *
   * - `lastFullRebuild` — epoch-ms timestamp of the last FULL-suite run, which
   *   re-exercises (near) every test and so fully refreshes the runtime map.
   *   Selective runs preserve it; a full-suite run resets it to now.
   * - `runCount` — number of SELECTIVE runs since the last full rebuild. Reset
   *   to 0 by a full-suite run, incremented by each selective run. A high count
   *   means the graph has drifted through many partial updates without a full
   *   re-observation.
   */
  lastFullRebuild: number;
  runCount: number;
  /**
   * GIT IDENTITY METADATA (additive since this bead — every cache written
   * before it, and any v1/v2 cache, simply lacks these fields; load defaults
   * them to `undefined`, which reconcileCacheStaleness reads as "no baseline,
   * don't warn"). Captured once per save from `readGitIdentity` (git.ts) and
   * threaded through unchanged — cache.ts never shells out itself, staying
   * synchronous.
   *
   * - `headSha` — the HEAD commit SHA at the time of this save. Compared
   *   against the CURRENT HEAD sha on a later run to detect a branch switch
   *   or rebase that silently invalidated the runtime-observed graph
   *   (DIAGNOSTIC only — see reconcileCacheStaleness in plugin.ts).
   * - `branch` — the branch name at the time of this save, carried alongside
   *   `headSha` for the same diagnostic purpose.
   */
  headSha?: string;
  branch?: string;
  reverseMap: Record<string, string[]>;  // source → test_files, rootDir-relative
}

/**
 * Staleness + git-identity metadata surfaced from a cache load. `headSha`/
 * `branch` are `undefined` when the field is absent in the file (pre-this-bead
 * v3 cache, or a migrated v1/v2 cache) — read as "no baseline, don't warn" by
 * reconcileCacheStaleness, same posture as `lastFullRebuild`/`runCount` at 0.
 */
export interface CacheMeta {
  lastFullRebuild: number;
  runCount: number;
  headSha?: string;
  branch?: string;
}

const EMPTY_META: CacheMeta = { lastFullRebuild: 0, runCount: 0 };

const CACHE_VERSION_V1 = 1;
const CACHE_VERSION_V2 = 2;
const CACHE_VERSION_V3 = 3;

/**
 * Load cached reverse map from graph.json.
 *
 * Handles:
 * - v3 directly (current — rootDir-relative paths, rejoined to absolute)
 * - v2 (absolute paths) → migrated to the in-memory reverse map (will be
 *   re-persisted as v3 on the next save)
 * - v1 with runtimeEdges → migrated to the in-memory reverse map
 * - v1 without runtimeEdges → cache miss
 * - Corrupt/missing/unknown version → cache miss
 *
 * @returns { reverse, hit, meta } where hit=false means caller should run full
 * suite. `meta` carries the staleness metadata (defaults to zeros on any cache
 * miss or a pre-metadata cache format).
 */
export function loadCachedReverseMap(
  cacheDir: string,
  rootDir: string,
  verbose = false,
): { reverse: ReverseMap; hit: boolean; meta: CacheMeta } {
  cleanupOrphanedTmp(cacheDir);

  // Canonicalize the confinement boundary itself; keys/values are
  // canonicalized entry-by-entry in toConfinedReverseMap.
  const canonicalRoot = toCanonicalPath(rootDir);

  const cachePath = path.join(cacheDir, GRAPH_FILE);
  let raw: string;
  try {
    raw = readFileSync(cachePath, 'utf-8');
  } catch {
    if (verbose) console.warn('[vitest-affected] No cache file found — cache miss');
    return { reverse: new Map(), hit: false, meta: EMPTY_META };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw, safeJsonReviver);
  } catch {
    if (verbose) console.warn('[vitest-affected] Corrupt cache JSON — cache miss');
    return { reverse: new Map(), hit: false, meta: EMPTY_META };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { reverse: new Map(), hit: false, meta: EMPTY_META };
  }

  const obj = parsed as Record<string, unknown>;

  // --- v3 format (current) ---
  if (obj['version'] === CACHE_VERSION_V3) {
    const reverseMapRaw = obj['reverseMap'];
    if (!isValidReverseMapObject(reverseMapRaw)) {
      if (verbose) console.warn('[vitest-affected] v3 cache schema invalid — cache miss');
      return { reverse: new Map(), hit: false, meta: EMPTY_META };
    }

    // Rejoin rootDir-relative paths back to absolute before they enter the
    // canonicalization/confinement pipeline shared with v2/v1.
    const absoluteRaw = relativeMapToAbsolute(reverseMapRaw, canonicalRoot);
    const reverse = toConfinedReverseMap(absoluteRaw, canonicalRoot);

    // Additive staleness metadata — absent in pre-metadata v3 caches, defaulted
    // to 0 (no baseline) so the staleness check stays silent until a full run.
    const lastFullRebuild =
      typeof obj['lastFullRebuild'] === 'number' ? obj['lastFullRebuild'] : 0;
    const runCount = typeof obj['runCount'] === 'number' ? obj['runCount'] : 0;
    // Additive git-identity metadata — absent in a pre-this-bead v3 cache,
    // defaulted to undefined (no baseline, don't warn — same posture as the
    // staleness fields above).
    const headSha = typeof obj['headSha'] === 'string' ? obj['headSha'] : undefined;
    const branch = typeof obj['branch'] === 'string' ? obj['branch'] : undefined;

    if (verbose) console.warn(`[vitest-affected] v3 cache hit — ${reverse.size} entries`);
    return { reverse, hit: true, meta: { lastFullRebuild, runCount, headSha, branch } };
  }

  // --- v2 → v3 migration (v2 stored absolute paths) ---
  if (obj['version'] === CACHE_VERSION_V2) {
    const reverseMapRaw = obj['reverseMap'];
    if (!isValidReverseMapObject(reverseMapRaw)) {
      if (verbose) console.warn('[vitest-affected] v2 cache schema invalid — cache miss');
      return { reverse: new Map(), hit: false, meta: EMPTY_META };
    }

    const reverse = toConfinedReverseMap(reverseMapRaw, canonicalRoot);

    if (verbose) console.warn(`[vitest-affected] v2→v3 migration — ${reverse.size} entries`);
    return { reverse, hit: true, meta: EMPTY_META };
  }

  // --- v1 migration ---
  if (obj['version'] === CACHE_VERSION_V1) {
    const runtimeEdges = obj['runtimeEdges'];
    if (runtimeEdges === undefined || !isValidReverseMapObject(runtimeEdges)) {
      if (verbose) console.warn('[vitest-affected] v1 cache without runtimeEdges — cache miss');
      return { reverse: new Map(), hit: false, meta: EMPTY_META };
    }

    // Migrate v1 runtimeEdges → v2 reverse map
    const reverse = toConfinedReverseMap(runtimeEdges, canonicalRoot);

    if (verbose) console.warn(`[vitest-affected] v1→v2 migration — ${reverse.size} entries`);
    return { reverse, hit: true, meta: EMPTY_META };
  }

  // Unknown version
  if (verbose) console.warn('[vitest-affected] Unknown cache version — cache miss');
  return { reverse: new Map(), hit: false, meta: EMPTY_META };
}

/**
 * Options threaded into {@link saveCacheSync} beyond the staleness/git-identity
 * `meta`. Both are optional and default to today's behavior (no union, no
 * sweep) — see the SAVE-PATH TRANSFORM ORDER doc on `saveCacheSync` itself for
 * how they interact.
 */
export interface SaveCacheOptions {
  /**
   * The set of test paths THIS run actually observed (i.e. the union of every
   * value-set in the `edges` the runtime reporter collected this cycle).
   * Drives step 2 (the concurrency union): a disk edge is unioned in only when
   * its TEST is absent from this set — this run is authoritative for every
   * test it observed, disk is authoritative for everything else. `undefined`
   * (the default — tests, one-off tools) skips the union entirely, preserving
   * today's plain atomic-overwrite behavior.
   */
  observedTests?: Set<string>;
  /**
   * Whether this save follows a FULL-SUITE run. Gates step 3 (the growth
   * prune): only a full-suite save re-exercises (near) every test, so only
   * then can a missing source/test path be trusted as genuinely dead rather
   * than merely "not part of this selective run". Default false (no sweep).
   */
  fullSuite?: boolean;
}

/**
 * Persist a reverse map to disk in v3 format (rootDir-relative paths).
 * Atomic write: temp file → renameSync. Always writes current-version-only —
 * there is no reason to ever write v1/v2 again, migration is a read-time-only
 * concern.
 *
 * `saveCacheSync` intentionally keeps its 2-arg-compatible signature (no
 * explicit `rootDir` parameter) for caller compatibility: every call site in
 * this codebase constructs `cacheDir` as `path.join(rootDir,
 * '.vitest-affected')`, so `path.dirname(cacheDir)` recovers rootDir without a
 * signature change. Canonicalized defensively in case a caller ever passes a
 * non-canonical cacheDir.
 *
 * `meta` carries the additive staleness + git-identity fields. It is optional
 * and defaults to a FRESH full rebuild (`lastFullRebuild: now, runCount: 0`,
 * `headSha`/`branch` undefined) so any caller that does not track them —
 * tests, one-off tools — produces a non-stale, identity-less cache. The
 * runtime reporter passes explicit meta on every save: a full-suite run
 * resets the staleness baseline (now / 0), a selective run preserves
 * `lastFullRebuild` and bumps `runCount`; `headSha`/`branch` are captured once
 * (readGitIdentity, git.ts) and passed through unchanged on every save. NEVER
 * let a selective save fall through to the fresh staleness default, or it
 * would silently reset the baseline it is meant to age.
 *
 * SAVE-PATH TRANSFORM ORDER (binding — mis-ordering silently cancels these
 * steps). Applied, in THIS order, immediately before serialize+rename:
 *
 *   1. Build this run's reverseMap — `reverse`, as passed in: already-canonical
 *      absolute paths, exactly as before this bead.
 *   2. CONCURRENCY UNION — only when `opts.observedTests` is supplied: re-read
 *      the on-disk graph.json (via {@link readConfinedDiskMapV3}, NOT
 *      `loadCachedReverseMap` — see that helper's doc) and per-KEY Set-union
 *      its entries into the working map, but ONLY for tests the caller did
 *      NOT observe this cycle. This lets a CONCURRENT writer's edges survive
 *      while this process's own just-stripped removed-import edges are never
 *      resurrected (that stripping already happened upstream, in
 *      `mergeRuntimeEdges('all', ...)`, before `reverse` ever reaches here —
 *      an observed test simply has no entry for a dropped edge to union back
 *      in). Skipped entirely when `observedTests` is absent (today's plain
 *      overwrite).
 *   3. GROWTH PRUNE — only when `opts.fullSuite` is true, and only AFTER step
 *      2: existsSync-sweep the UNIONED working map, dropping (i) source keys
 *      whose file no longer exists and (ii) test-path values whose file no
 *      longer exists (an entry emptied of every value is dropped entirely).
 *      Running this AFTER the union — not before — is load-bearing: a
 *      dead entry reintroduced by a concurrent writer's disk state in step 2
 *      must still be swept by a full-suite save, which a prune-before-union
 *      ordering would miss entirely.
 *   4. Relativize + tmp-write + renameSync — as today.
 *
 * A union performed WITHOUT the observedTests guard would resurrect edges
 * `mergeRuntimeEdges` deliberately removed upstream; pruning before the union
 * would let step 2 re-add exactly the dead keys step 3 just swept. Either
 * mis-ordering silently defeats the guarantee the other step exists to
 * provide.
 */
export function saveCacheSync(
  cacheDir: string,
  reverse: ReverseMap,
  meta: Partial<CacheMeta> = {},
  opts: SaveCacheOptions = {},
): void {
  mkdirSync(cacheDir, { recursive: true });

  const canonicalRoot = toCanonicalPath(path.dirname(cacheDir));

  // Step 1: this run's authoritative map. Cloned into a mutable working copy
  // — `reverse` (and its Sets) may be a structurally-shared value the caller
  // (the reporter's mergeRuntimeEdges output) still holds a reference to and
  // reuses across saves; steps 2/3 below must never mutate the caller's Sets
  // in place.
  const working: ReverseMap = new Map();
  for (const [file, tests] of reverse) working.set(file, new Set(tests));

  // Step 2: CONCURRENCY UNION (skipped when observedTests is absent).
  if (opts.observedTests) {
    const onDisk = readConfinedDiskMapV3(cacheDir, canonicalRoot);
    for (const [file, tests] of onDisk) {
      for (const t of tests) {
        // This run is authoritative for every test it observed — union in
        // only the edges belonging to tests it did NOT observe this cycle.
        if (opts.observedTests.has(t)) continue;
        let target = working.get(file);
        if (!target) {
          target = new Set();
          working.set(file, target);
        }
        target.add(t);
      }
    }
  }

  // Step 3: GROWTH PRUNE (full-suite saves only, AFTER the union above so a
  // dead entry reintroduced by step 2 is still removed).
  if (opts.fullSuite) {
    for (const [file, tests] of working) {
      if (!existsSync(file)) {
        working.delete(file);
        continue;
      }
      for (const t of tests) {
        if (!existsSync(t)) tests.delete(t);
      }
      if (tests.size === 0) working.delete(file);
    }
  }

  // Step 4: relativize + tmp-write + renameSync.
  const reverseMap: Record<string, string[]> = {};
  for (const [file, tests] of working) {
    reverseMap[toRootRelative(file, canonicalRoot)] = [...tests].map((t) =>
      toRootRelative(t, canonicalRoot),
    );
  }

  const now = Date.now();
  const payload: CacheDiskFormatV3 = {
    version: CACHE_VERSION_V3,
    builtAt: now,
    lastFullRebuild: meta.lastFullRebuild ?? now,
    runCount: meta.runCount ?? 0,
    headSha: meta.headSha,
    branch: meta.branch,
    reverseMap,
  };

  const json = JSON.stringify(payload);
  const rand = Math.random().toString(36).slice(2);
  const tmpPath = path.join(cacheDir, `.tmp-${rand}`);
  writeFileSync(tmpPath, json, 'utf-8');
  try {
    renameSync(tmpPath, path.join(cacheDir, GRAPH_FILE));
  } catch (err) {
    // Clean up orphaned temp file before propagating
    try { rmSync(tmpPath); } catch { /* best-effort */ }
    throw err;
  }
}
