// TODO: Phase 1 implementation
// - es-module-lexer to extract import specifiers
// - oxc-resolver to resolve specifiers to absolute file paths
// - Build forward dependency graph: Map<filePath, Set<importedFilePath>>

export interface DependencyGraph {
  /** file → files it imports */
  forward: Map<string, Set<string>>;
  /** file → files that import it */
  reverse: Map<string, Set<string>>;
}

export async function createDependencyGraph(
  _rootDir: string
): Promise<DependencyGraph> {
  throw new Error("Not yet implemented");
}
