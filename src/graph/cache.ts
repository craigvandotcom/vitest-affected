import {
  mkdirSync,
  renameSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  lstatSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { glob } from 'tinyglobby';
import {
  buildFullGraph,
  buildFullGraphSync,
  createResolver,
  resolveFileImports,
  GRAPH_GLOB_PATTERN,
  GRAPH_GLOB_IGNORE,
} from './builder.js';

// ---------------------------------------------------------------------------
// Disk format v1
// ---------------------------------------------------------------------------

interface CacheFileEntry {
  mtime: number;
  imports: string[];
}

interface CacheDiskFormat {
  version: 1;
  builtAt: number;
  files: Record<string, CacheFileEntry>;
  runtimeEdges?: Record<string, string[]>;
}

const CACHE_VERSION = 1;
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
 * Build forward + reverse maps from a map of file entries (path → imports).
 */
function entriesToMaps(
  entries: Map<string, string[]>,
): { forward: Map<string, Set<string>>; reverse: Map<string, Set<string>> } {
  const forward = new Map<string, Set<string>>();
  const reverse = new Map<string, Set<string>>();

  for (const [file, imports] of entries) {
    if (!forward.has(file)) forward.set(file, new Set());
    if (!reverse.has(file)) reverse.set(file, new Set());

    for (const imp of imports) {
      forward.get(file)!.add(imp);
      if (!forward.has(imp)) forward.set(imp, new Set());
      if (!reverse.has(imp)) reverse.set(imp, new Set());
      reverse.get(imp)!.add(file);
    }
  }

  return { forward, reverse };
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
 * Validates disk.files schema. Returns true if the value is a plain object
 * where every entry has typeof mtime === 'number' and imports is a string[].
 */
function isValidFilesObject(
  value: unknown,
): value is Record<string, CacheFileEntry> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  for (const entry of Object.values(value as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return false;
    }
    const e = entry as Record<string, unknown>;
    if (typeof e['mtime'] !== 'number') return false;
    if (!Array.isArray(e['imports'])) return false;
    for (const imp of e['imports'] as unknown[]) {
      if (typeof imp !== 'string') return false;
    }
  }
  return true;
}

/**
 * Validates runtimeEdges schema. Returns true if the value is a plain object
 * where all keys are strings and all values are arrays of strings.
 */
function isValidRuntimeEdgesObject(
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
// Public API
// ---------------------------------------------------------------------------

/**
 * Load a previously saved graph cache and refresh any stale entries.
 * Falls back to a full `buildFullGraph` on any read/parse failure.
 *
 * @param rootDir   Root of the source tree (passed to buildFullGraph / createResolver)
 * @param cacheDir  Directory where `graph.json` is stored (e.g. `<rootDir>/.vitest-affected`)
 * @param verbose   Log verbose messages (default false)
 */
export async function loadOrBuildGraph(
  rootDir: string,
  cacheDir: string,
  verbose = false,
): Promise<{
  forward: Map<string, Set<string>>;
  reverse: Map<string, Set<string>>;
}> {
  // Always clean up orphaned temp files first
  cleanupOrphanedTmp(cacheDir);

  const cachePath = path.join(cacheDir, GRAPH_FILE);

  // --- Attempt cache read ---
  let disk: CacheDiskFormat | null = null;
  try {
    const raw = await readFile(cachePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw, safeJsonReviver);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as CacheDiskFormat).version === CACHE_VERSION
    ) {
      const candidate = parsed as { version: 1; builtAt: number; files: unknown; runtimeEdges?: unknown };

      // Schema validation: disk.files must be a valid plain object
      if (!isValidFilesObject(candidate.files)) {
        // Schema violation in disk.files → full rebuild
        if (verbose) {
          console.warn('[vitest-affected] Cache schema invalid (disk.files) — falling back to full rebuild');
        }
        return buildFullGraph(rootDir);
      }

      disk = candidate as CacheDiskFormat;
    }
    // else: unknown version → fall through to full rebuild
  } catch {
    // ENOENT or JSON.parse error → fall through to full rebuild
  }

  if (disk === null) {
    // Cache miss — full rebuild
    return buildFullGraph(rootDir);
  }

  // --- Path confinement: pre-filter disk.files entries to rootDir ---
  let skippedCount = 0;
  const validFiles: Array<[string, CacheFileEntry]> = [];
  for (const [filePath, entry] of Object.entries(disk.files)) {
    if (!isUnderRootDir(filePath, rootDir)) {
      skippedCount++;
      continue;
    }
    validFiles.push([filePath, entry]);
  }
  if (skippedCount > 0 && verbose) {
    console.warn(
      `[vitest-affected] Skipped ${skippedCount} cache entry/entries outside rootDir (path confinement)`,
    );
  }

  // --- Cache hit: stat each file, reparse stale ones ---
  const resolver = createResolver(rootDir);
  const refreshed = new Map<string, string[]>();
  let staleCount = 0;

  for (const [filePath, entry] of validFiles) {
    let currentMtime: number;
    try {
      currentMtime = lstatSync(filePath).mtimeMs;
    } catch {
      // File no longer exists or can't stat → skip
      continue;
    }

    if (currentMtime !== entry.mtime) {
      // Stale — reparse
      staleCount++;
      try {
        const source = await readFile(filePath, 'utf-8');
        const imports = resolveFileImports(filePath, source, rootDir, resolver);
        refreshed.set(filePath, imports);
      } catch {
        // Read error → preserve cached imports (conservative: don't silently drop edges)
        refreshed.set(filePath, entry.imports);
      }
    } else {
      // Up to date — filter out any imports that no longer exist on disk
      const validImports = entry.imports.filter((imp) => existsSync(imp));
      refreshed.set(filePath, validImports);
    }
  }

  if (verbose && staleCount > 0) {
    console.warn(
      `[vitest-affected] cache hit, ${staleCount} stale file(s) reparsed`,
    );
  }

  // --- Glob-based discovery: find new files not present in the refreshed map ---
  // Files added to the project after the cache was written are invisible to the
  // stale-refresh loop above (which only iterates disk.files). We glob for source
  // files using the same patterns as buildFullGraph and parse any that are new.
  const allSourceFiles = await glob(GRAPH_GLOB_PATTERN, {
    cwd: rootDir,
    absolute: true,
    ignore: GRAPH_GLOB_IGNORE,
  });

  let newFileCount = 0;
  for (const file of allSourceFiles) {
    if (refreshed.has(file)) continue; // already in the refreshed map — skip
    newFileCount++;
    try {
      const source = await readFile(file, 'utf-8');
      const imports = resolveFileImports(file, source, rootDir, resolver);
      refreshed.set(file, imports);
    } catch {
      // Read error — add the file with empty imports so it appears in the graph
      refreshed.set(file, []);
    }
  }

  if (verbose && newFileCount > 0) {
    console.warn(
      `[vitest-affected] cache hit, ${newFileCount} new file(s) discovered and parsed`,
    );
  }

  const { forward, reverse } = entriesToMaps(refreshed);

  // Merge persisted runtime edges into the reverse map
  if (disk.runtimeEdges !== undefined) {
    // Schema validation: runtimeEdges must be a valid plain object with string[] values
    if (!isValidRuntimeEdgesObject(disk.runtimeEdges)) {
      if (verbose) {
        console.warn('[vitest-affected] Cache schema invalid (runtimeEdges) — skipping runtime edge merge');
      }
      // Do NOT trigger full rebuild — static graph is still valid
    } else {
      // Path confinement: only merge keys that are under rootDir
      for (const [file, tests] of Object.entries(disk.runtimeEdges)) {
        if (!isUnderRootDir(file, rootDir)) {
          if (verbose) {
            console.warn(`[vitest-affected] Skipping runtimeEdges key outside rootDir: ${file}`);
          }
          continue;
        }
        // Filter test values to only those under rootDir
        const confinedTests = tests.filter((t) => isUnderRootDir(t, rootDir));
        if (confinedTests.length === 0) continue;
        if (!reverse.has(file)) reverse.set(file, new Set(confinedTests));
        else for (const t of confinedTests) reverse.get(file)!.add(t);
      }
    }
  }

  return { forward, reverse };
}

