# vitest-smart: Intelligent Test Selection for Vitest

## Vision

An open-source Vitest plugin that maintains a persistent dependency graph of your codebase and uses it to run only the tests affected by your changes. Like Wallaby.js accuracy, but open-source, zero-config, and CI-ready.

**Tagline:** "Run 80% fewer tests. Catch 99% of failures."

---

## The Problem

When you change `src/utils/food.ts`, you want to know which test files to run. Today's options:

| Tool | Limitation |
|---|---|
| `vitest --changed` | Only catches directly changed files, misses transitive deps |
| `vitest related <files>` | Manual — you have to tell it which files changed |
| Nx/Turborepo `affected` | Package-level, not file-level |
| Wallaby.js | Commercial, closed-source, IDE-coupled |
| Datadog TIA | SaaS, commercial, requires dd-trace |

**No open-source Vitest plugin for file-level intelligent test selection exists.**

---

## How It Works

### Core Algorithm

1. **Parse** — Extract all `import`/`require` statements from every source file
2. **Resolve** — Turn import specifiers into absolute file paths
3. **Build forward graph** — `file → [files it imports]`
4. **Invert** — `file → [files that import it]` (reverse graph)
5. **Query** — Given `git diff` changed files, BFS the reverse graph to find all affected test files
6. **Cache** — Persist graph to disk, use file hashes for incremental updates

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
vitest-smart/
├── src/
│   ├── plugin.ts            # Vitest configureVitest hook (entry point)
│   ├── graph/
│   │   ├── builder.ts       # es-module-lexer + oxc-resolver → forward graph
│   │   ├── inverter.ts      # Forward graph → reverse graph
│   │   └── cache.ts         # Persist to .vitest-smart/, hash-based invalidation
│   ├── selector.ts          # git diff → BFS reverse graph → test file list
│   └── index.ts             # Public API
├── test/
│   └── fixtures/            # Sample projects for testing the plugin itself
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

### Core Dependencies

| Package | Purpose | Why this one |
|---|---|---|
| `es-module-lexer` | Extract import specifiers | 4KiB, zero deps, Vite uses it internally, ~5ms/MB |
| `oxc-resolver` | Resolve specifiers to file paths | 28x faster than enhanced-resolve, handles TS aliases |

### Plugin Entry Point

Hook into Vitest via `configureVitest` (v3.1+ plugin API):
- On test run, check for cached dependency graph
- If stale or missing, rebuild (incremental — only re-parse changed files)
- Run `git diff` to get changed files
- BFS reverse graph to find affected test files
- Filter Vitest's test list to only affected tests

---

## Phased Roadmap

### Phase 1: Static Import Graph (MVP)

**Effort:** ~500-1000 lines, days of work
**Accuracy:** ~80% (catches all import-chain dependencies)

- Parse imports with `es-module-lexer`
- Resolve paths with `oxc-resolver`
- Build + invert dependency graph
- BFS affected test discovery
- File-hash-based caching to `.vitest-smart/`
- CLI: `vitest --smart` or `vitest-smart` wrapper

**Misses:** Dynamic imports, `fs.readFile` dependencies, shared global state, config file impacts

### Phase 2: Coverage-Enhanced Selection

**Effort:** Weeks
**Accuracy:** ~95%

- During test runs, collect V8 coverage per test suite
- Record which source files each test suite actually executes
- Merge coverage map with static graph (union = most complete picture)
- Dynamic imports and runtime deps now captured

### Phase 3: Symbol-Level Tracking

**Effort:** Longer-term
**Accuracy:** ~99%

- Use tree-sitter or SCIP for symbol-level analysis
- Track which specific exports each test uses
- If only `functionA` changed in a file, skip tests that only import `functionB`
- This is Wallaby-level precision, open-source

### Phase 4 (Aspirational): Predictive Selection

