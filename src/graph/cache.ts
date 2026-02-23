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
import { buildFullGraph, createResolver, resolveFileImports } from './builder.js';

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
function entriestoMaps(
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
    const raw = readFileSync(cachePath, 'utf-8');
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
        // Read error → use empty imports for this file
        refreshed.set(filePath, []);
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

  return entriestoMaps(refreshed);
}

/**
 * Serialize the forward graph to disk in JSON v1 format.
 * Uses an atomic temp-then-rename write strategy.
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

  const payload: CacheDiskFormat = {
    version: CACHE_VERSION,
    builtAt: Date.now(),
    files,
  };

  const json = JSON.stringify(payload);

  // Atomic write: write to temp file in same directory, then rename
  const rand = Math.random().toString(36).slice(2);
  const tmpPath = path.join(cacheDir, `.tmp-${rand}`);
  writeFileSync(tmpPath, json, 'utf-8');
  renameSync(tmpPath, path.join(cacheDir, GRAPH_FILE));
}
