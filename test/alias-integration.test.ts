/// <reference types="vitest/config" />
import { describe, test, expect, afterEach, beforeEach } from 'vitest';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { vitestAffected } from '../src/plugin.js';
import { saveCacheSync } from '../src/graph/cache.js';
import { createMockContext, runHook, makeTempDir, cleanupTempDirs } from './_helpers.js';

// ===========================================================================
// INTEGRATION: resolve.alias TRACKED promise (README §"Coverage matrix").
//
// The plugin reads `project.vite?.config?.resolve?.alias` (plugin.ts step 11)
// and feeds it into the delta-parser's resolver. Every OTHER test that touches
// aliases either (a) calls `deltaParseNewImports` directly with a synthetic
// `aliasEntries` array (builder.test.ts T2a) or (b) drives the plugin with a
// mock `project` that carries NO `vite` field at all (plugin.test.ts's
// createMockContext), i.e. exercises the undefined/no-op branch.
//
// This suite closes the gap: it drives the real `configureVitest` hook with a
// mock `project` that DOES carry `vite.config.resolve.alias` — the exact shape
// Vitest's TestProject exposes at configureVitest time (TestProject.vite getter
// → ViteDevServer.config: ResolvedConfig → resolve.alias: Alias[], confirmed in
// node_modules/vitest/dist/chunks/reporters.d.*.d.ts and vite's index.d.ts) —
// and asserts the aliased target actually reaches the selection.
//
// Mechanics being pinned: the warm cache knows everything EXCEPT one changed
// source file that carries a BRAND-NEW aliased import. The delta-parser is the
// only path that can discover that import before it is ever runtime-observed;
// it can only do so if the alias entries flow through from `project.vite`.
// ===========================================================================

const tempDirs: string[] = [];

let savedEnv: string | undefined;
beforeEach(() => {
  savedEnv = process.env.VITEST_AFFECTED_DISABLED;
  delete process.env.VITEST_AFFECTED_DISABLED;
});
afterEach(() => {
  if (savedEnv !== undefined) process.env.VITEST_AFFECTED_DISABLED = savedEnv;
  else delete process.env.VITEST_AFFECTED_DISABLED;
  cleanupTempDirs(tempDirs);
});

/**
 * Build a temp project whose warm cache tracks base.ts → base.test.ts, plus:
 *  - src/consumer.ts — a changed SOURCE file with a brand-new aliased import
 *    (`@fresh/probe`) that the warm cache has never seen.
 *  - tests/probe.test.ts — the alias target: a real, include-globbed test file
 *    that is NOT in the warm cache and is NOT otherwise reachable from any seed.
 *
 * The `base.ts` change guarantees the run is always SELECTIVE (base.test.ts is
 * always selected), so probe.test.ts's presence/absence in the final selection
 * is an unambiguous signal — not masked by a full-suite fallback.
 *
 * Returns canonical paths so assertions converge with the plugin's
 * toCanonicalPath output.
 */
function setupAliasFixture(): {
  rootDir: string;
  baseSrc: string;
  consumerSrc: string;
  baseTest: string;
  probeTest: string;
} {
  // makeTempDir realpaths up front: the plugin canonicalizes every path it emits,
  // and macOS tmpdir is a /var → /private/var symlink. Canonicalize the root so
  // expected paths line up with the plugin's canonical include mutation.
  const rootDir = makeTempDir(tempDirs, 'vitest-affected-alias-int-');

  mkdirSync(path.join(rootDir, 'src'), { recursive: true });
  mkdirSync(path.join(rootDir, 'tests'), { recursive: true });

  writeFileSync(path.join(rootDir, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}');

  // Warm, cached edge: base.ts → base.test.ts.
  const baseSrc = path.join(rootDir, 'src', 'base.ts');
  writeFileSync(baseSrc, 'export const base = 1;\n');
  const baseTest = path.join(rootDir, 'tests', 'base.test.ts');
  writeFileSync(
    baseTest,
    'import { base } from "../src/base";\nimport { test, expect } from "vitest";\ntest("base", () => expect(base).toBe(1));\n',
  );

  // The alias target: a brand-new test file, unknown to the warm cache and not
  // reachable from base.ts. Only the aliased import in consumer.ts can pull it in.
  const probeTest = path.join(rootDir, 'tests', 'probe.test.ts');
  writeFileSync(
    probeTest,
    'import { test, expect } from "vitest";\nexport const probe = 1;\ntest("probe", () => expect(probe).toBe(1));\n',
  );

  // The changed source: carries the brand-new aliased import. `@fresh/probe`
  // is a bare specifier with no on-disk file — it resolves ONLY via the alias.
  const consumerSrc = path.join(rootDir, 'src', 'consumer.ts');
  writeFileSync(
    consumerSrc,
    'import { probe } from "@fresh/probe";\nexport const consumer = probe;\n',
  );

  // Warm cache: base.ts → base.test.ts only. consumer.ts and probe.test.ts are
  // deliberately absent (the "brand-new import" window).
  const reverse = new Map<string, Set<string>>();
  reverse.set(baseSrc, new Set([baseTest]));
  saveCacheSync(path.join(rootDir, '.vitest-affected'), reverse);

  return { rootDir, baseSrc, consumerSrc, baseTest, probeTest };
}

// The shared createMockContext attaches project.vite.config.resolve.alias when
// the `alias` option is provided — the real Vitest TestProject.vite →
// ViteDevServer shape. Omitting it reproduces the standard unit-test mock (no
// vite server, undefined/no-op branch).

describe('resolve.alias TRACKED — integration through configureVitest', () => {
  test('WITH project.vite.config.resolve.alias: brand-new aliased import selects the aliased test', async () => {
    const { rootDir, baseSrc, consumerSrc, baseTest, probeTest } = setupAliasFixture();

    const plugin = vitestAffected({
      changedFiles: [baseSrc, consumerSrc],
      cache: true,
    });

    const ctx = createMockContext(rootDir, {
      alias: [{ find: '@fresh/probe', replacement: probeTest }],
    });

    await runHook(plugin, ctx);

    // Selective run: base.test.ts always selected (warm edge). The alias entry
    // must additionally pull in probe.test.ts via the delta-parsed new import.
    const selected = ctx.projectConfig.include;
    expect(selected).toContain(baseTest);
    expect(selected).toContain(probeTest);
  });

  test('WITHOUT project.vite (no alias data): the same aliased import is unresolved and its test is NOT selected', async () => {
    const { rootDir, baseSrc, consumerSrc, baseTest, probeTest } = setupAliasFixture();

    const plugin = vitestAffected({
      changedFiles: [baseSrc, consumerSrc],
      cache: true,
    });

    // No `vite` on the project → resolveAlias is undefined → `@fresh/probe`
    // is an unresolvable bare specifier → probe.test.ts is never seeded.
    const ctx = createMockContext(rootDir);

    await runHook(plugin, ctx);

    // Still a selective run (base.test.ts selected), so this is an unambiguous
    // negative: probe.test.ts is absent BECAUSE the alias never resolved.
    const selected = ctx.projectConfig.include;
    expect(selected).toContain(baseTest);
    expect(selected).not.toContain(probeTest);
  });
});
