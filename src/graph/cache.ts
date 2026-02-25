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
  const rootPrefix = rootDir.endsWith(path.sep) ? rootDir : rootDir + path.sep;
  return filePath === rootDir || filePath.startsWith(rootPrefix);
}

/**
 * Validates a plain object where all keys are strings and all values are
 * arrays of strings. Used for both v2 reverseMap and v1 runtimeEdges.
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

// ---------------------------------------------------------------------------
// Disk format v2 — runtime-first architecture
// ---------------------------------------------------------------------------

interface CacheDiskFormatV2 {
  version: 2;
  builtAt: number;
  reverseMap: Record<string, string[]>;  // source → test_files
}

const CACHE_VERSION_V1 = 1;
const CACHE_VERSION_V2 = 2;

/**
 * Load cached reverse map from graph.json.
 *
 * Handles:
 * - v2 directly
 * - v1 with runtimeEdges → migrated to v2 reverse map
 * - v1 without runtimeEdges → cache miss
 * - Corrupt/missing → cache miss
 *
 * @returns { reverse, hit } where hit=false means caller should run full suite
 */
export function loadCachedReverseMap(
  cacheDir: string,
  rootDir: string,
  verbose = false,
): { reverse: Map<string, Set<string>>; hit: boolean } {
  cleanupOrphanedTmp(cacheDir);

  const cachePath = path.join(cacheDir, GRAPH_FILE);
  let raw: string;
  try {
    raw = readFileSync(cachePath, 'utf-8');
  } catch {
    if (verbose) console.warn('[vitest-affected] No cache file found — cache miss');
    return { reverse: new Map(), hit: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw, safeJsonReviver);
  } catch {
    if (verbose) console.warn('[vitest-affected] Corrupt cache JSON — cache miss');
    return { reverse: new Map(), hit: false };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { reverse: new Map(), hit: false };
  }

  const obj = parsed as Record<string, unknown>;

  // --- v2 format ---
  if (obj['version'] === CACHE_VERSION_V2) {
    const reverseMapRaw = obj['reverseMap'];
    if (!isValidReverseMapObject(reverseMapRaw)) {
      if (verbose) console.warn('[vitest-affected] v2 cache schema invalid — cache miss');
      return { reverse: new Map(), hit: false };
    }

    const reverse = new Map<string, Set<string>>();
    for (const [file, tests] of Object.entries(reverseMapRaw)) {
      if (!isUnderRootDir(file, rootDir)) continue;
      const confinedTests = (tests as string[]).filter((t) => isUnderRootDir(t, rootDir));
      if (confinedTests.length > 0) {
        reverse.set(file, new Set(confinedTests));
      }
    }

    if (verbose) console.warn(`[vitest-affected] v2 cache hit — ${reverse.size} entries`);
    return { reverse, hit: true };
  }

  // --- v1 migration ---
  if (obj['version'] === CACHE_VERSION_V1) {
    const runtimeEdges = obj['runtimeEdges'];
    if (runtimeEdges === undefined || !isValidReverseMapObject(runtimeEdges)) {
      if (verbose) console.warn('[vitest-affected] v1 cache without runtimeEdges — cache miss');
      return { reverse: new Map(), hit: false };
    }

    // Migrate v1 runtimeEdges → v2 reverse map
    const reverse = new Map<string, Set<string>>();
    for (const [file, tests] of Object.entries(runtimeEdges)) {
      if (!isUnderRootDir(file, rootDir)) continue;
      const confinedTests = (tests as string[]).filter((t) => isUnderRootDir(t, rootDir));
      if (confinedTests.length > 0) {
        reverse.set(file, new Set(confinedTests));
      }
    }

    if (verbose) console.warn(`[vitest-affected] v1→v2 migration — ${reverse.size} entries`);
    return { reverse, hit: true };
  }

  // Unknown version
  if (verbose) console.warn('[vitest-affected] Unknown cache version — cache miss');
  return { reverse: new Map(), hit: false };
}

/**
 * Persist a reverse map to disk in v2 format.
 * Atomic write: temp file → renameSync.
 */
export function saveCacheSync(
  cacheDir: string,
  reverse: Map<string, Set<string>>,
): void {
  mkdirSync(cacheDir, { recursive: true });

  const reverseMap: Record<string, string[]> = {};
  for (const [file, tests] of reverse) {
    reverseMap[file] = [...tests];
  }

  const payload: CacheDiskFormatV2 = {
    version: CACHE_VERSION_V2,
    builtAt: Date.now(),
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
