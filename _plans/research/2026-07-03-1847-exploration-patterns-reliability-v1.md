# Exploration: existing patterns the replay/reliability upgrade should reuse

## Pattern 1: statsFile JSONL decision log
**File(s):** src/plugin.ts:179-209, 380-601
**What it does:** `writeStatsLine()` appends one JSON object per decision (`{timestamp, action: 'full-suite'|'selective', reason, changedFiles, deletedFiles, affectedTests, totalTests, graphSize, cacheHit, durationMs}`) to `options.statsFile` via `appendFileSync`. Called at every early-return branch (full-suite-trigger, no-changes, config-change, setup-file-change, cache-miss, no-affected-tests, threshold-exceeded, selective, no-valid-tests-on-disk).
**Relevance:** The replay harness's per-commit "what would the plugin select" record should reuse this exact JSONL shape (`reason` enum is already the taxonomy of divergence causes). Shadow-verification mode should emit an additional stats line/reason (e.g. `reason: 'shadow-verify'`) rather than inventing a new schema, so existing stats tooling/consumers stay compatible.
**Evidence:** `if (statsFile) writeStatsLine(statsFile, rootDir, { action: 'full-suite', reason: 'full-suite-trigger', ... }, verbose);` (plugin.ts:380-384)

## Pattern 2: headless-driving options surface
**File(s):** src/plugin.ts:28-70, 349-365
**What it does:** `VitestAffectedOptions` already supports driving the plugin without a live git working tree: `changedFiles?: string[]` (explicit file list, resolved/normalized at line 356-360, `existsSync` split into changed/deleted) and `ref?: string` (passed to `getChangedFiles(rootDir, ref)` for a diff against an arbitrary ref). `disabled` / `VITEST_AFFECTED_DISABLED` env var gates the whole plugin off.
**Relevance:** The replay harness drives the plugin per-commit — it can call with `{ changedFiles: [...], ref: <parentSha> }` (or just checkout+diff) without needing a new headless API. No new plumbing needed here; the harness is a *consumer* of this existing surface, not a reason to add one.
**Evidence:** `interface VitestAffectedOptions { disabled?: boolean; ref?: string; changedFiles?: string[]; ... }` (plugin.ts:28-70)

## Pattern 3: v1→v2 cache migration (template for v2→v3)
**File(s):** src/graph/cache.ts:79-179
**What it does:** `loadCachedReverseMap()` branches on `obj['version']`: v2 loads directly; v1 migrates `runtimeEdges` → v2's `reverseMap` shape in-place (same function, same call site), confining every path to `isUnderRootDir` during migration; unknown version → cache miss (safe fallback, never throws). `saveCacheSync()` always writes current version only (no downgrade path).
**Relevance:** Cache v3 (relative paths) should add a third branch inside the same `if/else if` chain — `obj['version'] === CACHE_VERSION_V3` loads directly, `CACHE_VERSION_V2` branch gets rewritten to convert absolute→relative paths and re-`isUnderRootDir`-filter, exactly mirroring how v1's `runtimeEdges` is migrated to v2's `reverseMap` today. Migration is read-time only (auto-migrate on load, write new format on next save) — no separate migration script.
**Evidence:** `if (obj['version'] === CACHE_VERSION_V2) {...} if (obj['version'] === CACHE_VERSION_V1) { const runtimeEdges = obj['runtimeEdges']; ... Migrate v1 runtimeEdges → v2 reverse map ...}` (cache.ts:134-174)

## Pattern 4: full-suite-trigger rule matching (template for globalSetup trigger)
**File(s):** src/plugin.ts:76-101, 367-387, 430-466; src/changed-files.ts:41-66
**What it does:** `CONFIG_BASENAMES` (Set of config filenames) is checked twice — once pre-filter as `hasConfigChange` (step 9, always-on) and once via caller-supplied `options.fullSuiteTriggers` (step 6a, opt-in, string-prefix-or-RegExp via shared `matchesAnyRule()`/`toRepoRelative()` from changed-files.ts). Both are checked against the **raw** changed set before relevance filtering, and both short-circuit with `console.warn` + `writeStatsLine(..., reason: '...')`.
**Relevance:** A `globalSetup` full-suite trigger is structurally identical to the `setupFileSet` check (plugin.ts:448-466, resolves `project.config.setupFiles` to absolute paths and checks membership) — the new work should add a parallel `globalSetupSet` built from `vitest.config.globalSetup` (or equivalent config field) and a `hasGlobalSetupChange` branch with its own `reason: 'global-setup-change'`, following the exact same resolve-absolute → Set → `.some()` → warn → statsLine → return pattern.
**Evidence:** `const setupFilesRaw = project.config.setupFiles ?? []; ... const hasSetupFileChange = allChangedFiles.some((f) => setupFileSet.has(f)); if (hasSetupFileChange) { console.warn(...); if (statsFile) writeStatsLine(...); return; }` (plugin.ts:448-466)

