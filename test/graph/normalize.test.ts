import { describe, test, expect } from 'vitest';
import { normalizeModuleId } from '../../src/graph/normalize.js';

describe('normalizeModuleId', () => {
  test('strips \\0 prefix (Vite virtual module marker)', () => {
    expect(normalizeModuleId('\0/home/user/src/a.ts')).toBe('/home/user/src/a.ts');
  });

  test('strips /@fs/ path prefix (Vite dev server prefix for files outside root)', () => {
    expect(normalizeModuleId('/@fs/home/user/src/a.ts')).toBe('/home/user/src/a.ts');
  });

  test('returns /@id/ paths unchanged (pre-bundled dep — not in our graph)', () => {
    expect(normalizeModuleId('/@id/some-dep')).toBe('/@id/some-dep');
  });

  test('strips ?v=123 query string', () => {
    expect(normalizeModuleId('/home/user/src/a.ts?v=123')).toBe('/home/user/src/a.ts');
  });

  test('handles combined prefixes: \\0 + /@fs/ + query string', () => {
    expect(normalizeModuleId('\0/@fs/home/user/src/a.ts?query')).toBe('/home/user/src/a.ts');
  });

  test('passes through clean absolute paths unchanged', () => {
    expect(normalizeModuleId('/home/user/src/a.ts')).toBe('/home/user/src/a.ts');
  });
});
