// TODO: Phase 1 implementation
// - Get changed files from git (via git.ts)
// - BFS through reverse graph to find all affected files
// - Filter to test files only (*.test.*, *.spec.*)
// - Also include directly-changed test files in result (fixes vitest --changed bug #1113)
//
// BFS algorithm (O(V + E) with pre-built reverse adjacency list):
//   queue = [...changedFiles]
//   visited = new Set(changedFiles)
//   while queue.length > 0:
//     file = queue.shift()
//     for dependent of reverse.get(file):
//       if not visited: add to queue and visited
//   testsToRun = visited.filter(isTestFile)

export interface SelectionResult {
  /** Files that changed (from git diff) */
  changedFiles: string[];
  /** All affected files (transitive reverse deps) */
  affectedFiles: string[];
  /** Affected test files only */
  testsToRun: string[];
  /** Total test files in project (for comparison) */
  totalTests: number;
}

export async function getAffectedTests(
  _rootDir: string
): Promise<SelectionResult> {
  throw new Error("Not yet implemented");
}
