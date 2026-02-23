import type { ResolverFactory } from 'oxc-resolver';

export async function buildFullGraph(rootDir: string): Promise<{
  forward: Map<string, Set<string>>;
  reverse: Map<string, Set<string>>;
}> {
  throw new Error('Not implemented');
}

export function resolveFileImports(file: string, source: string, rootDir: string, resolver: ResolverFactory): string[] {
  throw new Error('Not implemented');
}

export function createResolver(rootDir: string): ResolverFactory {
  throw new Error('Not implemented');
}
