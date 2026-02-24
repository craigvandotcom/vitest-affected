/**
 * Strip Vite-specific prefixes and suffixes from spec.moduleId before graph lookup.
 * Without normalization, the watch filter becomes a silent no-op.
 */
export function normalizeModuleId(id: string): string {
  // Strip \0 prefix (Vite virtual module marker)
  if (id.startsWith('\0')) id = id.slice(1);
  // Strip /@fs/ (Vite dev server prefix for files outside root)
  if (id.startsWith('/@fs/')) id = id.slice(5);
  // /@id/ = pre-bundled dep — not in our graph, return as-is (conservative true)
  else if (id.startsWith('/@id/')) return id;
  // Strip query string (?v=123, ?import, etc.)
  const qIdx = id.indexOf('?');
  if (qIdx !== -1) id = id.slice(0, qIdx);
  return id;
}
