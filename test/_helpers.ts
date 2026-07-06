/// <reference types="vitest/config" />
//
// Shared test scaffolding — consolidated from the per-file copies that the suite
// used to hand-roll (a mock `{ vitest, project }` context builder, the
// configureVitest hook invoker, stats-file readers, a mock TestModule factory,
// and the temp-dir mkdtemp/cleanup idiom). Behavior-preserving: each helper is
// the union of the previous variants, parameterized where they genuinely diverged.
import path from 'node:path';
import { mkdtempSync, rmSync, realpathSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { TestModule } from 'vitest/node';
import { vitestAffected } from '../src/plugin.js';
import type { AliasEntry } from '../src/graph/builder.js';

// ---------------------------------------------------------------------------
// Mock configureVitest context
// ---------------------------------------------------------------------------

/** The mutable project.config the plugin reads and mutates. */
export interface MockProjectConfig {
  include: string[];
  exclude: string[];
  setupFiles: string[];
  globalSetup?: string | string[];
  experimental?: {
    importDurations?: unknown;
  };
}

export interface MockContextOptions {
  /** Override the include glob(s). Defaults to the standard tests glob. */
  include?: string[];
  /** Passthrough project.config.globalSetup. */
  globalSetup?: string | string[];
  /** Passthrough project.config.experimental (shape-check drivers). */
  experimental?: MockProjectConfig['experimental'];
  /** Attach project.vite.config.resolve.alias (real TestProject.vite shape). */
  alias?: AliasEntry[];
  /** Override vitest.projects (workspace-guard drivers). Defaults to `[project]`. */
  projects?: unknown[];
  /**
   * Override vitest.config.root. Presence is significant: passing `{ root: undefined }`
   * sets root to undefined (config-shape guard driver), distinct from omitting it.
   */
  root?: unknown;
  /** Run in watch mode: vitest.config.watch = true. */
  watch?: boolean;
}

/**
 * Build a mock `{ vitest, project }` context for direct configureVitest testing.
 * Returns the mutable `projectConfig` so tests can assert include mutations, plus
 * `getFilterCallback` (populated only in watch mode via onFilterWatchedSpecification).
 */
export function createMockContext(rootDir: string, opts: MockContextOptions = {}) {
  const projectConfig: MockProjectConfig = {
    include: opts.include ?? ['tests/**/*.test.ts'],
    exclude: [],
    setupFiles: [],
    globalSetup: opts.globalSetup,
    experimental: opts.experimental,
  };
  const project = {
    config: projectConfig,
    ...(opts.alias !== undefined
      ? { vite: { config: { resolve: { alias: opts.alias } } } }
      : {}),
  };

  let filterCallback: ((spec: { moduleId: string }) => boolean) | null = null;
  const vitest = {
    config: {
      root: 'root' in opts ? opts.root : rootDir,
      watch: opts.watch ?? false,
    },
    projects: opts.projects ?? [project],
    reporters: [] as unknown[],
    onFilterWatchedSpecification: (cb: (spec: { moduleId: string }) => boolean) => {
      filterCallback = cb;
    },
  };

  return {
    vitest,
    project,
    projectConfig,
    getFilterCallback: () => filterCallback,
  };
}

/** Invoke the plugin's configureVitest hook against a mock context. */
export async function runHook(
  plugin: ReturnType<typeof vitestAffected>,
  ctx: { vitest: unknown; project: unknown },
): Promise<void> {
  const hook = (plugin as unknown as Record<string, unknown>).configureVitest as (
    c: { vitest: unknown; project: unknown },
  ) => Promise<void>;
  await hook({ vitest: ctx.vitest, project: ctx.project });
}

// ---------------------------------------------------------------------------
// Stats-file readers
// ---------------------------------------------------------------------------

/** Parse every JSON line of a stats file (empty array if the file is absent). */
export function readStats(statsFile: string): Array<Record<string, unknown>> {
  if (!existsSync(statsFile)) return [];
  return readFileSync(statsFile, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** The last JSON line of a stats file. */
export function lastStat(statsFile: string): Record<string, unknown> {
  const lines = readStats(statsFile);
  return lines[lines.length - 1];
}

// ---------------------------------------------------------------------------
// Mock TestModule
// ---------------------------------------------------------------------------

/** Mock TestModule with a given moduleId and importDurations map. */
export function createMockTestModule(
  moduleId: string,
  importDurations: Record<string, { selfTime: number; totalTime: number }>,
): TestModule {
  return {
    moduleId,
    diagnostic: () => ({ importDurations }),
  } as unknown as TestModule;
}

// ---------------------------------------------------------------------------
// Temp-dir idiom
// ---------------------------------------------------------------------------

/**
 * Create a canonicalized temp dir and register it in `tempDirs` for cleanup.
 * realpathSync: os.tmpdir() sits behind a symlink on macOS (/var → /private/var);
 * the plugin/cache canonicalize paths, so fixture literals must be canonical too.
 */
export function makeTempDir(tempDirs: string[], prefix = 'vitest-affected-'): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

/** Best-effort recursive removal of every tracked temp dir, then clear the list. */
export function cleanupTempDirs(tempDirs: string[]): void {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  tempDirs.length = 0;
}
