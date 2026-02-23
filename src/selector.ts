export function bfsAffectedTests(
  changedFiles: string[],
  reverse: Map<string, Set<string>>,
  isTestFile: (path: string) => boolean
): string[] {
  const visited = new Set<string>();
  const queue = [...changedFiles];
  let i = 0;
  const affectedTests: string[] = [];

  while (i < queue.length) {
    const file = queue[i++]!;
    if (visited.has(file)) continue;
    visited.add(file);
    if (isTestFile(file)) affectedTests.push(file);
    const dependents = reverse.get(file);
    if (dependents) {
      for (const dep of dependents) {
        if (!visited.has(dep)) queue.push(dep);
      }
    }
  }

  return affectedTests.sort();
}
