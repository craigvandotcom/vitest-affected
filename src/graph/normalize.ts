import { realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * Neutralize terminal control sequences before a file path or import specifier
 * is interpolated into console output. Git allows arbitrary bytes in filenames
 * (only `/` and NUL are forbidden), and while git's own porcelain output is
 * quotePath-escaped, paths that reach us via tinyglobby globs, the on-disk
 * cache, or the Vite resolver bypass that escaping entirely. An attacker who
 * controls a filename could otherwise embed ANSI/C0/C1 escapes that rewrite the
 * developer's terminal (cursor moves, title spoofing, hidden text) when the
 * plugin logs that path. Replace every C0 control (incl. ESC 0x1b), DEL, and
 * C1 control with `?` so the label is inert but still recognizable. Purely a
 * display shield — never mutate a path used for graph identity or filesystem
 * access (those flow through toCanonicalPath, not this).
 */
export function safeLabel(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x1f\x7f-\x9f]/g, '?');
}

/**
 * Strip Vite-specific prefixes and suffixes from spec.moduleId before graph lookup.
 * Without normalization, the watch filter becomes a silent no-op.
 */
export function normalizeModuleId(id: string): string {
  // Strip \0 prefix (Vite virtual module marker)
  if (id.startsWith('\0')) id = id.slice(1);
  // Strip /@fs/ (Vite dev server prefix for files outside root)
  if (id.startsWith('/@fs/')) id = id.slice(5);
  // /@id/ = pre-bundled dep — not in our graph, return as-is (conservative true)
  else if (id.startsWith('/@id/')) return id;
  // Strip query string (?v=123, ?import, etc.)
  const qIdx = id.indexOf('?');
  if (qIdx !== -1) id = id.slice(0, qIdx);
  return id;
}

// ---------------------------------------------------------------------------
// toCanonicalPath — the single path-identity boundary for the whole plugin
// ---------------------------------------------------------------------------
//
// Path-identity bugs (Windows separators, macOS /var → /private/var symlinks,
// a symlinked project rootDir) are this plugin's most recurrent silent-failure
// source: two representations of the same file compare unequal as Map keys,
// so a changed file silently fails to match its graph entry and gets dropped
// rather than erroring. toCanonicalPath is the one place that normalizes both
// separators and symlink identity; every path-boundary in this codebase
// (git output, cache keys, changed-file resolution, reporter module paths)
// should route through it rather than reimplementing `replaceAll('\\', '/')`
// locally.

/**
 * Upper bound on the memo. On reaching it the whole Map is cleared and growth
 * restarts — re-derivation is cheap (a realpathSync), and unbounded growth in a
 * long-lived watch-mode process is the harm being bounded, not lookup misses.
 */
const MAX_CANONICAL_CACHE = 10_000;

/** Memoizes toCanonicalPath results for the lifetime of the module (one process). */
const canonicalPathCache = new Map<string, string>();

/**
 * Clear the module-scope canonicalization memo. Intended for TESTS whose
 * fixtures create then delete symlinked directories: a symlink resolved and
 * cached in one test could otherwise serve a stale canonical result to a later
 * test that reuses a path string. Production code relies on the automatic
 * cap-clear (MAX_CANONICAL_CACHE) and process lifetime instead.
 */
export function clearCanonicalPathCache(): void {
  canonicalPathCache.clear();
}

/** Memoized set with the size cap: clear-and-continue on overflow. */
function memoSet(key: string, value: string): string {
  if (canonicalPathCache.size >= MAX_CANONICAL_CACHE) {
    canonicalPathCache.clear();
  }
  canonicalPathCache.set(key, value);
  return value;
}

/** Separator normalization only — the realpath-free half of toCanonicalPath. */
function toForwardSlashes(p: string): string {
  return p.replaceAll('\\', '/');
}

/**
 * Resolve symlinks via realpathSync, then normalize separators to forward
 * slashes. Absolute paths only realpath meaningfully — a string that isn't
 * absolute on the current platform (e.g. a Windows drive-letter path like
 * `C:/foo` exercised in a cross-platform unit test while running on POSIX,
 * or a genuinely relative path) is left as forward-slash-normalized input:
 * calling realpathSync on it would resolve against `process.cwd()` and
 * produce a nonsensical result, since every real boundary in this codebase
 * already resolves to an absolute path before calling toCanonicalPath.
 *
 * Files may not exist yet (git reports deleted files; a file about to be
 * created) — realpathSync throws ENOENT in that case. Rather than propagate
 * the error, walk up to the nearest existing ancestor, realpath THAT, and
 * re-append the missing suffix. This still converges a symlinked ancestor
 * (e.g. the project root itself) even when the leaf file is gone. If no
 * ancestor exists short of the filesystem root, the input is returned
 * unchanged (nothing to canonicalize against).
 *
 * Memoized at module scope: a single vitest invocation can process hundreds
 * of git-reported paths and reporter module paths, and repeated realpathSync
 * calls on the same string are wasted syscalls. The cache is an internal
 * performance detail — callers see a pure function.
 *
 * DELIBERATE LIMITATION: because results are memoized for the process lifetime,
 * a symlink retargeted mid-process (e.g. during a long watch-mode session)
 * continues to serve the previously-resolved canonical path until the memo is
 * cleared (the MAX_CANONICAL_CACHE cap-clear) or the process restarts. This is
 * fail-safe: a stale canonical path merely orphans its graph entry, and the
 * cache-miss / full-suite fallback re-records it canonically on the next run.
 */
export function toCanonicalPath(inputPath: string): string {
  const cached = canonicalPathCache.get(inputPath);
  if (cached !== undefined) return cached;

  const result = computeCanonicalPath(inputPath);
  return memoSet(inputPath, result);
}

function computeCanonicalPath(inputPath: string): string {
  const forwardSlash = toForwardSlashes(inputPath);
  if (!path.isAbsolute(forwardSlash)) {
    return forwardSlash;
  }
  return realpathOrNearestAncestor(forwardSlash);
}

function realpathOrNearestAncestor(absolutePath: string): string {
  let current = absolutePath;
  const missingSuffix: string[] = [];

  const withSuffix = (real: string): string => {
    if (missingSuffix.length === 0) return real;
    const suffix = [...missingSuffix].reverse().join('/');
    return real.endsWith('/') ? `${real}${suffix}` : `${real}/${suffix}`;
  };

  while (true) {
    // Consult the memo for the current ancestor first: sibling deleted paths
    // (e.g. /dir/gone1.ts and /dir/gone2.ts) both walk up to the same existing
    // ancestor, so caching the ancestor's own resolution lets them share the
    // realpathSync lookup rather than each re-syscalling it.
    const memoized = canonicalPathCache.get(current);
    if (memoized !== undefined) return withSuffix(memoized);

    try {
      const real = toForwardSlashes(realpathSync(current));
      // Cache the ancestor's own canonical resolution (keyed by the ancestor
      // path) so subsequent siblings hit the memo above.
      memoSet(current, real);
      return withSuffix(real);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        // Reached the filesystem root without finding an existing ancestor.
        return absolutePath;
      }
      missingSuffix.push(path.basename(current));
      current = parent;
    }
  }
}
