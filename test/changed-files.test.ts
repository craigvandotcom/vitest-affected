import { describe, test, expect } from 'vitest';
import { filterRelevantChangedFiles } from '../src/changed-files.js';

const ROOT = '/proj';

const CONFIG_BASENAMES = new Set([
  'package.json',
  'tsconfig.json',
  'vitest.config.ts',
]);

function abs(p: string): string {
  return `${ROOT}/${p}`;
}

function call(
  files: { changed: string[]; deleted?: string[] },
  options: Parameters<typeof filterRelevantChangedFiles>[2] = {},
) {
  return filterRelevantChangedFiles(
    { changed: files.changed, deleted: files.deleted ?? [] },
    ROOT,
    { configBasenames: CONFIG_BASENAMES, ...options },
  );
}

describe('filterRelevantChangedFiles', () => {
  test('ignores markdown-only changed files', () => {
    const r = call({ changed: [abs('README.md'), abs('docs/intro.md')] });
    expect(r.changed).toEqual([]);
    expect(r.ignored).toEqual([abs('README.md'), abs('docs/intro.md')]);
  });

  test('ignores files under .claude/', () => {
    const r = call({ changed: [abs('.claude/commands/foo.md'), abs('.claude/agents/bar.md')] });
    expect(r.changed).toEqual([]);
    expect(r.ignored).toHaveLength(2);
  });

  test('ignores .prettierignore and .gitleaksignore basenames', () => {
    const r = call({ changed: [abs('.prettierignore'), abs('.gitleaksignore')] });
    expect(r.changed).toEqual([]);
    expect(r.ignored).toHaveLength(2);
  });

  test('preserves .ts/.tsx/.js/.json changed files', () => {
    const inputs = [
      abs('src/foo.ts'),
      abs('src/bar.tsx'),
      abs('src/baz.js'),
      abs('config.json'),
    ];
    const r = call({ changed: inputs });
    expect(r.changed).toEqual(inputs);
    expect(r.ignored).toEqual([]);
  });

  test('preserves config-basename files even when extension/path rules would filter', () => {
    // package.json basename is in CONFIG_BASENAMES — must pass even if extension rules changed
    const r = call(
      { changed: [abs('package.json'), abs('vitest.config.ts')] },
      { includeChangedExtensions: ['.rs'] /* deliberately exclude .json/.ts */ },
    );
    expect(r.changed).toEqual([abs('package.json'), abs('vitest.config.ts')]);
  });

  test('preserves config-basename files inside default-ignored prefixes is not relevant — defaults are absolute prefixes', () => {
    // Sanity: a tsconfig.json inside .next/ is still recognized as config-basename
    const r = call({ changed: [abs('.next/tsconfig.json')] });
    expect(r.changed).toEqual([abs('.next/tsconfig.json')]);
  });

  test('does not delta-parse ignored files (verified via filtered output)', () => {
    // The plugin uses `changed` (post-filter) as the input to deltaParseNewImports.
    // So if .md files are filtered out here, deltaParse never sees them.
    const r = call({ changed: [abs('src/a.ts'), abs('docs/b.md')] });
    expect(r.changed).toEqual([abs('src/a.ts')]);
  });

  test('caller-provided ignoreChangedFiles regex applied', () => {
    const r = call(
      { changed: [abs('src/generated/foo.ts'), abs('src/handwritten.ts')] },
      { ignoreChangedFiles: [/^src\/generated\//] },
    );
    expect(r.changed).toEqual([abs('src/handwritten.ts')]);
  });

  test('caller-provided ignoreChangedFiles string prefix applied', () => {
    const r = call(
      { changed: [abs('legacy/old.ts'), abs('src/new.ts')] },
      { ignoreChangedFiles: ['legacy/'] },
    );
    expect(r.changed).toEqual([abs('src/new.ts')]);
  });

  test('deleted files are filtered the same way as changed files', () => {
    const r = call({
      changed: [],
      deleted: [abs('docs/old.md'), abs('src/removed.ts')],
    });
    expect(r.deleted).toEqual([abs('src/removed.ts')]);
    expect(r.ignored).toEqual([abs('docs/old.md')]);
  });

  test('files outside rootDir are still classified by basename/extension', () => {
    // The relative-path computation uses startsWith(rootDir + '/'); files outside
    // get classified by their absolute path's extension and basename.
    const r = call({ changed: ['/other/repo/foo.ts'] });
    expect(r.changed).toEqual(['/other/repo/foo.ts']);
  });
});
