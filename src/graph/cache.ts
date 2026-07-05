import {
  mkdirSync,
  renameSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
  existsSync,
} from 'node:fs';
import path from 'node:path';
import { toCanonicalPath } from './normalize.js';

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
 * Clean up any orphaned `.tmp-*` files left by a previous interrupted write.
 */
function cleanupOrphanedTmp(cacheDir: string): void {
  if (!existsSync(cacheDir)) return;
  try {
    const entries = readdirSync(cacheDir);
    for (const entry of entries) {
      if (entry.startsWith('.tmp-')) {
        try {
          rmSync(path.join(cacheDir, entry));
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
): Map<string, Set<string>> {
  const rootPrefix = canonicalRoot.endsWith('/') ? canonicalRoot : canonicalRoot + '/';
  // Paths already under the canonical root were written canonically on save →
  // trust them; only alias/legacy paths pay the realpath cost.
  const canonicalize = (p: string): string =>
    p.startsWith(rootPrefix) ? p : toCanonicalPath(p);

  const reverse = new Map<string, Set<string>>();
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
  reverseMap: Record<string, string[]>;  // source → test_files, rootDir-relative
}

/**
 * Staleness metadata surfaced from a cache load. Absent-in-file fields default
 * to 0 (no baseline), which the plugin's staleness check treats as "do not
 * warn" — a freshly-migrated v2/v1 cache or a pre-metadata v3 cache is not
 * flagged until its first full-suite run seeds `lastFullRebuild`.
 */
export interface CacheMeta {
  lastFullRebuild: number;
  runCount: number;
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
): { reverse: Map<string, Set<string>>; hit: boolean; meta: CacheMeta } {
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

    if (verbose) console.warn(`[vitest-affected] v3 cache hit — ${reverse.size} entries`);
    return { reverse, hit: true, meta: { lastFullRebuild, runCount } };
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
 * Persist a reverse map to disk in v3 format (rootDir-relative paths).
 * Atomic write: temp file → renameSync. Always writes current-version-only —
 * there is no reason to ever write v1/v2 again, migration is a read-time-only
 * concern.
 *
 * Keys/values arrive already canonicalized absolute paths (the reporter +
 * mergeRuntimeEdges operate on canonical paths); this function relativizes
 * them against rootDir right before serialization — the one place the
 * absolute→relative boundary crosses on the way to disk.
 *
 * `saveCacheSync` intentionally keeps its 2-arg signature (no explicit
 * `rootDir` parameter) for caller compatibility: every call site in this
 * codebase constructs `cacheDir` as `path.join(rootDir, '.vitest-affected')`,
 * so `path.dirname(cacheDir)` recovers rootDir without a signature change.
 * Canonicalized defensively in case a caller ever passes a non-canonical
 * cacheDir.
 *
 * `meta` carries the additive staleness fields. It is optional and defaults to
 * a FRESH full rebuild (`lastFullRebuild: now, runCount: 0`) so any caller that
 * does not track staleness — tests, one-off tools — produces a non-stale cache.
 * The runtime reporter passes explicit meta on every save: a full-suite run
 * resets it (now / 0), a selective run preserves `lastFullRebuild` and bumps
 * `runCount`. NEVER let a selective save fall through to the fresh default, or
 * it would silently reset the staleness baseline it is meant to age.
 */
export function saveCacheSync(
  cacheDir: string,
  reverse: Map<string, Set<string>>,
  meta: Partial<CacheMeta> = {},
): void {
  mkdirSync(cacheDir, { recursive: true });

  const canonicalRoot = toCanonicalPath(path.dirname(cacheDir));

  const reverseMap: Record<string, string[]> = {};
  for (const [file, tests] of reverse) {
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