/**
 * Serialize the forward graph to disk in JSON v1 format.
 * Uses an atomic temp-then-rename write strategy.
 *
 * Phase 3: async path is startup-only; runtime edges persisted via saveGraphSyncInternal
 *
 * @param forward   Forward dependency map (file → Set of imported files)
 * @param cacheDir  Directory where `graph.json` should be written
 */
export async function saveGraph(
  forward: Map<string, Set<string>>,
  cacheDir: string,
): Promise<void> {
  mkdirSync(cacheDir, { recursive: true });

  // Collect mtimes for all files in the forward map
  const files: Record<string, CacheFileEntry> = {};
  for (const [filePath, imports] of forward) {
    let mtime = 0;
    try {
      mtime = lstatSync(filePath).mtimeMs;
    } catch {
      // File may not exist (e.g. deleted between graph build and save) — record 0
    }
    files[filePath] = {
      mtime,
      imports: [...imports],
    };
  }

  // Preserve existing runtimeEdges from disk (read-merge-write)
  let runtimeEdges: Record<string, string[]> | undefined;
  const cachePath = path.join(cacheDir, GRAPH_FILE);
  try {
    const raw = await readFile(cachePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw, safeJsonReviver);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as CacheDiskFormat).runtimeEdges !== undefined
    ) {
      const existing = (parsed as CacheDiskFormat).runtimeEdges;
      if (existing !== undefined && isValidRuntimeEdgesObject(existing)) {
        runtimeEdges = pruneRuntimeEdges(existing, new Set(forward.keys()));
      }
    }
  } catch {
    // ENOENT or JSON parse error — no existing runtime edges to preserve
  }

  const payload: CacheDiskFormat = {
    version: CACHE_VERSION,
    builtAt: Date.now(),
    files,
    ...(runtimeEdges !== undefined ? { runtimeEdges } : {}),
  };

  const json = JSON.stringify(payload);

  // Atomic write: write to temp file in same directory, then rename
  const rand = Math.random().toString(36).slice(2);
  const tmpPath = path.join(cacheDir, `.tmp-${rand}`);
  writeFileSync(tmpPath, json, 'utf-8');
  renameSync(tmpPath, path.join(cacheDir, GRAPH_FILE));
}

