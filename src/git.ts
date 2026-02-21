// TODO: Phase 1 implementation
// - Get changed files using 3 git commands:
//   1. git diff --name-only --diff-filter=ACMR <ref>...HEAD (committed changes)
//   2. git diff --cached --name-only --diff-filter=ACMR (staged changes)
//   3. git ls-files --others --modified --exclude-standard (unstaged + untracked)
// - Resolve to absolute paths via git rev-parse --show-toplevel
// - --diff-filter=ACMR excludes deletions (no graph entry to look up)
// - ref...HEAD (3 dots) = merge-base comparison (correct for CI)
// - No external deps needed — child_process.execFile is sufficient

export async function getChangedFiles(
  _rootDir: string,
  _ref?: string
): Promise<string[]> {
  throw new Error("Not yet implemented");
}