## Pattern 5: integration-test pattern for a headless replay driver
**File(s):** test/integration.test.ts:1-125
**What it does:** Since Vitest can't test itself in-process, integration tests spawn a *real* `npx vitest run --reporter=json` subprocess via `execa` against a fixture copied to a `mkdtempSync` temp dir with `node_modules` symlinked back to the project root and a generated `vitest.config.ts` importing the **built** `dist/index.js` via `pathToFileURL`. `beforeAll` runs `npm run build` once; each fixture gets `gitInit()` (init + user.email/name + initial commit) before mutating files and re-running.
**Relevance:** The replay harness needs the identical scaffold — spawn real `vitest` (or the plugin's headless entry point) per commit against a checked-out consumer repo, parse `--reporter=json` output, diff selected files against a full-suite ground-truth run. Reuse `setupFixture`/`runVitest`/`gitInit` conventions directly (temp dir + symlinked node_modules + JSON reporter parsing) rather than re-deriving a spawning strategy.
**Evidence:** `const result = await execa('npx', ['vitest', 'run', '--reporter=json'], { cwd, env: {...}, reject: false }); ... report = JSON.parse(result.stdout);` (integration.test.ts:96-121)

## Pattern 6: path normalization / relevance-filter conventions (for CSS/asset handling)
**File(s):** src/changed-files.ts:1-135; src/graph/builder.ts:6-17; src/graph/normalize.ts
**What it does:** CSS/SCSS/etc. are currently in `BINARY_EXTENSIONS` (builder.ts:6-12) and thus **skipped during static import parsing** (`isBinarySpecifier` filters them out of specifiers before resolution — builder.ts:14-17, 53/64/74). `changed-files.ts`'s `DEFAULT_RELEVANT_EXTENSIONS` allowlist also excludes `.css`; a prior plan (`_plans/2026-03-11-1549-changed-file-filtering.md:235`) explicitly deferred broadening to CSS/assets "unless there is explicit evidence they create useful seeds." All path comparisons use forward-slash normalization (`toForwardSlashes`/`replaceAll('\\','/')`) consistently across git.ts, builder.ts, normalize.ts, changed-files.ts.
**Relevance:** CSS/asset relevance handling for this upgrade should NOT touch `BINARY_EXTENSIONS` parsing (still no static edges from CSS imports) but should extend `fullSuiteTriggers`/`includeChangedExtensions`/`configBasenames`-style opt-in config, matching the already-established "conservative: over-run rather than under-run" philosophy stated at plugin.ts:56-67. Follow the string-prefix-or-RegExp `matchesAnyRule` convention, not a new matcher.
**Evidence:** `const BINARY_EXTENSIONS = new Set([... '.css', '.scss', '.sass', '.less']);` (builder.ts:6-12); "Do not broaden to css/assets in the first pass unless there is explicit evidence..." (_plans/2026-03-11-1549-changed-file-filtering.md:235)

## Pattern 7: build/shipping constraints for tools/replay/
**File(s):** package.json:1-60; tsup.config.ts
**What it does:** Package is ESM-only (`"type": "module"`), single build entry `src/index.ts` → `dist/index.js` + `.d.ts` via tsup, `files: ["dist"]` restricts what's published to npm, `exports` map exposes only `"."`. No `bin` field — this is a library plugin, not a CLI. `devDependencies` include `execa` (already used for subprocess spawning in tests) — available for a replay driver without adding a new dependency.
**Relevance:** `tools/replay/` should NOT be added as a new tsup entry point or npm `exports` path unless it's meant to ship to consumers — given it drives a *consumer repo's* git history for internal reliability testing, it reads as a **devtool** (like test/integration.test.ts), not a shipped feature. Keep it out of `files`/`exports`; reuse `execa` (already a devDependency) for spawning.
**Evidence:** `"files": ["dist"]`, `"exports": {".": {"types": "./dist/index.d.ts", "import": "./dist/index.js"}}` (package.json:8-16); `entry: ['src/index.ts']` (tsup.config.ts:4)

## Note on prior planned overlap
`_backlog/intelligent-test-selection.md` already names `vi.mock()` factories and CSS/SCSS as known accuracy gaps closed by the **runtime `importDurations` reporter** (line 1036, 1039) — i.e. the existing runtime-edge collection (Pattern in plugin.ts:111-177, `createRuntimeReporter`) already captures `vi.mock` factory imports and CSS-module edges once a test actually runs. This is directly relevant prior art for the "new coupling-edge sources (vi.mock specifiers)" work — it may already be partially solved at runtime and only need a **static-parse-time** counterpart (builder.ts) for pre-run selection accuracy.