// ---------------------------------------------------------------------------
// Sync variants — required for onFilterWatchedSpecification (synchronous hook)
// ---------------------------------------------------------------------------

/**
 * Stat loop returning mtime map.
 * Accepts any Iterable<string> (designed for `forward.keys()`).
 * Skips files that throw ENOENT gracefully.
 */
export function statAllFiles(files: Iterable<string>): Map<string, number> {
  const result = new Map<string, number>();
  for (const file of files) {
    try {
      result.set(file, lstatSync(file).mtimeMs);
    } catch {
      // ENOENT or other error — skip
    }
  }
  return result;
}

/**
 * Pure function comparing two mtime maps.
 * - changed: files present in both maps with different mtimes
 * - added:   files present in currentMtimes but not in cachedMtimes
 * - deleted: files present in cachedMtimes but not in currentMtimes
 */
export function diffGraphMtimes(
  cachedMtimes: Map<string, number>,
  currentMtimes: Map<string, number>,
): { changed: string[]; added: string[]; deleted: string[] } {
  const changed: string[] = [];
  const added: string[] = [];
  const deleted: string[] = [];

  for (const [file, currentMtime] of currentMtimes) {
    if (!cachedMtimes.has(file)) {
      added.push(file);
    } else if (cachedMtimes.get(file) !== currentMtime) {
      changed.push(file);
    }
  }

  for (const file of cachedMtimes.keys()) {
    if (!currentMtimes.has(file)) {
      deleted.push(file);
    }
  }

  return { changed, added, deleted };
}

/**
 * Read mtime map from cached `graph.json` file.
 * Returns empty Map on ENOENT (cache file missing) or JSON.parse error.
 * Extracts `files[path].mtime` entries from the cache format.
 */
export function loadCachedMtimes(cacheDir: string): Map<string, number> {
  const cachePath = path.join(cacheDir, GRAPH_FILE);
  try {
    const raw = readFileSync(cachePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw, safeJsonReviver);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as CacheDiskFormat).version !== CACHE_VERSION
    ) {
      return new Map();
    }
    const disk = parsed as CacheDiskFormat;
    const result = new Map<string, number>();
    for (const [filePath, entry] of Object.entries(disk.files)) {
      result.set(filePath, entry.mtime);
    }
    return result;
  } catch {
    // ENOENT or JSON.parse error
    return new Map();
  }
}

/**
 * Prune stale runtimeEdges from a serialized record.
 *
 * - Keys not present in `forwardKeys` are removed (source file no longer tracked).
 * - Values are filtered to paths that exist in `forwardKeys` OR on disk (existsSync).
 *   This handles renamed/deleted test files that are no longer tracked.
 */
