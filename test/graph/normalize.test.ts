import { describe, test, expect, afterEach, beforeEach } from 'vitest';
import path from 'node:path';
import { mkdtempSync, writeFileSync, symlinkSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { normalizeModuleId, toCanonicalPath, clearCanonicalPathCache } from '../../src/graph/normalize.js';

describe('normalizeModuleId', () => {
  test('strips \\0 prefix (Vite virtual module marker)', () => {
    expect(normalizeModuleId('\0/home/user/src/a.ts')).toBe('/home/user/src/a.ts');
  });

  test('strips /@fs/ path prefix (Vite dev server prefix for files outside root)', () => {
    // Vite encodes absolute paths as /@fs/<absolute-path> — so the real input has double-slash
    expect(normalizeModuleId('/@fs//home/user/src/a.ts')).toBe('/home/user/src/a.ts');
  });

  test('strips /@fs/ without leaving double-slash (off-by-one regression)', () => {
    expect(normalizeModuleId('/@fs//home/user/project/src/foo.ts')).toBe('/home/user/project/src/foo.ts');
  });

  test('returns /@id/ paths unchanged (pre-bundled dep — not in our graph)', () => {
    expect(normalizeModuleId('/@id/some-dep')).toBe('/@id/some-dep');
  });

  test('strips ?v=123 query string', () => {
    expect(normalizeModuleId('/home/user/src/a.ts?v=123')).toBe('/home/user/src/a.ts');
  });

  test('handles combined prefixes: \\0 + /@fs/ + query string', () => {
    expect(normalizeModuleId('\0/@fs//home/user/src/a.ts?query')).toBe('/home/user/src/a.ts');
  });

  test('passes through clean absolute paths unchanged', () => {
    expect(normalizeModuleId('/home/user/src/a.ts')).toBe('/home/user/src/a.ts');
  });
});

describe('toCanonicalPath', () => {
  const tempDirs: string[] = [];

  // Fixtures create then delete symlinked dirs; clear the module-scope memo so a
  // symlink resolved in one test cannot serve a stale canonical result to the next.
  beforeEach(() => {
    clearCanonicalPathCache();
  });

  afterEach(() => {
    for (const dir of tempDirs) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    tempDirs.length = 0;
  });

  test('resolves a path reached through a symlinked directory to its real location', () => {
    const realDir = mkdtempSync(path.join(tmpdir(), 'vitest-affected-normalize-real-'));
    tempDirs.push(realDir);
    const linkParent = mkdtempSync(path.join(tmpdir(), 'vitest-affected-normalize-link-'));
    tempDirs.push(linkParent);

    writeFileSync(path.join(realDir, 'file.ts'), 'export const x = 1;\n');
    const linkPath = path.join(linkParent, 'link');
    symlinkSync(realDir, linkPath, 'dir');

    const viaSymlink = path.join(linkPath, 'file.ts');
    const expected = realpathSync(path.join(realDir, 'file.ts')).replaceAll('\\', '/');

    expect(toCanonicalPath(viaSymlink)).toBe(expected);
    // The symlinked route must not equal the raw (unresolved) input.
    expect(toCanonicalPath(viaSymlink)).not.toBe(viaSymlink.replaceAll('\\', '/'));
  });

  test('normalizes Windows backslash separators without attempting realpath', () => {
    // A drive-letter path is absolute on win32 but NOT on POSIX (no leading '/'),
    // so realpathSync must never be attempted against it here — only separators
    // are normalized.
    expect(toCanonicalPath('C:\\Users\\foo\\bar.ts')).toBe('C:/Users/foo/bar.ts');
  });

  test('canonicalizes a macOS-style /var temp path to its /private/var real location', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'vitest-affected-normalize-var-'));
    tempDirs.push(tmp);

    const canonical = toCanonicalPath(tmp);
    expect(canonical).toBe(realpathSync(tmp).replaceAll('\\', '/'));
    if (process.platform === 'darwin') {
      // On macOS, os.tmpdir() sits behind the /var -> /private/var symlink —
      // the whole point of this bead's fix is that this diverges from the raw input.
      expect(canonical).not.toBe(tmp.replaceAll('\\', '/'));
    }
  });

  test('handles a deleted/non-existent file by canonicalizing the nearest existing ancestor', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vitest-affected-normalize-deleted-'));
    tempDirs.push(dir);

    const deletedFile = path.join(dir, 'gone.ts');
    const expectedDir = realpathSync(dir).replaceAll('\\', '/');

    expect(toCanonicalPath(deletedFile)).toBe(`${expectedDir}/gone.ts`);
  });

  test('returns a fake absolute path unchanged when no ancestor exists on disk', () => {
    expect(toCanonicalPath('/proj/src/a.ts')).toBe('/proj/src/a.ts');
  });

  test('memoizes repeated calls (same result on second call)', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'vitest-affected-normalize-memo-'));
    tempDirs.push(tmp);
    const first = toCanonicalPath(tmp);
    const second = toCanonicalPath(tmp);
    expect(second).toBe(first);
  });
});
