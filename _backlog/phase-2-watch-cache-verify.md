# Phase 2: Watch Mode + Verify + Caching

**Depends on:** Phase 1 (Static Import Graph)
**Effort:** Days-weeks
**New files:** `src/graph/loader.ts`, `src/graph/cache.ts`, `src/reporter.ts`
**New deps:** `xxhash-wasm`

---

## Goal

Make vitest-affected work in watch mode (`npx vitest`), persist the dependency graph across runs for fast startup, add a verify mode to measure real-world accuracy, and handle file renames without falling back to full suite.

---

## Architecture Changes from Phase 1

### New file: `src/graph/loader.ts`

Extract graph orchestration from `plugin.ts` into a dedicated loader:

```typescript
// loader.ts — graph lifecycle: load from cache → incremental update → save
export interface GraphSnapshot {
  forward: Map<string, Set<string>>;
  reverse: Map<string, Set<string>>;
  fileHashes: Map<string, string>;  // absolute path → xxhash64 content hash
  builtAt: number;                   // Date.now() when graph was built
}

export async function loadOrBuildGraph(
  rootDir: string,
  cacheDir: string,
  verbose: boolean
): Promise<GraphSnapshot> { ... }

export async function updateGraphForFiles(
  snapshot: GraphSnapshot,
  changedFiles: string[],
  deletedFiles: string[],
  rootDir: string
): Promise<GraphSnapshot> { ... }

export async function saveGraph(
  snapshot: GraphSnapshot,
  cacheDir: string
): Promise<void> { ... }
```

### New file: `src/graph/cache.ts`

Serialization/deserialization of graph to `.vitest-affected/graph.json`:

```typescript
// cache.ts — graph persistence
export interface SerializedGraph {
  version: 1;
  builtAt: number;
  files: Record<string, {
    hash: string;           // xxhash64 content hash
    mtime: number;          // file mtime at build time
    imports: string[];      // absolute paths of forward deps
  }>;
}

export async function readCache(cacheDir: string): Promise<SerializedGraph | null> { ... }
export async function writeCache(cacheDir: string, graph: SerializedGraph): Promise<void> { ... }
```

### New file: `src/reporter.ts`

Custom Vitest reporter for verify mode:

```typescript
// reporter.ts — captures per-test results for verify comparison
import type { Reporter, TestModule, TestCase } from 'vitest/reporters';

export class VerifyReporter implements Reporter {
  private affectedResults: Map<string, 'pass' | 'fail'> = new Map();
  private fullResults: Map<string, 'pass' | 'fail'> = new Map();
  // ...
}
```

### Modified: `plugin.ts`

- Phase 1's inline graph build replaced with `loadOrBuildGraph()` call
- Watch mode guard removed — replaced with `onFilterWatchedSpecification` handler
- Graph snapshot held in closure for incremental updates during watch
- Verify mode triggers two-pass execution via reporter

---

## Feature 1: Watch Mode

### How Vitest Watch Mode Works

Vitest uses Vite's built-in file watcher (chokidar). On file change:
1. Vite HMR detects the change
2. Vitest calls `onFilterWatchedSpecification` for each test spec
3. Specs returning `false` are excluded from the re-run
4. Vitest re-runs remaining specs with a ~100ms debounce

### Plugin Hook: `onFilterWatchedSpecification`

```typescript
// Verified: available on TestProject (from configureVitest's project param)
// Called ONLY during watch-triggered reruns, NOT on initial run
// Multiple plugins can register — results are AND-ed (all must return true)
project.onFilterWatchedSpecification((spec: TestSpecification) => {
  // spec.moduleId = absolute path to test file
  // Return true to KEEP, false to EXCLUDE
  return affectedTestSet.has(spec.moduleId);
});
```

**Key behaviors (verified):**
- `onFilterWatchedSpecification` is NOT called on the initial `vitest` run — only on subsequent file-change triggers
- Multiple filter functions are AND-ed: if ANY filter returns `false`, the spec is excluded
- The filter receives the same `TestSpecification` objects from `globTestSpecifications()`
- The debounce window (~100ms) means rapid saves batch into one filter pass

### Implementation

