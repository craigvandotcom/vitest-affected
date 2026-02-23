import { ResolverFactory } from 'oxc-resolver';
import { parseSync } from 'oxc-parser';
import { glob } from 'tinyglobby';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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
      if (!isBinarySpecifier(specifier)) {
        specifiers.push(specifier);
      }
    }
    // Skip template literals with expressions — non-resolvable
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

  for (const specifier of specifiers) {
    const result = resolver.sync(dir, specifier);
    if (result.error) continue;
    if (!result.path) continue;
    if (result.path.includes('node_modules')) continue;
    // Path boundary: rootDir=/project/foo must not match /project/foo-bar/
    const rootPrefix = rootDir.endsWith(path.sep) ? rootDir : rootDir + path.sep;
    if (!result.path.startsWith(rootPrefix) && result.path !== rootDir) continue;
    resolved.push(result.path);
  }

  return resolved;
}

export async function buildFullGraph(rootDir: string): Promise<{
  forward: Map<string, Set<string>>;
  reverse: Map<string, Set<string>>;
}> {
  const files = await glob('**/*.{ts,tsx,js,jsx,mts,mjs,cts,cjs}', {
    cwd: rootDir,
    absolute: true,
    ignore: ['**/node_modules/**', '**/dist/**', '**/.vitest-affected/**', '**/coverage/**', '**/.next/**', '**/test/fixtures/**'],
  });

  const resolver = createResolver(rootDir);
  const forward = new Map<string, Set<string>>();

  for (const file of files) {
    if (!forward.has(file)) {
      forward.set(file, new Set());
    }

    let source: string;
    try {
      source = await readFile(file, 'utf-8');
    } catch {
      continue;
    }

    const deps = resolveFileImports(file, source, rootDir, resolver);
    for (const dep of deps) {
      forward.get(file)!.add(dep);
      // Ensure dependency also has an entry
      if (!forward.has(dep)) {
        forward.set(dep, new Set());
      }
    }
  }

  // Build reverse graph by inverting forward
  const reverse = new Map<string, Set<string>>();
  for (const [file, deps] of forward) {
    if (!reverse.has(file)) {
      reverse.set(file, new Set());
    }
    for (const dep of deps) {
      if (!reverse.has(dep)) {
        reverse.set(dep, new Set());
      }
      reverse.get(dep)!.add(file);
    }
  }

  return { forward, reverse };
}
