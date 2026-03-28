# Plan: Changed File Filtering in `vitest-affected`

**Date:** 2026-03-11  
**Repo:** `vitest-affected`  
**Goal:** Reduce false-noise from non-code changed files while preserving the plugin's safety invariant: if selection becomes uncertain, fall back to the full suite rather than silently skipping tests.

## Problem

Today `vitest-affected` treats every changed file as a graph-analysis seed unless the caller pre-filters `changedFiles`.

That creates three classes of noise:

1. Non-code files are parsed even when they can never participate in the dependency graph.
2. Verbose mode logs misleading warnings such as:
   - `Parse errors in ... imports may be incomplete`
   - `Changed file not in dependency graph: ...`
3. Repos have to reimplement filtering policy outside the plugin, which duplicates logic and weakens portability.

Concrete examples:

- `.md` command files under `.claude/`
- `.prettierignore`
- `.gitleaksignore`
- generated files like `next-env.d.ts`
- report folders such as `playwright-report/` and `test-results/`

## Desired Outcome

The plugin should:

- ignore obviously irrelevant changed files before graph analysis
- keep config-file changes as full-suite triggers
- preserve explicit escape hatches for repo-specific policies
- log a concise summary of ignored files instead of noisy per-file parse warnings

## Design

### 1. Add first-class filtering options

Extend `VitestAffectedOptions` in [src/plugin.ts](/home/van/Repos/software/vitest-affected/src/plugin.ts):

```ts
ignoreChangedFiles?: Array<string | RegExp>;
includeChangedExtensions?: string[];
respectProvidedChangedFiles?: boolean;
```

Semantics:

- `ignoreChangedFiles`
  - path/pattern-based exclusion applied to changed and deleted files
- `includeChangedExtensions`
  - allowlist for extension-based relevance
- `respectProvidedChangedFiles`
  - if `true`, skip plugin-side filtering when caller passes `changedFiles`
  - default should be `false`, so explicit `changedFiles` still benefit from filtering

### 2. Add built-in default relevance rules

Implement plugin-owned defaults rather than relying only on config.

Defaults should:

- ignore path prefixes:
  - `.claude/`
  - `.git/`
  - `.next/`
  - `.vitest-affected/`
  - `playwright-report/`
  - `test-results/`
- ignore specific basenames:
  - `.gitleaksignore`
  - `.prettierignore`
- ignore non-code extensions by default
- continue treating known config basenames as full-suite triggers

Special-case generated files that are not worth seeding from, for example:

- `next-env.d.ts`

### 3. Centralize filtering in one helper

Create a pure helper in a new module, likely:

- [src/changed-files.ts](/home/van/Repos/software/vitest-affected/src/changed-files.ts)

Suggested API:

```ts
export interface ChangedFileFilterResult {
  changed: string[];
  deleted: string[];
  ignored: string[];
}

export function filterRelevantChangedFiles(
  files: { changed: string[]; deleted: string[] },
  options: VitestAffectedOptions,
): ChangedFileFilterResult
```

This helper should:

- normalize path separators consistently
- classify each file once
- preserve config-file relevance even if extension/path rules would otherwise ignore it
- return ignored files for logging/stats

### 4. Apply filtering before graph analysis

In [src/plugin.ts](/home/van/Repos/software/vitest-affected/src/plugin.ts):

Current order:

1. discover changed/deleted files
2. config-change check
3. setup-file check
4. delta parse
5. BFS seed selection

Proposed order:

1. discover changed/deleted files
2. filter irrelevant changed/deleted files
3. config-change check on the filtered set plus forced-relevant config files
4. setup-file check
5. delta parse only filtered `changed`
6. BFS from filtered `changed + deleted + extraSeeds`

Important detail:

- config-file detection must still work even if those files would otherwise be filtered by extension or path rules
- the helper should therefore classify config files as relevant up front

### 5. Improve logging behavior

Verbose mode should report higher-signal summaries, for example:

- `ignored 37 changed files before graph analysis`
- `ignored paths matched default non-code filters`

Avoid:

- parse warnings for ignored files
- `Changed file not in dependency graph` for ignored files

Keep existing warnings for truly relevant files that fail parsing or are absent from the graph.

### 6. Add stats visibility

If `statsFile` is enabled, add optional fields to the written line:

```ts
ignoredChangedFiles?: number;
ignoredDeletedFiles?: number;
```

This keeps the behavior observable without forcing verbose logs.

## Implementation Steps

### Phase 1: Core filtering support

Files:

- [src/plugin.ts](/home/van/Repos/software/vitest-affected/src/plugin.ts)
- new [src/changed-files.ts](/home/van/Repos/software/vitest-affected/src/changed-files.ts)

Work:

- extend `VitestAffectedOptions`
- implement default ignore/relevance rules
- add `filterRelevantChangedFiles()`
- thread the filtered result into selection flow

### Phase 2: Logging and stats

Files:

- [src/plugin.ts](/home/van/Repos/software/vitest-affected/src/plugin.ts)

Work:

- replace per-file noisy logging with summary logging for ignored files
- add ignored-file counts to stats payload

### Phase 3: Tests

Files:

- likely new focused test file under [test/](/home/van/Repos/software/vitest-affected/test)
- possibly update integration-style plugin tests if they already exercise `configureVitest`

Add tests for:

1. ignores markdown-only changed files
2. ignores `.claude/**`
3. ignores `.prettierignore` and `.gitleaksignore`
4. preserves `.ts/.tsx/.js/.json` changed files
5. still runs full suite on config file changes
6. does not delta-parse ignored files
7. does not emit `changed file not in dependency graph` for ignored files
8. applies filtering to caller-provided `changedFiles` by default
9. skips filtering when `respectProvidedChangedFiles: true`

### Phase 4: Documentation

Files:

- [README.md](/home/van/Repos/software/vitest-affected/README.md) if present
- [src/index.ts](/home/van/Repos/software/vitest-affected/src/index.ts) exports remain unchanged except for updated option typing

Document:

- new options
- default ignored paths/file types
- rationale: reduce noise, not reduce safety

## Proposed Defaults

Start conservative.

Relevant by default:

- `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, `.cjs`, `.json`
- known config basenames

Ignored by default:

- markdown/docs
- report folders
- generated Next route/env typing files
- repo metadata ignores

Do **not** broaden to css/assets in the first pass unless there is explicit evidence they create useful seeds in real projects. For now, keep the rule simple and predictable.

## Risks

### Risk 1: Filtering hides a legitimate dependency seed

Mitigation:

- keep config files as full-suite triggers
- start with a narrow “code-like extensions + config files” allowlist
- expose overrides for repos with unusual source file types

### Risk 2: Caller surprise when `changedFiles` gets filtered

Mitigation:

- document the behavior clearly
- provide `respectProvidedChangedFiles: true`

### Risk 3: Drift between plugin filtering and repo expectations

Mitigation:

- make defaults sane but overridable
- keep the helper pure and well-tested

## Recommendation

Implement plugin-owned changed-file filtering in one pass:

1. add pure filtering helper
2. wire it into `configureVitest`
3. add focused tests
4. document new options

This is a high-leverage improvement because it removes repeated repo-side work while keeping `vitest-affected`'s core contract intact.