```typescript
export function vitestAffected(options: VitestAffectedOptions = {}): Plugin {
  // Graph snapshot persists across watch re-runs
  let snapshot: GraphSnapshot | null = null;
  let testFileSet: Set<string> | null = null;

  return {
    name: 'vitest:affected',

    async configureVitest({ vitest, project }) {
      if (options.disabled) return;

      // API shape guard (same as Phase 1)
      if (!vitest.config || !Array.isArray(vitest.config.include) || typeof vitest.config.root !== 'string') {
        console.warn('[vitest-affected] Unexpected Vitest config shape — running full suite');
        return;
      }

      const rootDir = vitest.config.root;
      const cacheDir = path.join(rootDir, '.vitest-affected');
      const verbose = options.verbose ?? false;

      // Build or load graph
      snapshot = await loadOrBuildGraph(rootDir, cacheDir, verbose);

      // Discover test files
      const specs = await project.globTestSpecifications();
      testFileSet = new Set(specs.map(s => s.moduleId));

      if (vitest.config.watch) {
        // === WATCH MODE (Phase 2) ===
        // Initial run: use Phase 1 logic (one-shot filter via config.include)
        // Subsequent runs: use onFilterWatchedSpecification

        // Register watch filter for subsequent file-change triggers
        project.onFilterWatchedSpecification((spec) => {
          if (!snapshot || !testFileSet) return true;  // safety: run everything

          // Get changed files from Vitest's watcher context
          // The watcher events give us which files changed since last run
          const changedFiles = getWatcherChangedFiles(vitest);

          // Incrementally update graph for changed files
          // (actual update happens in the watcher event handler below)

          // BFS from changed files
          const isTestFile = (f: string) => testFileSet!.has(f);
          const affected = bfsAffectedTests(changedFiles, snapshot.reverse, isTestFile);
          const affectedSet = new Set(affected);

          return affectedSet.has(spec.moduleId);
        });

        // Listen for file changes to incrementally update the graph
        vitest.watcher.on('change', async (filePath: string) => {
          if (!snapshot) return;
          const absPath = path.resolve(rootDir, filePath);
          snapshot = await updateGraphForFiles(snapshot, [absPath], [], rootDir);
          await saveGraph(snapshot, cacheDir);
        });

        vitest.watcher.on('add', async (filePath: string) => {
          if (!snapshot) return;
          const absPath = path.resolve(rootDir, filePath);
          snapshot = await updateGraphForFiles(snapshot, [absPath], [], rootDir);
          // Update test file set if this is a new test file
          const specs = await project.globTestSpecifications();
          testFileSet = new Set(specs.map(s => s.moduleId));
          await saveGraph(snapshot, cacheDir);
        });

        vitest.watcher.on('unlink', async (filePath: string) => {
          if (!snapshot) return;
          const absPath = path.resolve(rootDir, filePath);
          snapshot = await updateGraphForFiles(snapshot, [], [absPath], rootDir);
          testFileSet?.delete(absPath);
          await saveGraph(snapshot, cacheDir);
        });

        // Initial run still uses Phase 1 config.include mutation
        // (onFilterWatchedSpecification is not called for initial run)
      }

      // === ONE-SHOT MODE (same as Phase 1, but uses cached graph) ===
      // ... Phase 1 logic with loadOrBuildGraph instead of buildFullGraph ...
    }
  };
}
```

### Incremental Graph Updates

When a file changes in watch mode, only re-parse that file — don't rebuild the entire graph:

```typescript
export async function updateGraphForFiles(
  snapshot: GraphSnapshot,
  changedFiles: string[],
  deletedFiles: string[],
  rootDir: string
): Promise<GraphSnapshot> {
  const { forward, reverse, fileHashes } = snapshot;

  // 1. Remove deleted files from graph
  for (const file of deletedFiles) {
    // Remove forward edges
    const deps = forward.get(file);
    if (deps) {
      for (const dep of deps) {
        reverse.get(dep)?.delete(file);
      }
    }
    forward.delete(file);
    reverse.delete(file);
    fileHashes.delete(file);
  }

  // 2. Re-parse changed files
  for (const file of changedFiles) {
    const source = await readFile(file, 'utf-8');
    const newHash = await hashContent(source);

    // Skip if content hasn't actually changed (editor save without edits)
    if (fileHashes.get(file) === newHash) continue;

    // Remove old edges
    const oldDeps = forward.get(file);
    if (oldDeps) {
      for (const dep of oldDeps) {
        reverse.get(dep)?.delete(file);
      }
    }

    // Parse new imports and rebuild edges
    const newDeps = parseImports(file, source, rootDir);
    forward.set(file, newDeps);
    for (const dep of newDeps) {
      if (!reverse.has(dep)) reverse.set(dep, new Set());
      reverse.get(dep)!.add(file);
    }
    fileHashes.set(file, newHash);
  }

  return { forward, reverse, fileHashes, builtAt: Date.now() };
}
```