function pruneRuntimeEdges(
  edges: Record<string, string[]>,
  forwardKeys: Set<string>,
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [key, values] of Object.entries(edges)) {
    // Prune keys not in forward map
    if (!forwardKeys.has(key)) continue;

    // Filter values: keep only those in forward OR on disk
    const validValues = values.filter(
      (v) => forwardKeys.has(v) || existsSync(v),
    );
    if (validValues.length > 0) {
      result[key] = validValues;
    }
  }
  return result;
}

/**
 * Sync cache persistence.
 * Uses same atomic write pattern (temp file → renameSync).
 * If `mtimes` is provided, use it instead of stat-ing files again.
 * If not provided, calls `statAllFiles` internally.
 * Note: second stat pass per batch — accepted for simpler API surface.
 *
 * When `runtimeEdges` is PROVIDED: serializes and includes in the JSON payload.
 * When `runtimeEdges` is OMITTED (e.g., watch filter save): reads the existing
 * cache file and preserves its `runtimeEdges` field (read-merge-write pattern).
 * This prevents the watch filter from erasing previously persisted runtime edges.
 *
 * In BOTH branches, stale runtimeEdges are pruned:
 * - Keys not in the forward map are removed.
 * - Values (test paths) not in forward AND not on disk are removed.
 */
export function saveGraphSyncInternal(
  forward: Map<string, Set<string>>,
  cacheDir: string,
  mtimes?: Map<string, number>,
  runtimeEdges?: Map<string, Set<string>>,
): void {
  mkdirSync(cacheDir, { recursive: true });

  const resolvedMtimes = mtimes ?? statAllFiles(forward.keys());
  const forwardKeys = new Set(forward.keys());

  const files: Record<string, CacheFileEntry> = {};
  for (const [filePath, imports] of forward) {
    files[filePath] = {
      mtime: resolvedMtimes.get(filePath) ?? 0,
      imports: [...imports],
    };
  }

  let serializedRuntimeEdges: Record<string, string[]> | undefined;

  if (runtimeEdges !== undefined) {
    // Caller provided runtime edges — serialize them, then prune stale entries.
    // Always write the field when explicitly provided (even if empty after pruning).
    const raw: Record<string, string[]> = {};
    for (const [file, tests] of runtimeEdges) {
      raw[file] = [...tests];
    }
    serializedRuntimeEdges = pruneRuntimeEdges(raw, forwardKeys);
  } else {
    // runtimeEdges omitted — read-merge-write: preserve existing from disk, then prune
    const cachePath = path.join(cacheDir, GRAPH_FILE);
    try {
      const rawFile = readFileSync(cachePath, 'utf-8');
      const parsed: unknown = JSON.parse(rawFile, safeJsonReviver);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        (parsed as CacheDiskFormat).runtimeEdges !== undefined &&
        isValidRuntimeEdgesObject((parsed as CacheDiskFormat).runtimeEdges)
      ) {
        const pruned = pruneRuntimeEdges(
          (parsed as CacheDiskFormat).runtimeEdges!,
          forwardKeys,
        );
        if (Object.keys(pruned).length > 0) {
          serializedRuntimeEdges = pruned;
        }
      }
    } catch {
      // ENOENT or JSON parse error — no existing runtime edges to preserve
    }
  }

  const payload: CacheDiskFormat = {
    version: CACHE_VERSION,
    builtAt: Date.now(),
    files,
    ...(serializedRuntimeEdges !== undefined ? { runtimeEdges: serializedRuntimeEdges } : {}),
  };

  const json = JSON.stringify(payload);

  // Atomic write: write to temp file in same directory, then rename
  const rand = Math.random().toString(36).slice(2);
  const tmpPath = path.join(cacheDir, `.tmp-${rand}`);
  writeFileSync(tmpPath, json, 'utf-8');
  renameSync(tmpPath, path.join(cacheDir, GRAPH_FILE));
}

/**
 * Sync cache-aware graph loading.
 * On cache miss/error: calls `buildFullGraphSync` for FULL REBUILD.
 * On cache hit: checks if ANY file has changed mtime — if so, FULL REBUILD.
 * On cache hit with NO stale files: rebuilds from cached entries.
 *
 * CRITICAL: The sync variant does FULL REBUILD on any staleness,
 * NOT incremental per-file reparse like the async version.
 * This is intentional — simpler, and ~166ms is acceptable for watch mode.
 *
 * Returns `oldMtimes` and `currentMtimes` so callers (e.g. watch filter)
 * can reuse the mtime data already computed internally, avoiding redundant
 * I/O. On full rebuild (cache miss or staleness), both are empty Maps.
 */
