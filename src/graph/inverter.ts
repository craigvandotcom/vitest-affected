// TODO: Phase 1 implementation
// - Take forward graph, produce reverse graph
// - Forward: file → [files it imports]
// - Reverse: file → [files that import it]

export function invertGraph(
  forward: Map<string, Set<string>>
): Map<string, Set<string>> {
  const reverse = new Map<string, Set<string>>();

  for (const [file, deps] of forward) {
    for (const dep of deps) {
      if (!reverse.has(dep)) {
        reverse.set(dep, new Set());
      }
      reverse.get(dep)!.add(file);
    }
    // Ensure every file has an entry even if nothing imports it
    if (!reverse.has(file)) {
      reverse.set(file, new Set());
    }
  }

  return reverse;
}