**Cost per file change:** ~0.5ms (parse) + ~0.1ms (hash) = negligible. No full rebuild needed.

---

## Feature 2: Graph Caching

### Cache Format

Stored at `.vitest-affected/graph.json` (gitignored):

```json
{
  "version": 1,
  "builtAt": 1708000000000,
  "files": {
    "/abs/path/src/utils/food.ts": {
      "hash": "a1b2c3d4e5f6",
      "mtime": 1708000000000,
      "imports": ["/abs/path/src/types.ts", "/abs/path/src/constants.ts"]
    }
  }
}
```

### Invalidation Strategy: mtime + hash hybrid

Fast path: check mtime first (no IO). Slow path: hash content only if mtime changed.

```typescript
export async function loadOrBuildGraph(
  rootDir: string,
  cacheDir: string,
  verbose: boolean
): Promise<GraphSnapshot> {
  const cached = await readCache(cacheDir);

  if (!cached) {
    // No cache — full build
    const snapshot = await buildFullGraph(rootDir);
    await saveGraph(snapshot, cacheDir);
    return snapshot;
  }

  // Glob current files
  const currentFiles = await glob('**/*.{ts,tsx,js,jsx,mts,mjs,cts,cjs}', {
    cwd: rootDir,
    absolute: true,
    ignore: ['node_modules/**', 'dist/**', '.vitest-affected/**'],
  });

  const staleFiles: string[] = [];
  const newFiles: string[] = [];
  const deletedFiles: string[] = [];

  const currentFileSet = new Set(currentFiles);
  const cachedFileSet = new Set(Object.keys(cached.files));

  // Find new files (not in cache)
  for (const f of currentFiles) {
    if (!cachedFileSet.has(f)) {
      newFiles.push(f);
    }
  }

  // Find deleted files (in cache but not on disk)
  for (const f of cachedFileSet) {
    if (!currentFileSet.has(f)) {
      deletedFiles.push(f);
    }
  }

  // Check mtime for existing files (fast path)
  for (const f of currentFiles) {
    const entry = cached.files[f];
    if (!entry) continue;

    const stat = await lstat(f);
    if (stat.mtimeMs !== entry.mtime) {
      // mtime changed — verify with content hash (handles touch without edit)
      const content = await readFile(f, 'utf-8');
      const hash = await hashContent(content);
      if (hash !== entry.hash) {
        staleFiles.push(f);
      }
    }
  }

  if (staleFiles.length === 0 && newFiles.length === 0 && deletedFiles.length === 0) {
    if (verbose) console.log('[vitest-affected] Graph cache: fully valid');
    return deserializeGraph(cached);
  }

  if (verbose) {
    console.log(`[vitest-affected] Graph cache: ${staleFiles.length} stale, ${newFiles.length} new, ${deletedFiles.length} deleted`);
  }

  // Incremental update: re-parse only changed/new files
  const snapshot = deserializeGraph(cached);
  const updated = await updateGraphForFiles(
    snapshot,
    [...staleFiles, ...newFiles],
    deletedFiles,
    rootDir
  );

  await saveGraph(updated, cacheDir);
  return updated;
}
```

### Content Hashing with xxhash-wasm

```typescript
import initXxhash, { type XXHash } from 'xxhash-wasm';

let hasher: XXHash | null = null;

async function getHasher(): Promise<XXHash> {
  if (!hasher) {
    hasher = await initXxhash();  // ~2ms init, 4.4M ops/sec after
  }
  return hasher;
}

export async function hashContent(content: string): Promise<string> {
  const h = await getHasher();
  return h.h64ToString(content);  // Returns hex string, JSON-safe
}
```

**Why xxhash-wasm:** 4.4M ops/sec for small strings, async WASM init (~2ms one-time), returns JSON-safe hex strings. No native compilation needed (pure WASM). Already common in JS tooling (Turbopack, Rolldown).

### Cache Location

- `.vitest-affected/graph.json` — project root, gitignored
- Auto-create directory on first write
- Add to plugin's README: `echo '.vitest-affected/' >> .gitignore`

---

## Feature 3: Verify Mode

Verify mode measures real-world accuracy by running two passes:

1. **Affected-only pass:** Run only the tests vitest-affected selects
2. **Full pass:** Run the entire test suite
3. **Compare:** Report any tests that failed in the full pass but weren't selected

### User Interface

```typescript
// vitest.config.ts
export default defineConfig({
  plugins: [vitestAffected({ verify: true })],
})
```

Or via CLI environment variable:
```bash
VITEST_AFFECTED_VERIFY=1 npx vitest run
```

