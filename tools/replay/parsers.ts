/**
 * Artifact parsing (tolerant — a corrupt artifact degrades to "unmeasurable",
 * never to a crash or a silently-clean commit).
 */
import type { ReverseMap } from '../../dist/internal.js';
import type { LedgerEntry } from './types.js';

/**
 * Parse a captured graph.json into a ReverseMap; empty map on any drift.
 * Version-aware: v2 stores ABSOLUTE canonical paths (passed through as-is);
 * v3 stores rootDir-RELATIVE paths (absolutized here against the clone's
 * rootDir, forward-slashed) — the whole analysis pipeline operates in
 * absolute canonical space, so relativity must not leak past this boundary.
 * Unknown versions degrade to an empty map (the commit becomes unmeasurable,
 * loudly — never silently clean).
 */
export function parseGraphReverseMap(content: string, rootDir?: string): ReverseMap {
  const map: ReverseMap = new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return map;
  }
  if (parsed === null || typeof parsed !== 'object') return map;
  const obj = parsed as Record<string, unknown>;
  const version = obj.version;
  if (version !== 2 && version !== 3) return map;
  if (version === 3 && !rootDir) return map; // relative paths need a base
  const abs = (p: string): string =>
    version === 3 ? `${rootDir!.replace(/\/+$/, '')}/${p}` : p;
  const raw = obj.reverseMap;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return map;
  for (const [file, tests] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(tests)) continue;
    const set = new Set<string>();
    for (const t of tests) {
      if (typeof t === 'string') set.add(abs(t));
    }
    if (set.size > 0) map.set(abs(file), set);
  }
  return map;
}

/**
 * Parse a captured vitest `--reporter=json` stdout into test-file → status
 * ('passed' / 'failed' / ...). Empty map when the run crashed pre-JSON.
 */
export function parseOutcomes(content: string): Map<string, string> {
  const outcomes = new Map<string, string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return outcomes;
  }
  if (parsed === null || typeof parsed !== 'object') return outcomes;
  const results = (parsed as Record<string, unknown>).testResults;
  if (!Array.isArray(results)) return outcomes;
  for (const r of results) {
    if (r === null || typeof r !== 'object') continue;
    const { name, status } = r as Record<string, unknown>;
    if (typeof name === 'string' && typeof status === 'string') {
      outcomes.set(name, status);
    }
  }
  return outcomes;
}

/** Parse ledger.jsonl into entries (malformed lines dropped, never fatal). */
export function parseLedger(content: string): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== 'object') continue;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.sha !== 'string' || typeof obj.status !== 'string') continue;
    entries.push(obj as unknown as LedgerEntry);
  }
  return entries;
}
