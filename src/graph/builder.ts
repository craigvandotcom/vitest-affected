import { ResolverFactory } from 'oxc-resolver';
import { parseSync } from 'oxc-parser';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

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

export function createResolver(rootDir: string): ResolverFactory {
  const tsconfigPath = path.join(rootDir, 'tsconfig.json');
  const hasTsconfig = existsSync(tsconfigPath);
  if (!hasTsconfig) {
    console.warn('[vitest-affected] No tsconfig.json found — path aliases will not resolve');
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
    builtinModules: true,
  });
}

export function resolveFileImports(
  file: string,
  source: string,
  rootDir: string,
  resolver: ResolverFactory,
): string[] {
  const { module: mod, errors } = parseSync(file, source);
  if (errors.length > 0) {
    console.warn(`[vitest-affected] Parse errors in ${file} — imports may be incomplete`);
  }
  const specifiers: string[] = [];

  // Static imports — skip type-only
  for (const imp of mod.staticImports) {
    if (imp.entries.length > 0 && imp.entries.every(e => e.isType)) continue;
    if (isBinarySpecifier(imp.moduleRequest.value)) continue;
    specifiers.push(imp.moduleRequest.value);
  }

  // Dynamic imports — slice from source text (no .value property)
  for (const imp of mod.dynamicImports) {
    const raw = source.slice(imp.moduleRequest.start, imp.moduleRequest.end);
    if (raw.startsWith("'") || raw.startsWith('"') || raw.startsWith('`')) {
      const specifier = raw.slice(1, -1);
      // Skip template literals with expressions — non-resolvable
      if (specifier.includes('${')) continue;
      if (!isBinarySpecifier(specifier)) {
        specifiers.push(specifier);
      }
    }
  }

  // Re-exports — in staticExports, NOT staticImports
  for (const exp of mod.staticExports) {
    for (const entry of exp.entries) {
      if (entry.moduleRequest && !entry.isType) {
        if (!isBinarySpecifier(entry.moduleRequest.value)) {
          specifiers.push(entry.moduleRequest.value);
        }
      }
    }
  }

  const dir = path.dirname(file);
  const resolved: string[] = [];
  // Path boundary: rootDir=/project/foo must not match /project/foo-bar/
  const rootPrefix = rootDir.endsWith(path.sep) ? rootDir : rootDir + path.sep;

  for (const specifier of specifiers) {
    const result = resolver.sync(dir, specifier);
    if (result.error) continue;
    if (!result.path) continue;
    if (result.path.includes(`${path.sep}node_modules${path.sep}`)) continue;
    if (!result.path.startsWith(rootPrefix) && result.path !== rootDir) continue;
    resolved.push(result.path);
  }

  return resolved;
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
  cachedReverse: Map<string, Set<string>>,
  rootDir: string,
  verbose?: boolean,
): string[] {
  const resolver = createResolver(rootDir);
  const newTargets: string[] = [];
  for (const file of changedFiles) {
    let source: string;
    try {
      source = readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    const imports = resolveFileImports(file, source, rootDir, resolver);
    for (const imp of imports) {
      if (!cachedReverse.has(imp)) {
        newTargets.push(imp);
        if (verbose) {
          console.warn(`[vitest-affected] Delta parse: new import target ${imp} from ${file}`);
        }
      }
    }
  }
  return newTargets;
}
