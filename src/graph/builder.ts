import { ResolverFactory } from 'oxc-resolver';
import { parseSync } from 'oxc-parser';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { safeLabel, toCanonicalPath } from './normalize.js';
import type { ReverseMap } from './types.js';

const BINARY_EXTENSIONS = new Set([
  '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.mp3', '.mp4', '.wav', '.ogg', '.webm',
  '.pdf', '.zip', '.tar', '.gz',
  '.css', '.scss', '.sass', '.less',
]);

function isBinarySpecifier(specifier: string): boolean {
  const ext = path.extname(specifier).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

/**
 * Strips a Vite query suffix (`?raw`, `?url`, `?inline`, ...) from a
 * specifier for resolution purposes. oxc-resolver has no notion of Vite's
 * query-string module variants — it can only resolve the bare on-disk path
 * (`./x.css`), never the suffixed form (`./x.css?raw`) — so the suffix must
 * be stripped before every `resolver.sync` call.
 *
 * Splitting on the FIRST `?` (not the last) matches URL semantics: a
 * specifier can only have one query component, and everything from that
 * point on — including any further `?`/`#` characters a pathological query
 * value might contain — belongs to it.
 */
function stripQuerySuffix(specifier: string): { bare: string; hadQuery: boolean } {
  const queryIndex = specifier.indexOf('?');
  if (queryIndex === -1) return { bare: specifier, hadQuery: false };
  return { bare: specifier.slice(0, queryIndex), hadQuery: true };
}

/**
 * Matches `new Worker(new URL('./specifier', import.meta.url))` and
 * `new SharedWorker(new URL('./specifier', import.meta.url))` — a
 * NewExpression construct that oxc-parser's staticImports/dynamicImports/
 * staticExports never see (those only surface import/export declaration
 * syntax, not arbitrary `new` calls).
 *
 * Implemented as a targeted regex scan over the raw source rather than an
 * ESTree AST walk: oxc-parser's `parseSync` result exposes pre-extracted
 * import/export lists, not a walkable Program AST — reaching the
 * NewExpression node would mean pulling in a second traversal library (or
 * hand-rolling one over oxc's AST shape) for one narrow construct. The
 * shape matched here is narrow and requires a literal string specifier to
 * be resolvable at all, so pattern-matching the source text is
 * proportionate to the problem.
 *
 * Only plain-quoted (`'` / `"`) string literals are captured. Template
 * literals are excluded entirely (whether or not they contain `${}`
 * expressions) — worker specifiers are far less likely to need runtime
 * interpolation than ordinary dynamic imports, and skipping the whole
 * class keeps this scan simple; this is a deliberate (narrower) policy
 * choice, not a reuse of the dynamic-import no-expression-backtick carve-out.
 */
const WORKER_URL_RE =
  /new\s+(?:Worker|SharedWorker)\s*\(\s*new\s+URL\s*\(\s*(['"])([^'"]*)\1\s*,\s*import\.meta\.url\s*\)/g;

function extractWorkerSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(WORKER_URL_RE)) {
    specifiers.push(match[2]);
  }
  return specifiers;
}

/**
 * Mirrors Vite's resolved `Alias` shape (`ResolvedConfig.resolve.alias`) —
 * declared locally rather than imported from 'vite' so this module doesn't
 * take on a vite dependency; only the two fields we consume are declared.
 * Callers (e.g. plugin.ts) pass `project.vite.config.resolve.alias` directly;
 * it satisfies this type structurally.
 */
export interface AliasEntry {
  find: string | RegExp;
  replacement: string;
}

/**
 * Converts Vite-shaped alias entries into oxc-resolver's `alias` config
 * (`Record<string, string[]>`, string keys only). RegExp finds are NOT
 * converted — see createResolver's console.warn for why — and are excluded
 * from the returned record. Returns undefined when there is nothing usable,
 * so callers can spread it in conditionally without an empty-object no-op.
 */
function buildAliasRecord(aliasEntries: AliasEntry[] | undefined): {
  record: Record<string, string[]> | undefined;
  regexSkippedCount: number;
} {
  if (!aliasEntries || aliasEntries.length === 0) {
    return { record: undefined, regexSkippedCount: 0 };
  }
  const record: Record<string, string[]> = {};
  let regexSkippedCount = 0;
  for (const entry of aliasEntries) {
    if (entry.find instanceof RegExp) {
      // Vite unconditionally injects two built-in RegExp aliases into every
      // resolved config (@vite/env and @vite/client, replaced with paths under
      // vite/dist/client/). They are dev-client plumbing with no bearing on
      // test selection — counting them would make the RegExp warning fire on
      // every single run. Ignore them silently; count only USER RegExp aliases.
      const isViteBuiltin =
        entry.find.source.includes('@vite/') ||
        entry.replacement.includes('/vite/dist/client/');
      if (!isViteBuiltin) regexSkippedCount++;
      continue;
    }
    record[entry.find] = [entry.replacement];
  }
  return {
    record: Object.keys(record).length > 0 ? record : undefined,
    regexSkippedCount,
  };
}

export function createResolver(rootDir: string, aliasEntries?: AliasEntry[]): ResolverFactory {
  const tsconfigPath = path.join(rootDir, 'tsconfig.json');
  const hasTsconfig = existsSync(tsconfigPath);
  if (!hasTsconfig) {
    console.warn('[vitest-affected] No tsconfig.json found — path aliases will not resolve');
  }
  const { record: alias, regexSkippedCount } = buildAliasRecord(aliasEntries);
  if (regexSkippedCount > 0) {
    // Documented limitation: a RegExp `find` (e.g. Vite's own built-in
    // `@vite/client` / `@vite/env` aliases, or a user regex alias) cannot be
    // fed into oxc-resolver's alias config, which only accepts string keys.
    // A lossy string conversion would silently reopen the resolution hole
    // this feature closes, so we skip it instead — runtime edges (collected
    // once the cache is warm) still cover these imports; only the
    // cache-miss / brand-new-import window is affected.
    console.warn(
      `[vitest-affected] resolve.alias has ${regexSkippedCount} RegExp find(s) that cannot be fed into the static delta-parser resolver — skipped (runtime edges still cover them once the cache is warm)`,
    );
  }
  return new ResolverFactory({
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.json'],
    extensionAlias: {
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
      '.cjs': ['.cts', '.cjs'],
    },
    conditionNames: ['node', 'import'],
    ...(hasTsconfig ? { tsconfig: { configFile: tsconfigPath, references: 'auto' } } : {}),
    ...(alias ? { alias } : {}),
    builtinModules: true,
  });
}

/**
 * Result of statically extracting a changed file's import targets.
 *
 * `parseFailed` makes an oxc parse error OBSERVABLE to callers instead of being
 * swallowed: on a parse error we still return the PARTIAL `targets` extracted
 * before the broken point (partial ≥ nothing — discarding it would strictly
 * under-seed), but the flag lets a caller know the target list may be
 * incomplete.
 */
export interface FileImportsResult {
  /** Import targets resolved from the file (partial if `parseFailed`). */
  targets: string[];
  /** True if oxc reported parse errors — `targets` may be incomplete. */
  parseFailed: boolean;
}

export function resolveFileImports(
  file: string,
  source: string,
  rootDir: string,
  resolver: ResolverFactory,
): FileImportsResult {
  const { module: mod, errors } = parseSync(file, source);
  // ACCEPTED RESIDUAL (self-healing): on a parse error we proceed with the
  // PARTIAL specifier list oxc extracted before the broken point — partial ≥
  // nothing, since discarding it would strictly under-seed. A brand-new import
  // appearing AFTER a mid-edit syntax error can be missed until the file parses
  // clean and re-runs; the miss is warned here and resolves on the next clean
  // save. We deliberately do NOT full-suite-escalate a syntax error — it must
  // stay within the changed file's blast radius, and the changed file is itself
  // always an unconditional BFS seed (src/plugin.ts) so its runtime-known
  // dependents still run. Fully closing the residual (never-under-select) needs
  // a persisted per-file last-known-good forward-target fallback — deferred to
  // va-hygiene-20260706-deferred-wlm.4 (cache v4 disk-format field).
  const parseFailed = errors.length > 0;
  if (parseFailed) {
    console.warn(`[vitest-affected] Parse errors in ${safeLabel(file)} — imports may be incomplete`);
  }
  const specifiers: string[] = [];

  // Static imports — skip type-only
  for (const imp of mod.staticImports) {
    if (imp.entries.length > 0 && imp.entries.every(e => e.isType)) continue;
    specifiers.push(imp.moduleRequest.value);
  }

  // Dynamic imports — slice from source text (no .value property)
  for (const imp of mod.dynamicImports) {
    const raw = source.slice(imp.moduleRequest.start, imp.moduleRequest.end);
    if (raw.startsWith("'") || raw.startsWith('"') || raw.startsWith('`')) {
      const specifier = raw.slice(1, -1);
      // Skip template literals with expressions — non-resolvable
      if (specifier.includes('${')) continue;
      specifiers.push(specifier);
    }
  }

  // Re-exports — in staticExports, NOT staticImports
  for (const exp of mod.staticExports) {
    for (const entry of exp.entries) {
      if (entry.moduleRequest && !entry.isType) {
        specifiers.push(entry.moduleRequest.value);
      }
    }
  }

  // Worker/SharedWorker construction — new Worker(new URL('./x', import.meta.url))
  // Invisible to oxc-parser's import/export extraction (see extractWorkerSpecifiers).
  //
  // SEED-ONLY BOUNDARY, BY DESIGN. The static extraction in this function
  // (staticImports + dynamicImports + re-exports + WORKER_URL_RE) exists ONLY to
  // let deltaParseNewImports discover the import TARGETS of the changed files, so
  // those targets can seed additional BFS entry points that the runtime cache has
  // not observed yet (a brand-new import added this edit). It deliberately does
  // NOT construct persistent reverse edges: the authoritative reverse graph is
  // built solely from Vitest's importDurations (folded in by runtime-merge), which
  // captures the REAL, executed module graph — including transitive and
  // conditionally-loaded edges a static walk would miss. Mirrors the vi.mock /
  // vi.importActual BY-DESIGN edge-presence note in runtime-merge.ts: static
  // parsing seeds, runtime observation is the source of truth.
  for (const specifier of extractWorkerSpecifiers(source)) {
    specifiers.push(specifier);
  }

  const dir = path.dirname(file);
  const resolved: string[] = [];
  // Path boundary: rootDir=/project/foo must not match /project/foo-bar/
  // Canonicalize BOTH sides of the boundary check — the resolver may return
  // paths through a symlink alias while rootDir is canonical (or vice versa);
  // comparing mixed representations silently drops legitimate in-project edges.
  const canonicalRoot = toCanonicalPath(rootDir);
  const rootPrefix = canonicalRoot.endsWith('/') ? canonicalRoot : canonicalRoot + '/';

  for (const specifier of specifiers) {
    // A Vite query suffix (`?raw`, `?url`, ...) marks a genuine module
    // import regardless of the underlying extension — e.g. './x.css?raw'
    // is a real import Vite will serve, unlike a bare './x.css' stylesheet
    // import (excluded below as a binary/non-JS asset). Bypass the binary
    // exclusion for query-suffixed specifiers, but ALWAYS resolve the bare
    // (query-stripped) path — oxc-resolver has no notion of Vite's query
    // variants and fails to resolve the suffixed form outright.
    const { bare, hadQuery } = stripQuerySuffix(specifier);
    if (!hadQuery && isBinarySpecifier(bare)) continue;
    const result = resolver.sync(dir, bare);
    if (result.error) continue;
    if (!result.path) continue;
    // Canonicalize resolver output (memoized — repeated deps cost one realpath)
    const resolvedPath = toCanonicalPath(result.path);
    if (resolvedPath.includes('/node_modules/')) continue;
    if (!resolvedPath.startsWith(rootPrefix) && resolvedPath !== canonicalRoot) continue;
    resolved.push(resolvedPath);
  }

  return { targets: resolved, parseFailed };
}

/**
 * Parse only the changed files and return import targets that are NOT
 * already present in the cached reverse map.  These "new targets" become
 * extra BFS seeds so that newly-added imports are correctly propagated
 * even though the runtime cache hasn't seen them yet.
 *
 * Cost: parses only 1-5 files (~5ms) instead of the entire tree.
 */
export function deltaParseNewImports(
  changedFiles: string[],
  cachedReverse: ReverseMap,
  rootDir: string,
  verbose?: boolean,
  aliasEntries?: AliasEntry[],
): string[] {
  const resolver = createResolver(rootDir, aliasEntries);
  const newTargets: string[] = [];
  for (const file of changedFiles) {
    let source: string;
    try {
      source = readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    // Consume the parse-failure-signalling shape; keep the PARTIAL targets on a
    // parse error (see resolveFileImports's accepted-residual note). `parseFailed`
    // is surfaced via that function's once-per-file warning — deltaParseNewImports
    // deliberately keeps its own string[] return so the plugin's BFS seed
    // assembly (src/plugin.ts) is untouched (that seam belongs to
    // va-hygiene-20260706-deferred-wlm.1).
    const { targets } = resolveFileImports(file, source, rootDir, resolver);
    for (const imp of targets) {
      if (!cachedReverse.has(imp)) {
        newTargets.push(imp);
        if (verbose) {
          console.warn(`[vitest-affected] Delta parse: new import target ${safeLabel(imp)} from ${safeLabel(file)}`);
        }
      }
    }
  }
  return newTargets;
}