### Reporter Implementation

```typescript
import type { Reporter, TestModule, TestCase, Vitest } from 'vitest/reporters';

interface TestResult {
  file: string;
  status: 'pass' | 'fail' | 'skip';
  duration: number;
}

export class VerifyReporter implements Reporter {
  private results: TestResult[] = [];
  private vitest!: Vitest;

  onInit(vitest: Vitest) {
    this.vitest = vitest;
  }

  // Called after each test module (file) completes
  onTestModuleEnd(module: TestModule) {
    const file = module.moduleId;
    // TestModule.state() returns the aggregate state
    const state = module.state();  // 'passed' | 'failed' | 'skipped'
    const duration = module.diagnostic()?.duration ?? 0;

    this.results.push({
      file,
      status: state === 'passed' ? 'pass' : state === 'failed' ? 'fail' : 'skip',
      duration,
    });
  }

  // Called after the entire test run completes
  onTestRunEnd(testModules: TestModule[], unhandledErrors: Error[]) {
    // Results are now available for comparison
  }

  getResults(): TestResult[] {
    return [...this.results];
  }
}
```

### Two-Pass Verification Flow

```typescript
// In plugin.ts, when verify: true
async configureVitest({ vitest, project }) {
  // ... build graph, compute affected tests (same as normal) ...

  // Pass 1: Run affected tests only
  vitest.config.include = validTests;
  const affectedReporter = new VerifyReporter();
  vitest.config.reporters.push(affectedReporter);

  // After Pass 1 completes (via reporter.onTestRunEnd), trigger Pass 2
  // Use vitest's onTestRunEnd to schedule the full run

  // Note: actual implementation needs to hook into the test lifecycle
  // to run a second pass. Options:
  // 1. Run vitest programmatically for the second pass
  // 2. Use the reporter to capture results, then re-run with full include
  // 3. Use a two-config approach (affected config + full config)

  // Simplest approach: capture affected results, then run full suite
  // and compare at the end
}
```

### Verify Output

```
[vitest-affected] ✓ Verify mode — Pass 1: 3 affected tests (2 pass, 1 fail)
[vitest-affected] ✓ Verify mode — Pass 2: 50 total tests (48 pass, 2 fail)
[vitest-affected] ⚠ Verify mode — MISSED FAILURE:
  → __tests__/features/auth/login.test.tsx (failed in full suite, not selected by vitest-affected)
  → Cause: runtime dependency via vi.mock() factory — not visible to static analysis
[vitest-affected] Accuracy: 98% (49/50 tests correctly classified)
```

---

## Feature 4: Rename Detection

Phase 1 treats renames as deletion + addition, triggering a full-suite fallback. Phase 2 detects renames and handles them correctly.

### Git Rename Detection

```typescript
// Enhanced git.ts — adds rename detection
async function getChangedFilesWithRenames(
  rootDir: string,
  ref?: string
): Promise<{
  changed: string[];
  deleted: string[];
  renamed: Array<{ from: string; to: string; similarity: number }>;
}> {
  const run = async (args: string[]) => {
    const { stdout } = await exec('git', args, { cwd: rootDir });
    return stdout;
  };

  // --name-status + -M flag detects renames with similarity score
  // Output format: "R085\told-name\tnew-name" (85% similar)
  const statusOutput = ref
    ? await run(['diff', '--name-status', '-M', `${ref}...HEAD`])
    : '';

  const stagedOutput = await run(['diff', '--cached', '--name-status', '-M']);

  const renamed: Array<{ from: string; to: string; similarity: number }> = [];
  const changed: string[] = [];
  const deleted: string[] = [];

  const parseNameStatus = (output: string, gitRoot: string) => {
    for (const line of output.split('\n').filter(Boolean)) {
      const parts = line.split('\t');
      const status = parts[0]!;

      if (status.startsWith('R')) {
        // Rename: R<similarity>\told\tnew
        const similarity = parseInt(status.slice(1)) || 100;
        const from = path.resolve(gitRoot, parts[1]!);
        const to = path.resolve(gitRoot, parts[2]!);
        renamed.push({ from, to, similarity });
        changed.push(to);  // new name is "changed"
      } else if (status === 'D') {
        deleted.push(path.resolve(gitRoot, parts[1]!));
      } else {
        // A, C, M
        changed.push(path.resolve(gitRoot, parts[1]!));
      }
    }
  };

  const { stdout: gitRoot } = await exec('git', ['rev-parse', '--show-toplevel'], { cwd: rootDir });
  parseNameStatus(statusOutput, gitRoot.trim());
  parseNameStatus(stagedOutput, gitRoot.trim());

  // Also get unstaged changes (same as Phase 1)
  const { stdout: unstagedRaw } = await exec('git',
    ['ls-files', '--others', '--modified', '--exclude-standard', '--full-name'],
    { cwd: rootDir }
  );
  for (const f of unstagedRaw.split('\n').filter(Boolean)) {
    const abs = path.resolve(gitRoot.trim(), f);
    if (existsSync(abs)) {
      changed.push(abs);
    }
  }

  return {
    changed: [...new Set(changed)],
    deleted: [...new Set(deleted)],
    renamed,
  };
}
```

