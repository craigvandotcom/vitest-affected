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
import { buildFullGraph, buildFullGraphSync, createResolver, resolveFileImports } from './builder.js';

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
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as CacheDiskFormat).version === CACHE_VERSION
    ) {
      disk = parsed as CacheDiskFormat;
    }
    // else: unknown version → fall through to full rebuild
  } catch {
    // ENOENT or JSON.parse error → fall through to full rebuild
  }

  if (disk === null) {
    // Cache miss — full rebuild
    return buildFullGraph(rootDir);
  }

  // --- Cache hit: stat each file, reparse stale ones ---
  const resolver = createResolver(rootDir);
  const refreshed = new Map<string, string[]>();
  let staleCount = 0;

  for (const [filePath, entry] of Object.entries(disk.files)) {
    // If file no longer exists, skip it (deleted between runs)
    if (!existsSync(filePath)) {
      continue;
    }

    let currentMtime: number;
    try {
      currentMtime = lstatSync(filePath).mtimeMs;
    } catch {
      // Can't stat → skip this file
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

  const { forward, reverse } = entriesToMaps(refreshed);

  // Merge persisted runtime edges into the reverse map
  if (disk.runtimeEdges) {
    for (const [file, tests] of Object.entries(disk.runtimeEdges)) {
      if (!reverse.has(file)) reverse.set(file, new Set(tests));
      else for (const t of tests) reverse.get(file)!.add(t);
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
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as CacheDiskFormat).runtimeEdges !== undefined
    ) {
      runtimeEdges = (parsed as CacheDiskFormat).runtimeEdges;
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
    const parsed: unknown = JSON.parse(raw);
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
 */
export function saveGraphSyncInternal(
  forward: Map<string, Set<string>>,
  cacheDir: string,
  mtimes?: Map<string, number>,
  runtimeEdges?: Map<string, Set<string>>,
): void {
  mkdirSync(cacheDir, { recursive: true });

  const resolvedMtimes = mtimes ?? statAllFiles(forward.keys());

  const files: Record<string, CacheFileEntry> = {};
  for (const [filePath, imports] of forward) {
    files[filePath] = {
      mtime: resolvedMtimes.get(filePath) ?? 0,
      imports: [...imports],
    };
  }

  let serializedRuntimeEdges: Record<string, string[]> | undefined;

  if (runtimeEdges !== undefined) {
    // Caller provided runtime edges — serialize them
    serializedRuntimeEdges = {};
    for (const [file, tests] of runtimeEdges) {
      serializedRuntimeEdges[file] = [...tests];
    }
  } else {
    // runtimeEdges omitted — read-merge-write: preserve existing from disk
    const cachePath = path.join(cacheDir, GRAPH_FILE);
    try {
      const raw = readFileSync(cachePath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        (parsed as CacheDiskFormat).runtimeEdges !== undefined
      ) {
        serializedRuntimeEdges = (parsed as CacheDiskFormat).runtimeEdges;
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
 */
export function loadOrBuildGraphSync(
  rootDir: string,
  cacheDir: string,
): {
  forward: Map<string, Set<string>>;
  reverse: Map<string, Set<string>>;
} {
  // Clean up orphaned temp files
  cleanupOrphanedTmp(cacheDir);

  const cachePath = path.join(cacheDir, GRAPH_FILE);

  // --- Attempt cache read ---
  let disk: CacheDiskFormat | null = null;
  try {
    const raw = readFileSync(cachePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as CacheDiskFormat).version === CACHE_VERSION
    ) {
      disk = parsed as CacheDiskFormat;
    }
  } catch {
    // ENOENT or JSON.parse error → fall through to full rebuild
  }

  if (disk === null) {
    // Cache miss — full rebuild
    return buildFullGraphSync(rootDir);
  }

  // --- Cache hit: check if any file is stale ---
  const cachedMtimes = new Map<string, number>();
  for (const [filePath, entry] of Object.entries(disk.files)) {
    cachedMtimes.set(filePath, entry.mtime);
  }

  const currentMtimes = statAllFiles(cachedMtimes.keys());
  const { changed, added, deleted } = diffGraphMtimes(cachedMtimes, currentMtimes);

  if (changed.length > 0 || added.length > 0 || deleted.length > 0) {
    // Any staleness → full rebuild
    return buildFullGraphSync(rootDir);
  }

  // --- No changes — rebuild maps from cached entries ---
  const entries = new Map<string, string[]>();
  for (const [filePath, entry] of Object.entries(disk.files)) {
    // Filter out imports that no longer exist on disk (consistent with async path)
    entries.set(filePath, entry.imports.filter((imp) => existsSync(imp)));
  }

  const { forward, reverse } = entriesToMaps(entries);

  // Merge persisted runtime edges into the reverse map
  if (disk.runtimeEdges) {
    for (const [file, tests] of Object.entries(disk.runtimeEdges)) {
      if (!reverse.has(file)) reverse.set(file, new Set(tests));
      else for (const t of tests) reverse.get(file)!.add(t);
    }
  }

  return { forward, reverse };
}
