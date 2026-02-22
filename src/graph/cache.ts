// TODO: Phase 1 implementation
// - Persist dependency graph to .vitest-affected/graph.json
// - Use file content hashes for incremental invalidation
// - Only re-parse files whose hash changed since last build

export interface GraphCache {
  /** file path → content hash */
  hashes: Record<string, string>;
  /** file path → array of resolved import paths */
  graph: Record<string, string[]>;
  /** timestamp of last full build */
  builtAt: string;
}

export async function loadCache(
  _cacheDir: string
): Promise<GraphCache | null> {
  throw new Error("Not yet implemented");
}

export async function saveCache(
  _cacheDir: string,
  _cache: GraphCache
): Promise<void> {
  throw new Error("Not yet implemented");
}