export function loadOrBuildGraphSync(
  rootDir: string,
  cacheDir: string,
): {
  forward: Map<string, Set<string>>;
  reverse: Map<string, Set<string>>;
  oldMtimes: Map<string, number>;
  currentMtimes: Map<string, number>;
} {
  // Clean up orphaned temp files
  cleanupOrphanedTmp(cacheDir);

  const cachePath = path.join(cacheDir, GRAPH_FILE);

  // --- Attempt cache read ---
  let disk: CacheDiskFormat | null = null;
  try {
    const raw = readFileSync(cachePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw, safeJsonReviver);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as CacheDiskFormat).version === CACHE_VERSION
    ) {
      const candidate = parsed as { version: 1; builtAt: number; files: unknown; runtimeEdges?: unknown };

      // Schema validation: disk.files must be a valid plain object
      if (!isValidFilesObject(candidate.files)) {
        // Schema violation in disk.files → full rebuild
        const { forward, reverse } = buildFullGraphSync(rootDir);
        return { forward, reverse, oldMtimes: new Map(), currentMtimes: new Map() };
      }

      disk = candidate as CacheDiskFormat;
    }
  } catch {
    // ENOENT or JSON.parse error → fall through to full rebuild
  }

  const emptyMtimes = new Map<string, number>();

  if (disk === null) {
    // Cache miss — full rebuild; return empty mtime maps
    const { forward, reverse } = buildFullGraphSync(rootDir);
    return { forward, reverse, oldMtimes: emptyMtimes, currentMtimes: new Map() };
  }

  // --- Path confinement: pre-filter disk.files entries to rootDir ---
  const validFiles: Array<[string, CacheFileEntry]> = [];
  for (const [filePath, entry] of Object.entries(disk.files)) {
    if (!isUnderRootDir(filePath, rootDir)) {
      // Skip entries outside rootDir (path confinement)
      continue;
    }
    validFiles.push([filePath, entry]);
  }

  // --- Cache hit: check if any file is stale ---
  const cachedMtimes = new Map<string, number>();
  for (const [filePath, entry] of validFiles) {
    cachedMtimes.set(filePath, entry.mtime);
  }

  const currentMtimes = statAllFiles(cachedMtimes.keys());
  const { changed, added, deleted } = diffGraphMtimes(cachedMtimes, currentMtimes);

  if (changed.length > 0 || added.length > 0 || deleted.length > 0) {
    // Any staleness → full rebuild; return empty mtime maps
    const { forward, reverse } = buildFullGraphSync(rootDir);
    return { forward, reverse, oldMtimes: new Map(), currentMtimes: new Map() };
  }

  // --- No changes — rebuild maps from cached entries ---
  const entries = new Map<string, string[]>();
  for (const [filePath, entry] of validFiles) {
    // Filter out imports that no longer exist on disk (consistent with async path)
    entries.set(filePath, entry.imports.filter((imp) => existsSync(imp)));
  }

  const { forward, reverse } = entriesToMaps(entries);

  // Merge persisted runtime edges into the reverse map
  if (disk.runtimeEdges !== undefined) {
    // Schema validation: runtimeEdges must be a valid plain object with string[] values
    if (!isValidRuntimeEdgesObject(disk.runtimeEdges)) {
      // Skip merge only — static graph is still valid, no full rebuild
    } else {
      // Path confinement: only merge keys that are under rootDir
      for (const [file, tests] of Object.entries(disk.runtimeEdges)) {
        if (!isUnderRootDir(file, rootDir)) {
          continue;
        }
        // Filter test values to only those under rootDir
        const confinedTests = tests.filter((t) => isUnderRootDir(t, rootDir));
        if (confinedTests.length === 0) continue;
        if (!reverse.has(file)) reverse.set(file, new Set(confinedTests));
        else for (const t of confinedTests) reverse.get(file)!.add(t);
      }
    }
  }

  // Cache hit with no staleness — return the mtime data so callers can reuse it
  return { forward, reverse, oldMtimes: cachedMtimes, currentMtimes };
}
