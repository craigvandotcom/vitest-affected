import path from 'node:path';
import { toCanonicalPath } from './graph/normalize.js';

const DEFAULT_RELEVANT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx',
  '.mts', '.cts', '.mjs', '.cjs',
  '.json',
]);

const DEFAULT_IGNORE_PATH_PREFIXES = [
  '.claude/',
  '.git/',
  '.next/',
  '.vitest-affected/',
  'playwright-report/',
  'test-results/',
];

const DEFAULT_IGNORE_BASENAMES = new Set([
  '.gitleaksignore',
  '.prettierignore',
  'next-env.d.ts',
]);

export interface ChangedFileFilterResult {
  changed: string[];
  deleted: string[];
  ignored: string[];
}

export interface ChangedFileFilterOptions {
  ignoreChangedFiles?: Array<string | RegExp>;
  includeChangedExtensions?: string[];
  /**
   * Set of basenames that should always be treated as relevant
   * (e.g. config files that trigger full-suite runs). The filter never drops
   * these even if extension/path rules would otherwise ignore them.
   */
  configBasenames?: ReadonlySet<string>;
}

function matchesPathPrefix(rel: string, prefix: string): boolean {
  return rel === prefix.replace(/\/$/, '') || rel.startsWith(prefix);
}

/**
 * Match a repo-relative path against a list of rules. A string rule matches by
 * exact path or path-prefix (a directory); a RegExp rule matches by `.test()`.
 * Shared by the changed-file ignore filter and the plugin's full-suite triggers
 * so both honour identical semantics.
 */
export function matchesAnyRule(rel: string, rules: Array<string | RegExp>): boolean {
  for (const rule of rules) {
    if (typeof rule === 'string') {
      if (rel === rule || matchesPathPrefix(rel, rule.endsWith('/') ? rule : rule + '/')) {
        return true;
      }
    } else if (rule.test(rel)) {
      return true;
    }
  }
  return false;
}

/**
 * Convert an absolute (or already-relative) path to a forward-slash,
 * root-relative path — the form rule matching expects. Both sides are routed
 * through toCanonicalPath so a filePath/rootDir pair that differ only by a
 * symlink alias (or Windows separators) still compare correctly.
 */
export function toRepoRelative(filePath: string, rootDir: string): string {
  const normalized = toCanonicalPath(filePath);
  const root = toCanonicalPath(rootDir);
  return normalized.startsWith(root + '/')
    ? normalized.slice(root.length + 1)
    : normalized;
}

function isRelevant(
  filePath: string,
  rootDir: string,
  options: ChangedFileFilterOptions,
): boolean {
  const rel = toRepoRelative(filePath, rootDir);
  const basename = path.basename(rel);

  // Config files are always relevant — they trigger full-suite runs downstream.
  if (options.configBasenames?.has(basename)) return true;

  // Caller-provided ignore patterns
  if (options.ignoreChangedFiles && matchesAnyRule(rel, options.ignoreChangedFiles)) {
    return false;
  }

  // Built-in path-prefix ignores
  for (const prefix of DEFAULT_IGNORE_PATH_PREFIXES) {
    if (matchesPathPrefix(rel, prefix)) return false;
  }

  // Built-in basename ignores
  if (DEFAULT_IGNORE_BASENAMES.has(basename)) return false;

  // Extension allowlist (caller can widen)
  const allowed = options.includeChangedExtensions
    ? new Set(options.includeChangedExtensions.map((e) => (e.startsWith('.') ? e : '.' + e)))
    : DEFAULT_RELEVANT_EXTENSIONS;
  const ext = path.extname(basename).toLowerCase();
  return allowed.has(ext);
}

/**
 * Filter changed/deleted files to those that could actually affect the
 * dependency graph. Reduces noise (parse warnings, "not in graph" warnings)
 * for files that can never participate in the graph (markdown, .claude/, etc).
 *
 * Config-file basenames in `options.configBasenames` are always preserved so
 * the plugin's full-suite trigger still fires.
 */
export function filterRelevantChangedFiles(
  files: { changed: string[]; deleted: string[] },
  rootDir: string,
  options: ChangedFileFilterOptions,
): ChangedFileFilterResult {
  const out: ChangedFileFilterResult = { changed: [], deleted: [], ignored: [] };
  for (const f of files.changed) {
    if (isRelevant(f, rootDir, options)) out.changed.push(f);
    else out.ignored.push(f);
  }
  for (const f of files.deleted) {
    if (isRelevant(f, rootDir, options)) out.deleted.push(f);
    else out.ignored.push(f);
  }
  return out;
}
