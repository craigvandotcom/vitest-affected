// TODO: Phase 1 implementation
// - oxc-parser to extract import specifiers (handles TS/TSX natively)
// - oxc-resolver to resolve specifiers to absolute file paths
// - Build forward dependency graph: Map<filePath, Set<importedFilePath>>
//
// Key patterns:
//   const { module } = parseSync('file.ts', source);
//   module.staticImports — imp.n = specifier, imp.t = type-only (skip these)
//   module.dynamicImports — imp.n = specifier (null for computed)
//   module.staticExports — exp.n = re-export source
//
//   resolver.sync(path.dirname(importingFile), specifier) — context is DIRECTORY
//   result.builtin → skip (Node.js builtins)
//   result.error → skip (external packages / unresolvable)
//   result.path → absolute resolved file path

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