- ML model trained on historical test results (a la Meta's approach)
- Predicts which tests are most likely to fail for a given diff
- Requires CI integration and training data pipeline

---

## Prior Art & References

### Algorithms
- **Jest `resolveInverseModuleMap`** — BFS reverse-dependency walk. Three sets: `changed`, `relatedPaths`, `visitedModules`. [Deep-dive article](https://thesametech.com/under-the-hood-jest-related-tests/)
- **Martin Fowler's TIA taxonomy** — coverage-based vs graph-based vs predictive. [Article](https://martinfowler.com/articles/rise-test-impact-analysis.html)
- **Meta Predictive Test Selection** — ML approach, 2x CI cost reduction. [Paper](https://arxiv.org/abs/1810.05286)

### Graph Building Tools
- **dependency-cruiser** (6.2k stars) — battle-tested graph builder, has `reachable` rule type. [GitHub](https://github.com/sverweij/dependency-cruiser)
- **skott** (835 stars) — TS-native graph API with `collectFilesDependencies()`. [GitHub](https://github.com/antoine-coulon/skott)
- **madge** (9.9k stars) — popular but TS 5.4+ broken. [GitHub](https://github.com/pahen/madge)
- **Knip** — uses oxc-resolver, demonstrates full-project graph traversal. [GitHub](https://github.com/webpro-nl/knip)

### Agent Context / Knowledge Graphs
- **Aider Repo Map** — tree-sitter + PageRank for symbol importance. [Docs](https://aider.chat/docs/repomap.html)
- **Sourcegraph SCIP** — precise cross-references via TS type checker. [GitHub](https://github.com/sourcegraph/scip)
- **code-graph-rag** — tree-sitter-based graph as MCP server. [GitHub](https://github.com/vitali87/code-graph-rag)
- **GitLab Knowledge Graph** — Rust-based, entities + relationships. [Docs](https://docs.gitlab.com/user/project/repository/knowledge_graph/)

### Fast Parsers
- **es-module-lexer** — 4KiB WASM, ~5ms/MB, ESM-only. [GitHub](https://github.com/guybedford/es-module-lexer)
- **oxc-resolver** — Rust, 28x faster than enhanced-resolve. [GitHub](https://github.com/oxc-project/oxc-resolver)
- **tree-sitter** — incremental parsing, symbol-level. [GitHub](https://github.com/tree-sitter/tree-sitter)
- **OXC parser** — full Rust parser, 3x faster than SWC. [GitHub](https://github.com/oxc-project/oxc)

### Commercial Competitors
- **Wallaby.js** — static + dynamic analysis, IDE plugin, commercial. [Site](https://wallabyjs.com/)
- **Datadog TIA** — coverage-per-suite, SaaS. [Docs](https://docs.datadoghq.com/tests/test_impact_analysis/setup/javascript/)
- **Launchable/CloudBees** — ML-based predictive, commercial. [Site](https://www.launchableinc.com/predictive-test-selection/)

---

## Vitest Integration Points

### What Vitest already provides
- `vitest --changed` — git-diff-based, uses Vite module graph (limited)
- `vitest related <files>` — manual file list, uses same module graph
- `forceRerunTriggers` — glob patterns for "rerun everything" files
- `configureVitest` plugin hook (v3.1+) — our primary extension point

### What Vitest's approach misses
- No persistent graph between runs (Vite module graph is runtime-only)
- No incremental updates (rebuilds from scratch each time)
- No reverse-dependency lookup (forward-only traversal)
- Dynamic imports, `require()`, config files invisible to module graph

---

## Development Strategy

### Local Development Against Body Compass
```bash
# In vitest-smart/
npm link

# In body-compass-app/
npm link vitest-smart
```

Or in body-compass-app's `package.json`:
```json
"vitest-smart": "file:../vitest-smart"
```

Live-reload during development. Edit plugin, run tests in body-compass-app, see results.

### Testing the Plugin Itself
- Fixture-based tests: small sample projects with known dependency structures
- Verify graph correctness against known dependency chains
- Benchmark parse + resolve times on real-world project sizes

### CI Strategy
- The cached graph ships as `.vitest-smart/` in the repo (gitignored in consumer projects)
- CI rebuilds from scratch on first run, uses cache on subsequent runs
- Cache key: hash of all source file content hashes

---

## Portfolio Positioning

**What makes this stand out:**
- Solves a real, unsolved problem in the OSS ecosystem
- Built on respected foundations (es-module-lexer, oxc-resolver)
- Small surface area — plugin, not a full test runner
- Clear, measurable value proposition
- Natural growth path from static graph → coverage → symbol-level → ML

**npm name candidates:** `vitest-smart`, `vitest-affected`, `vitest-tia`
