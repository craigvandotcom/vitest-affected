# Exploration: patterns for `extraDependencies`

## Pattern 1: Option declaration + JSDoc style
**File(s):** src/plugin.ts:90-106 (`fullSuiteTriggers` on `VitestAffectedOptions`)
**What it does:** Each option is `Array<string | RegExp>` (or similar), documented with a JSDoc block explaining semantics, matching form (string = exact/prefix, RegExp = `.test()`), when it's checked (raw vs filtered set), and the "conservative by design" failure direction.
**Relevance:** `extraDependencies?: Record<string, string | string[]>` (test glob → watched glob(s)) should follow the same doc pattern: explain it injects durable reverse edges (not BFS seeds), matching semantics (tinyglobby glob, not `matchesAnyRule`'s string-prefix/RegExp), and that it fails toward over-running only if misconfigured — otherwise silently under-selects like any other reverse-edge gap.
**Evidence:** `fullSuiteTriggers?: Array<string | RegExp>;` with ~15-line JSDoc above it (plugin.ts:106).

## Pattern 2: Rule matching helper — matchesAnyRule / toRepoRelative
**File(s):** src/changed-files.ts:82-119
**What it does:** `matchesAnyRule(rel, rules)` matches a repo-relative path against string (exact or prefix) / RegExp rules. `toRepoRelative(filePath, rootDir)` canonicalizes both sides via `toCanonicalPath` then strips the root prefix (with a `path.posix.relative` fallback for above-root paths).
**Relevance:** Not directly reusable for `extraDependencies` (globs, not prefix/regex rules) but sets the convention: repo-relative string keys, canonicalize-then-compare. `extraDependencies` needs an analogous helper built on `tinyglobby`'s `glob()` (already imported in plugin.ts) to expand each "watched" glob to canonical absolute paths, matched against changed files the same way `isRelevant`/`toRepoRelative` do.
**Evidence:** `export function matchesAnyRule(rel: string, rules: Array<string | RegExp>): boolean` (changed-files.ts:82).

## Pattern 3: Check-site placement — raw changed set, before relevance filter
**File(s):** src/plugin.ts:791-810 (fullSuiteTriggers), 812-846 (setupFiles/globalSetup twin)
**What it does:** `fullSuiteTriggers` is checked on `[...changed, ...deleted]` (raw, pre-filter) at step 6a, so a trigger with a non-allowlisted extension (`.md`, `.yaml`) still fires — filterRelevantChangedFiles runs later at 6b.
**Relevance:** `extraDependencies` matching must also run on the RAW changed/deleted set before `filterRelevantChangedFiles`, for the same reason: a watched path may have an extension outside `DEFAULT_RELEVANT_EXTENSIONS`. But unlike fullSuiteTriggers (which short-circuits to full-suite), a match should inject the declared test(s) as extra BFS seeds AND/OR persist as a reverse edge — a new step, not reusing the full-suite early-return pattern.
**Evidence:** step numbering + comment "checked on the RAW changed set before the relevance filter below" (plugin.ts:791-796).

## Pattern 4: ReverseMap edges — durable, canonical-absolute in-memory / rootDir-relative on disk
**File(s):** src/graph/types.ts:39 (`ReverseMap = Map<string, Set<string>>`), src/runtime-merge.ts:34-100 (`mergeRuntimeEdges`), src/graph/cache.ts:357-393 (`saveCacheSync`, v3 rootDir-relative)
**What it does:** Reverse map keys = source file, values = Set of test files. `mergeRuntimeEdges(base, fresh, scope)` is the pure merge primitive (`scope: 'all' | Set<testPath>`) — structural sharing of untouched Sets, full test-scoped overwrite for touched ones. `saveCacheSync` relativizes every key/value against canonical rootDir before writing v3 JSON; `loadCachedReverseMap` rejoins + re-canonicalizes on read.
**Relevance:** This is THE mechanism `extraDependencies` must feed. Per the correctness-audit synthesis, `extraDependencies` edges must be DURABLE reverse edges (like runtime-merge output), not BFS seeds like `deltaParseNewImports`. Simplest integration: after loading the cache (step 5) and before/alongside the runtime reporter merge, compute `extraDependencies` edges (watched-glob-expanded-file → test-glob-expanded-file) and fold them into `reverse` via `mergeRuntimeEdges(reverse, extraEdges, 'all')` (or a dedicated scope), then let the normal `saveCacheSync` persist them — so they survive across runs without needing importDurations to ever see the watched file.
**Evidence:** `export function mergeRuntimeEdges(base: ReverseMap, fresh: ReverseMap, scope: Set<string> | 'all'): ReverseMap` (runtime-merge.ts:34).

## Pattern 5: tinyglobby usage — glob(patterns, { cwd, absolute, ignore })
**File(s):** src/plugin.ts:7 (import), 959-963 (test-file glob)
**What it does:** `await glob(includePatterns, { cwd: rootDir, absolute: true, ignore: [...exclude, '**/node_modules/**'] })`, results mapped through `toCanonicalPath`.
**Relevance:** Both halves of `extraDependencies` (test-side glob, watched-side glob) need this exact call shape — `cwd: rootDir`, `absolute: true`, results canonicalized — to produce ReverseMap-compatible keys that converge with graph paths (cache keys, changed-file keys).
**Evidence:** `const testFiles = (await glob(includePatterns, { cwd: rootDir, absolute: true, ignore: [...] })).map((f) => toCanonicalPath(f));` (plugin.ts:959-963).

## Pattern 6: toCanonicalPath — mandatory path-identity boundary
**File(s):** src/graph/normalize.ts:118-168
**What it does:** Single realpath+forward-slash normalization function, memoized, used at every path boundary (git output, cache keys, glob results, reporter module paths) so Map-key comparisons never silently diverge (symlinks, macOS `/var`↔`/private/var`).
**Relevance:** Every path extraDependencies produces (both watched-glob expansions and test-glob expansions) MUST route through `toCanonicalPath` before entering/comparing against `reverse`, or the injected edges will silently fail to align with cache/runtime keys — exactly the failure mode this module exists to prevent.
**Evidence:** `export function toCanonicalPath(inputPath: string): string` (normalize.ts:118), doc comment on "the single path-identity boundary for the whole plugin" (normalize.ts:39-51).

## Pattern 7: Test pattern — mock-context + stats-reason assertions
**File(s):** test/plugin.test.ts:109-192 (`fullSuiteTriggers option` describe block), test/_helpers.ts:55-100 (`createMockContext`, `runHook`)
**What it does:** Tests build a temp fixture (`setupOrphanFixture`) with real files + a pre-written v2/v3 cache, construct `{ vitest, project, projectConfig }` via `createMockContext(tmpDir, opts)`, invoke `configureVitest` directly via a cast (`runHook`/inline `hook()` call), then assert on `projectConfig.include` and/or `lastStatsReason(statsFile)`.
**Relevance:** `extraDependencies` tests should follow this exact harness: seed a fixture where the watched path has NO import edge to the test (proving BFS/static-parse alone would miss it), pass `extraDependencies` in options, assert the test appears in `projectConfig.include` (or stats `explain`/`selectedFiles`) when only the watched (non-imported) file changes — plus a persistence-roundtrip test asserting the injected edge survives a second `configureVitest` call reading from `saveCacheSync`'s output (mirroring how runtime edges persist).
**Evidence:** `createMockContext(tmpDir)` returns `{ vitest, project, projectConfig }`; hook invoked via `(plugin as unknown as Record<string, unknown>).configureVitest` cast (_helpers.ts:92-100, plugin.test.ts:110-121).
