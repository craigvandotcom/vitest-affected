# vitest-affected: Intelligent Test Selection for Vitest

## Vision

An open-source Vitest plugin that maintains a persistent dependency graph of your codebase and uses it to run only the tests affected by your changes. Like Wallaby.js accuracy, but open-source, zero-config, and CI-ready.

**Tagline:** "Run only the tests that matter."

---

## The Problem

When you change `src/utils/food.ts`, you want to know which test files to run. Today's options:

| Tool | Limitation |
|---|---|
| `vitest --changed` | Uses runtime Vite module graph — forward-only traversal, no persistence, misses transitive deps |
| `vitest related <files>` | Manual — you have to tell it which files changed |
| Nx/Turborepo `affected` | Package-level, not file-level |
| Wallaby.js | Commercial, closed-source, IDE-coupled |
| Datadog TIA | SaaS, commercial, requires dd-trace |

**No open-source Vitest plugin for file-level intelligent test selection exists.**

### Why `vitest --changed` Falls Short (Verified)

1. **Runtime graph only** — Vite module graph doesn't exist before tests start. Can't pre-filter.
2. **No persistence** — Graph is in-memory per process. Every run starts from scratch.
3. **Forward-only traversal** — O(test_count x graph_depth). Reverse graph is O(changed_files x graph_depth).
4. **Bug: misses changed test files** — If a test file itself is modified, `--changed` does NOT run it (vitest issue #1113).

---

## How It Works

### Core Algorithm

1. **Parse** — Extract all import/export specifiers using `oxc-parser`
2. **Resolve** — Turn specifiers into absolute file paths using `oxc-resolver`
3. **Build forward graph** — `file → [files it imports]`
4. **Invert** — `file → [files that import it]` (reverse adjacency list)
5. **Query** — Given `git diff` changed files, BFS the reverse graph → affected test files
6. **Cache** (Phase 2) — Persist graph with mtime+hash invalidation
7. **Coverage** (Phase 3) — Merge V8 runtime coverage with static graph

### Example

```
src/utils/food.ts          (CHANGED)
  ← src/features/foods/hooks/use-foods.ts
    ← src/features/foods/components/food-list.tsx
      ← __tests__/features/foods/food-list.test.tsx    ← RUN THIS
    ← __tests__/features/foods/use-foods.test.tsx      ← RUN THIS
  ← __tests__/utils/food.test.tsx                      ← RUN THIS
```

Change 1 file → run 3 tests instead of 50.

---

## Technical Architecture

```
vitest-affected/
├── src/
│   ├── plugin.ts            # Vitest configureVitest hook (entry point)
│   ├── index.ts             # Public API: exports only vitestAffected()
│   ├── graph/
│   │   ├── builder.ts       # oxc-parser + oxc-resolver → forward + reverse graph
│   │   ├── loader.ts        # (Phase 2) Cache-aware graph loading
│   │   └── cache.ts         # (Phase 2) Graph serialization/persistence
│   ├── git.ts               # Git diff integration
│   ├── selector.ts          # Pure BFS: (changedFiles, reverse, isTestFile) → affected tests
│   ├── reporter.ts          # (Phase 2) Verify mode reporter
│   └── coverage/            # (Phase 3) V8 coverage integration
│       ├── collector.ts     # Per-test-file coverage collection
│       ├── mapper.ts        # Coverage → reverse graph conversion
│       └── merge.ts         # Additive merge: static ∪ coverage
├── test/
│   ├── fixtures/            # Sample projects with known dependency structures
│   │   ├── simple/          # Linear A→B→C chain
│   │   ├── diamond/         # Diamond dependency pattern
│   │   └── circular/        # Circular import handling
│   └── *.test.ts
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── vitest.config.ts
```

> **EMPIRICALLY VERIFIED (2026-02-21):** Mutating `vitest.config.include` inside the `configureVitest` hook DOES filter which test files run. Tested on Vitest 3.2.4. This means vitest-affected is a standard Vitest plugin — no CLI wrapper needed.

---

## Phased Roadmap

### [Phase 1: Static Import Graph (MVP)](./phase-1-static-graph.md)

**Effort:** ~500-1000 lines | **Mode:** One-shot (`vitest run`)

- oxc-parser + oxc-resolver → forward/reverse dependency graph
- BFS from git-changed files → affected test files
- `configureVitest` hook mutates `config.include`
- Safety invariant: on any failure, fall back to full suite
- Zero config for users

### [Phase 2: Watch Mode + Verify + Caching](./phase-2-watch-cache-verify.md)

**Effort:** Days-weeks | **Mode:** One-shot + Watch (`vitest`)

- **Watch mode** via `onFilterWatchedSpecification` + incremental graph updates
- **Graph caching** to `.vitest-affected/graph.json` with mtime+hash invalidation
- **Verify mode** — two-pass: affected-only then full suite, compare for accuracy
- **Rename detection** via `git diff --name-status -M`
- **xxhash-wasm** for fast content hashing

### [Phase 3: Coverage-Enhanced Selection](./phase-3-coverage.md)

**Effort:** Weeks | **Accuracy:** ~95%

- V8 coverage via `node:inspector/promises` per test file
- Record which source files each test actually loads at runtime
- Additive merge: `static_graph ∪ coverage_graph`
- Catches: dynamic imports, `require()`, `vi.mock()` factories, config-driven deps
- Per-test-file granularity with `isolate: true`

### Phase 4: Symbol-Level Tracking (Future)

- Use oxc-parser's full AST to track which specific exports each test uses
- If only `functionA` changed, skip tests that only import `functionB`
- Wallaby-level precision, open-source

### Phase 5: Predictive Selection (Aspirational)

- ML model trained on historical test results (a la Meta's approach)
- Predicts which tests are most likely to fail for a given diff
- Requires CI integration and training data pipeline

---

## Core Dependencies

| Package | Purpose | Why |
|---|---|---|
| `oxc-parser` | Parse imports from TS/JS/TSX/JSX | 8x faster than esbuild, full AST for Phase 4 |
| `oxc-resolver` | Resolve specifiers to file paths | 28x faster than enhanced-resolve, handles TS aliases |
| `picomatch` | Glob matching for force-rerun triggers | Lightweight, zero-dep |
| `tinyglobby` | File globbing with absolute paths | Fast, minimal |
| `xxhash-wasm` | (Phase 2) Fast content hashing | 4.4M ops/sec, WASM, no native compilation |

**Benchmarked on body-compass-app (433 TS/TSX files):**

```
Phase      | Total    | Per file  | % of total
-----------|----------|-----------|----------
Read       |   14.9ms |   0.034ms | 9%
Hash       |    9.9ms |   0.023ms | 6%
Parse      |   99.7ms |   0.230ms | 60%
Resolve    |   41.2ms |   0.095ms | 25%
-----------|----------|-----------|----------
TOTAL      |  165.8ms |   0.383ms | 100%
```

---

## Prior Art & Research

### Algorithms
- **Jest `resolveInverseModuleMap`** — BFS scanning entire haste-map per level: O(V x depth). Our reverse adjacency list: O(V + E).
- **Martin Fowler's TIA taxonomy** — coverage-based vs graph-based vs predictive
- **Meta Predictive Test Selection** — ML approach, 2x CI cost reduction

### Commercial Competitors
- **Wallaby.js** — static + dynamic analysis, IDE plugin, commercial
- **Datadog TIA** — coverage-per-suite, SaaS
- **Launchable/CloudBees** — ML-based predictive, commercial

---

## User Experience

```typescript
// vitest.config.ts — this is ALL the user needs
import { defineConfig } from 'vitest/config'
import { vitestAffected } from 'vitest-affected'

export default defineConfig({
  plugins: [vitestAffected()],
})
```

```bash
npx vitest run
# → [vitest-affected] 3 affected tests
```

**npm name:** `vitest-affected` (unclaimed, verified)
**GitHub:** https://github.com/craigvandotcom/vitest-affected

---

## Refinement Log

### Round 1 (Medium: Builder/Breaker/Trimmer — 3x Opus)

- **Changes:** 10 auto-applied (1 Critical plan bloat, 2 Critical docs, 4 High correctness, 3 High structure)
- **Key fixes:** Removed ~150 lines of research/history artifacts. Removed rename detection from Phase 1 (safety fallback handles it). Scoped force-rerun to rootDir files only. Added existsSync filter on BFS results. Inlined inverter.ts into builder.ts. Moved index.ts rewrite into Step 0.
- **Consensus:** Stale stubs noted by 3/3. Rename detection = Phase 2 complexity by 2/3. picomatch concerns by 2/3.
- **Trajectory:** Critical/High issues found → continue to Round 2

### Round 2 (Medium: Builder/Breaker/Trimmer — 3x Opus)

- **Changes:** 6 applied (1 Critical, 3 High, 2 Medium)
- **Key fixes:** Fixed Step 0 return type contradiction (Critical, 2/3 consensus). Added existsSync filter logging. Separated unstaged deletions from staged. Documented nested tsconfig limitation.
- **Trajectory:** No Critical remaining → finalize
