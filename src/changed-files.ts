import path from 'node:path';

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

function toForwardSlashes(p: string): string {
  return p.replaceAll('\\', '/');
}

function matchesPathPrefix(rel: string, prefix: string): boolean {
  return rel === prefix.replace(/\/$/, '') || rel.startsWith(prefix);
}

function isIgnoredByOption(rel: string, ignore: Array<string | RegExp>): boolean {
  for (const rule of ignore) {
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

function isRelevant(
  filePath: string,
  rootDir: string,
  options: ChangedFileFilterOptions,
): boolean {
  const normalized = toForwardSlashes(filePath);
  const root = toForwardSlashes(rootDir);
  const rel = normalized.startsWith(root + '/')
    ? normalized.slice(root.length + 1)
    : normalized;
  const basename = path.basename(rel);

  // Config files are always relevant — they trigger full-suite runs downstream.
  if (options.configBasenames?.has(basename)) return true;

  // Caller-provided ignore patterns
  if (options.ignoreChangedFiles && isIgnoredByOption(rel, options.ignoreChangedFiles)) {
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
