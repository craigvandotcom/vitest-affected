import { realpathSync } from 'node:fs';
import path from 'node:path';

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

/** Memoizes toCanonicalPath results for the lifetime of the module (one process). */
const canonicalPathCache = new Map<string, string>();

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
 */
export function toCanonicalPath(inputPath: string): string {
  const cached = canonicalPathCache.get(inputPath);
  if (cached !== undefined) return cached;

  const result = computeCanonicalPath(inputPath);
  canonicalPathCache.set(inputPath, result);
  return result;
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

  while (true) {
    try {
      const real = toForwardSlashes(realpathSync(current));
      if (missingSuffix.length === 0) return real;
      const suffix = [...missingSuffix].reverse().join('/');
      return real.endsWith('/') ? `${real}${suffix}` : `${real}/${suffix}`;
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
