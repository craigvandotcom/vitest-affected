// TODO: Phase 1 implementation
// - oxc-parser to extract import specifiers (handles TS/TSX natively)
// - oxc-resolver to resolve specifiers to absolute file paths
// - Build forward dependency graph: Map<filePath, Set<importedFilePath>>
//
// VERIFIED API (tested against 433-file real project):
//
//   const { module: mod } = parseSync(filePath, sourceCode);
//
//   Static imports:
//     mod.staticImports[].moduleRequest.value → specifier string
//     mod.staticImports[].entries[].isType → skip if ALL entries are type-only
//
//   Dynamic imports (string literals only):
//     mod.dynamicImports[].moduleRequest.start / .end → slice source for specifier
//     NO .value field — must check if slice starts with quote
//
//   Re-exports (in staticExports, NOT staticImports):
//     mod.staticExports[].entries[].moduleRequest?.value → re-export source
//
//   Resolver:
//     resolver.sync(path.dirname(file), specifier) → { path, error }
//     context is DIRECTORY not file — critical gotcha
//     Builtins return { error: "Builtin module ..." }
//     npm packages resolve to node_modules/ — filter for graph
//     tsconfig MUST be configured for @/ path aliases to work
//
// Performance: 166ms cold build for 433 files (99.7ms parse, 41.2ms resolve)

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