### Graph Update for Renames

When a rename is detected, update the graph by replacing the old path with the new path in all edges:

```typescript
function handleRenames(
  snapshot: GraphSnapshot,
  renames: Array<{ from: string; to: string }>
): void {
  for (const { from, to } of renames) {
    // Move forward edges
    const deps = snapshot.forward.get(from);
    if (deps) {
      snapshot.forward.set(to, deps);
      snapshot.forward.delete(from);
    }

    // Update reverse edges pointing to old name
    for (const [file, dependents] of snapshot.reverse) {
      if (dependents.has(from)) {
        dependents.delete(from);
        dependents.add(to);
      }
    }

    // Move reverse edges
    const revDeps = snapshot.reverse.get(from);
    if (revDeps) {
      snapshot.reverse.set(to, revDeps);
      snapshot.reverse.delete(from);
    }

    // Update hash entry
    const hash = snapshot.fileHashes.get(from);
    if (hash) {
      snapshot.fileHashes.set(to, hash);
      snapshot.fileHashes.delete(from);
    }
  }
}
```

This avoids the full-suite fallback for renames. The renamed file is treated as changed (re-parsed with new path), and dependents are correctly tracked through the path update.

---

## Options Added in Phase 2

```typescript
export interface VitestAffectedOptions {
  // Phase 1 options
  disabled?: boolean;
  ref?: string;
  verbose?: boolean;
  threshold?: number;

  // Phase 2 additions
  verify?: boolean;       // Run affected + full, compare results (default: false)
  cache?: boolean;        // Persist graph to .vitest-affected/ (default: true)
  cacheDir?: string;      // Custom cache directory (default: '.vitest-affected')
}
```

---

## Implementation Steps

### Step 1: Extract `graph/loader.ts`

Move graph build orchestration from `plugin.ts` into `loader.ts`. Phase 1's inline `buildFullGraph` call becomes `loadOrBuildGraph`. Plugin holds the snapshot in closure.

### Step 2: Implement `graph/cache.ts`

Serialize/deserialize graph. JSON format with version field for future migrations. Add `xxhash-wasm` dependency. Implement mtime+hash invalidation.

### Step 3: Implement incremental graph updates

`updateGraphForFiles` — remove old edges, re-parse file, add new edges. Used by both cache invalidation (startup) and watch mode (runtime).

### Step 4: Watch mode — `onFilterWatchedSpecification`

Register filter function. Listen to Vite watcher events (`change`, `add`, `unlink`). Update graph incrementally on each event. BFS on each filter call.

### Step 5: Rename detection in `git.ts`

Add `--name-status -M` parsing. Return renamed files separately. Update graph paths for renames.

### Step 6: Update `plugin.ts` for watch mode

Remove watch mode guard. Hold graph snapshot in closure. Register watcher event handlers. Handle both initial run (config.include mutation) and subsequent runs (onFilterWatchedSpecification).

### Step 7: Verify mode reporter

Custom reporter capturing per-test results. Two-pass execution. Accuracy report with missed failures and causes.

### Step 8: Tests

- Cache serialization/deserialization round-trip
- Incremental update correctness (add file, remove file, modify imports)
- Rename detection parsing
- Watch mode integration test (mock watcher events)
- Verify mode comparison logic

---

## Known Limitations (Phase 2)

- **`onFilterWatchedSpecification` AND semantics:** If another plugin also registers a filter, results are AND-ed. Document that vitest-affected's filter may conflict with other watch-mode plugins.
- **Rapid file saves:** The ~100ms debounce handles most cases, but extremely rapid saves during graph update could cause stale BFS results. Mitigate with a lock/queue on graph updates.
- **New test files in watch mode:** A newly created test file needs `globTestSpecifications()` re-call to be discovered. The `add` watcher event handles this.
- **Verify mode overhead:** Two-pass execution doubles test time. Intended for CI validation, not daily use.
