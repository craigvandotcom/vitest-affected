// TODO: Phase 1 implementation
// - git diff to get changed files
// - BFS through reverse graph to find all affected files
// - Filter to test files only (*.test.*, *.spec.*)

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
