/// <reference types="vitest/config" />
import { describe, test, expect, afterEach, beforeEach } from 'vitest';
import path from 'node:path';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { vitestAffected } from '../src/plugin.js';

const tempDirs: string[] = [];

let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env.VITEST_AFFECTED_DISABLED;
  delete process.env.VITEST_AFFECTED_DISABLED;
});

afterEach(() => {
  if (savedEnv !== undefined) process.env.VITEST_AFFECTED_DISABLED = savedEnv;
  else delete process.env.VITEST_AFFECTED_DISABLED;
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  tempDirs.length = 0;
});

function makeTmp(): string {
  const tmp = mkdtempSync(path.join(tmpdir(), 'vitest-affected-v4compat-'));
  tempDirs.push(tmp);
  mkdirSync(path.join(tmp, 'tests'), { recursive: true });
  writeFileSync(path.join(tmp, 'tsconfig.json'), '{}');
  return tmp;
}

interface MockProjectConfig {
  include: string[];
  exclude: string[];
  setupFiles: string[];
  experimental?: {
    importDurations?: {
      limit?: number;
      print?: boolean | 'on-warn';
      failOnDanger?: boolean;
      thresholds?: { warn?: number; danger?: number };
    };
  };
}

function makeContext(rootDir: string, projectConfig: MockProjectConfig) {
  const project = { config: projectConfig };
  const vitest = {
    config: { root: rootDir, watch: false },
    projects: [project],
    reporters: [] as unknown[],
    onFilterWatchedSpecification: () => {},
  };
  return { vitest, project };
}

async function runHook(rootDir: string, projectConfig: MockProjectConfig): Promise<void> {
  const plugin = vitestAffected({ changedFiles: [], cache: false });
  const { vitest, project } = makeContext(rootDir, projectConfig);
  const hook = (plugin as Record<string, unknown>).configureVitest as (
    ctx: { vitest: typeof vitest; project: typeof project },
  ) => Promise<void>;
  await hook({ vitest, project });
}

describe('vitest 4 importDurations force-enable', () => {
  test('sets limit to MAX_SAFE_INTEGER when experimental block exists but importDurations is unset', async () => {
    const tmp = makeTmp();
    const cfg: MockProjectConfig = {
      include: ['tests/**/*.test.ts'],
      exclude: [],
      setupFiles: [],
      experimental: {},
    };
    await runHook(tmp, cfg);
    expect(cfg.experimental?.importDurations?.limit).toBe(Number.MAX_SAFE_INTEGER);
  });

  test('preserves user-set print/thresholds while overriding limit', async () => {
    const tmp = makeTmp();
    const cfg: MockProjectConfig = {
      include: ['tests/**/*.test.ts'],
      exclude: [],
      setupFiles: [],
      experimental: {
        importDurations: {
          limit: 10,
          print: 'on-warn',
          failOnDanger: true,
          thresholds: { warn: 100, danger: 500 },
        },
      },
    };
    await runHook(tmp, cfg);
    expect(cfg.experimental?.importDurations?.limit).toBe(Number.MAX_SAFE_INTEGER);
    expect(cfg.experimental?.importDurations?.print).toBe('on-warn');
    expect(cfg.experimental?.importDurations?.failOnDanger).toBe(true);
    expect(cfg.experimental?.importDurations?.thresholds).toEqual({ warn: 100, danger: 500 });
  });

  test('does not crash when experimental block is absent (Vitest 3.2 path)', async () => {
    const tmp = makeTmp();
    const cfg: MockProjectConfig = {
      include: ['tests/**/*.test.ts'],
      exclude: [],
      setupFiles: [],
      // experimental intentionally omitted
    };
    await runHook(tmp, cfg);
    expect(cfg.experimental).toBeUndefined();
  });

  test('does not share mutated importDurations object across projects (workspace safety)', async () => {
    const tmp = makeTmp();
    const sharedDefault = { limit: 0, print: false as const };
    const cfgA: MockProjectConfig = {
      include: ['tests/**/*.test.ts'], exclude: [], setupFiles: [],
      experimental: { importDurations: sharedDefault },
    };
    const cfgB: MockProjectConfig = {
      include: ['tests/**/*.test.ts'], exclude: [], setupFiles: [],
      experimental: { importDurations: sharedDefault },
    };
    await runHook(tmp, cfgA);
    await runHook(tmp, cfgB);
    // Original shared object must not be mutated
    expect(sharedDefault.limit).toBe(0);
    // Both projects got fresh objects with the override
    expect(cfgA.experimental?.importDurations?.limit).toBe(Number.MAX_SAFE_INTEGER);
    expect(cfgB.experimental?.importDurations?.limit).toBe(Number.MAX_SAFE_INTEGER);
    expect(cfgA.experimental?.importDurations).not.toBe(sharedDefault);
  });
});
