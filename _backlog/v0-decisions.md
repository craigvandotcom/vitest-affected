# vitest-affected: Technical Decisions

Every decision scored on **Confidence** (how sure we are this is right) and **Impact** (how much it matters if we get it wrong). Scale: 1-5.

---

## Decision 1: Import Parser

**CHANGED FROM ORIGINAL PLAN.** es-module-lexer cannot parse TypeScript.

### Options

| Option | TS Native | Speed (700KB) | Install Size | npm Downloads |
|---|---|---|---|---|
| **oxc-parser** | Yes | ~26ms | ~2 MB | Growing fast |
| es-module-lexer + swc pre-transform | No (needs transform) | ~5ms parse + transform overhead | 4KB + 37MB | 26M + 12M |
| @swc/core | Yes | ~84ms | ~37 MB | 12M |
| TypeScript Compiler API | Yes | ~100-200ms | ~20 MB | 55M |
| tree-sitter | Yes | ~30-50ms | Native binary | 496K |
| Acorn | No | ~100ms | 33KB | 88M |

### Decision: `oxc-parser`

**Confidence: 5/5 | Impact: 5/5**

This is a no-brainer:
- **Parses TypeScript natively** — no pre-transform step needed
- **3x faster than swc, 5x faster than Biome** on benchmarks
- **Direct ESM info extraction** via `result.module.staticImports` — no AST walk needed
- **2 MB install** vs swc's 37 MB
- **Vite 8 and Rolldown are built on oxc** — this is the future of the JS toolchain
- Passes all Test262 tests, 99% of Babel and TS test suites
- Used by Nuxt 3.17+, Rolldown, Prettier

Key API:
```typescript
import { parseSync } from "oxc-parser";
const result = parseSync("file.tsx", sourceCode);
// result.module.staticImports — direct access, no AST traversal
// result.module.dynamicImports — dynamic import() calls
```

**Why not es-module-lexer?** It was our original choice but it **cannot parse TypeScript at all**. You'd need to pre-transform every file with swc/esbuild first, which negates the speed advantage and adds 37MB of dependencies.

**Why not TypeScript Compiler API?** 10x slower. Only justified if we need type-checker-level precision (Phase 3).

---

## Decision 2: Module Resolver

### Options

| Option | Speed | TS Path Aliases | Install Size |
|---|---|---|---|
| **oxc-resolver** | 28x faster than enhanced-resolve | Yes | ~2 MB |
| enhanced-resolve (webpack) | Baseline | Yes | ~800KB |
| TypeScript module resolution | Slow | Yes (authoritative) | 20MB (full TS) |
| Custom (Node resolution algorithm) | Variable | Manual | 0 |

### Decision: `oxc-resolver`

**Confidence: 5/5 | Impact: 4/5**

- 28x faster than webpack's enhanced-resolve
- Handles: ESM + CJS resolution, TypeScript path aliases, Yarn PnP
- Used by Knip, swc-node, Nova
- Pairs naturally with oxc-parser (same ecosystem)
- Has `resolveSync` API for blocking resolution — perfect for graph building

```typescript
import { ResolverFactory } from "oxc-resolver";
const resolver = new ResolverFactory({ tsconfig: { configFile: "./tsconfig.json" } });
const result = resolver.sync("/project/src", "./utils/food");
// result.path → "/project/src/utils/food.ts"
```

---

## Decision 3: Graph Storage Format

### Options

| Format | Parse 10K entries | Write Speed | File Size vs JSON | Deps | Complexity |
|---|---|---|---|---|---|
| **JSON** | ~17,720 ops/s (<1ms for our size) | ~16,386 ops/s | Baseline | 0 | Trivial |
| MessagePack (msgpackr) | ~75,340 ops/s (4x faster) | ~35,665 ops/s | 53% of JSON | ~40KB | Low |
| SQLite (better-sqlite3) | Fast queries | WAL optimized | Similar | ~20MB native | Medium |
| LMDB | 8.5M ops/s | 1.7M ops/s | Similar | Native addon | Medium |

### Decision: JSON (with msgpackr upgrade path)

**Confidence: 5/5 | Impact: 2/5**

For a dependency graph of 500-2000 files (typical project), JSON is:
- **Under 1ms** to parse/stringify
- **Zero dependencies**
- **Human-readable** — critical for debugging a developer tool
- **What Nx uses** for its project graph cache (`project-graph.json`)

If profiling shows serialization as a bottleneck (unlikely), msgpackr is a drop-in upgrade: 4x faster decode, 50% smaller files, zero required native deps.

**Why not SQLite?** Native addon dependency = installation failures for users. better-sqlite3 requires node-gyp prebuilds. This friction kills adoption for an npm package.

**Why not LMDB?** Same native addon problem. 8.5M ops/s is overkill — we're reading one file, once, at startup.

---

## Decision 4: Cache Invalidation Strategy

### Options

| Strategy | Speed (1000 files) | Reliability | Edge Cases |
|---|---|---|---|
| File mtimes only | <1ms | Medium | Breaks on git checkout, CI clone |
| Content hashes only (xxHash) | ~5-15ms | High | None significant |
| **mtime-first, xxHash-fallback** | <1ms common case | High | Best of both |
| Git status | ~10-50ms | High for tracked files | Misses untracked |
| Merkle tree | O(log n) | Very high | Implementation complexity |

### Decision: Hybrid — mtime check, xxHash64 fallback

**Confidence: 5/5 | Impact: 3/5**

Algorithm:
1. Load cached graph + stored `{filePath: {mtime, hash}}` map
2. For each file, check `stat.mtimeMs`
3. If mtime unchanged → file unchanged (fast path, <0.01ms/file)
4. If mtime changed → compute xxHash64 of content
5. If hash matches → update stored mtime, no rebuild needed
6. If hash differs → mark file as changed, re-parse imports

This is the **ccache pattern** and the **MyPy pattern** — proven at scale.

**xxhash-wasm** specifics:
- 3.7KB minified, 1.2KB gzipped, zero deps
- 9,331 MB/s throughput (30x faster than SHA-256)
- For 1000 files × 5KB avg = 5MB total → ~0.5ms to hash everything

---

## Decision 5: Git Diff Strategy

### Options

| Approach | What it captures | Used by |
|---|---|---|
| `git diff --name-only HEAD` | Unstaged + staged changes | Jest |
| `git diff --merge-base main --name-only HEAD` | All changes since branch point | Nx |
| `git status --porcelain` | Everything including untracked | — |
| Combined: merge-base + untracked | Complete picture | Our approach |

### Decision: Two-mode strategy

**Confidence: 4/5 | Impact: 3/5**

**Local development (watch mode):** Use mtime+hash strategy. No git needed. This is faster and catches every save.

**CI / explicit `--changed` mode:**
```bash
# Changes since branch diverged from main
git diff --merge-base main --name-only HEAD

# Plus new untracked files
git ls-files --others --exclude-standard
```

The base branch (`main`) is configurable. `--merge-base` is cleaner than the confusing `...` syntax and does the same thing.

---

## Decision 6: Integration Approach

### Options

| Approach | Can filter tests? | IDE compatible? | Complexity |
|---|---|---|---|
| **Vitest Plugin** (`configureVitest`) | **Yes** — mutate `config.include` | Native | Low |
| Wrapper CLI (`vitest-affected` bin) | Yes — full control | Needs config | Medium |
| Hybrid: CLI + Reporter plugin | Yes + data collection | Needs config | Medium-High |

### Decision: ~~Wrapper CLI~~ → **Vitest Plugin** (REVISED 2026-02-21)

**Confidence: 5/5 | Impact: 5/5**

**REVISION:** The original decision was based on web research stating that `configureVitest` cannot filter the test file list. **This was empirically disproven.** Mutating `vitest.config.include` inside `configureVitest` DOES affect which files `globTestSpecifications()` finds. Tested on Vitest 3.2.4 with:

- Absolute paths → only matched tests run
- Glob patterns → only matched tests run
- Empty array → "No test files found" (correct behavior)
- `onFilterWatchedSpecification` → available for watch mode filtering

**The plugin approach is strictly better:**
- Zero friction — users add one line to `vitest.config.ts`
- IDE integrations work automatically (VS Code Vitest extension, WebStorm, etc.)
- No separate binary, no CLI argument parsing, no version coupling
- CI scripts use `npx vitest run` unchanged
- Discoverable via Vitest's plugin ecosystem

```typescript
/// <reference types="vitest/config" />
import type { Plugin } from 'vite'

export function vitestAffected(options = {}): Plugin {
  return {
    name: 'vitest:affected',
    async configureVitest({ vitest }) {
      if (options.disabled) return

      const graph = await loadOrBuildGraph(vitest.config.root)
      const changedFiles = await getChangedFiles(vitest.config.root, options.ref)
      const affectedTests = bfsAffectedTests(changedFiles, graph.reverse)

      // One-shot mode: mutate config.include
      vitest.config.include = [...affectedTests]

      // Watch mode: filter on file change
      vitest.onFilterWatchedSpecification(spec =>
        affectedTests.has(spec.moduleId)
      )
    }
  }
}
```

**Lesson learned:** Always empirically verify architectural constraints. Web research and even source code reading can be misleading — the 30-minute test that disproved the "cannot filter" claim saved weeks of unnecessary CLI wrapper complexity.

---

## Decision 7: Build Tool

### Options

| Tool | Build Speed | DTS Generation | ESM+CJS | Downloads/wk |
|---|---|---|---|---|
| tsc | Slowest | Native | Manual | N/A |
| **tsdown** | Fastest (Rolldown/Rust) | rolldown-plugin-dts | Yes | Growing |
| tsup | Fast (esbuild) | rollup-plugin-dts (slow) | Yes | 2M |
| unbuild | Fast (rollup) | Built-in | Yes | 131K |

### Decision: `tsup` (for now), migrate to `tsdown` when stable

**Confidence: 3/5 | Impact: 1/5**

tsdown is 49% faster than tsup and is the successor. However:
- tsdown requires Node 20.19+ (may exclude some users' CI)
- tsup has 2M weekly downloads and 10K stars — battle-tested
- For a small package like ours, build time is irrelevant (<2s either way)
- tsup → tsdown migration is trivial (`tsdown migrate` command exists)

Start with tsup for reliability. Switch to tsdown when it hits 1.0.

**Why not tsc alone?** No tree-shaking, no minification, no dual ESM+CJS without complex config. Build tools solve real problems.

---

## Decision 8: Package Name

### Options

| Name | Available on npm | Clarity | Searchability |
|---|---|---|---|
| **vitest-affected** | Yes | Good — implies intelligence | High |
| vitest-affected | Yes | Good — describes functionality | High |
| vitest-tia | Yes | Niche — "TIA" not widely known | Low |

### Decision: `vitest-affected`

**Confidence: 4/5 | Impact: 2/5**

- Memorable and marketable
- Implies intelligence without being jargony
- Follows community convention (`vitest-{descriptor}`)
- Works as both a brand and a CLI command: `npx vitest-affected`
- `vitest-affected` is a close second but sounds more like a flag than a product

---

## Decision 9: CommonJS Support

### Decision: ESM-only, no CJS parsing

**Confidence: 4/5 | Impact: 2/5**

Modern TypeScript projects use ESM imports. Our target audience (Vitest users) is already ESM-native — Vitest itself requires ESM config. Parsing `require()` adds complexity for a shrinking use case.

If needed later, `cjs-module-lexer` (used by Node.js core) can be added as an optional enhancement.

---

## Decision 10: Test File Detection Pattern

### Decision: Use Vitest's own config

**Confidence: 5/5 | Impact: 3/5**

Don't reinvent test file detection. Use `project.matchesTestGlob(path)` from Vitest's API. This respects the user's `include`/`exclude` config exactly.

For graph building (before Vitest is loaded), default to:
```
**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}
```
But always defer to Vitest's config when available.

---

## Decision 11: Monorepo Support

### Decision: Single-project first, monorepo later

**Confidence: 4/5 | Impact: 2/5**

Phase 1 targets single Vitest projects. Monorepo support (multiple `vitest.config.*` files, cross-package dependencies) is Phase 2+. Nx and Turborepo already handle package-level affected detection — we complement them with file-level precision.

---

## Decision 12: Dynamic Import Handling

### Decision: Include in graph with a flag

**Confidence: 4/5 | Impact: 3/5**

oxc-parser returns dynamic imports via `result.module.dynamicImports`. We should:
1. Include dynamic imports with **string literal** arguments (e.g., `import('./foo')`) — these are resolvable
2. Flag dynamic imports with **variable/template** arguments (e.g., `import(someVar)`) — these are unresolvable, log a warning
3. Vitest's own `--changed` follows both `transformed.deps` and `transformed.dynamicDeps` — we should match this behavior

---

## Decision Summary

| # | Decision | Choice | Confidence | Impact |
|---|---|---|---|---|
| 1 | Import Parser | oxc-parser | 5/5 | 5/5 |
| 2 | Module Resolver | oxc-resolver | 5/5 | 4/5 |
| 3 | Graph Storage | JSON (msgpackr upgrade path) | 5/5 | 2/5 |
| 4 | Cache Invalidation | mtime + xxHash64 hybrid | 5/5 | 3/5 |
| 5 | Git Diff Strategy | merge-base + untracked (two-mode) | 4/5 | 3/5 |
| 6 | Integration | Vitest Plugin via configureVitest (REVISED — empirically verified) | 5/5 | 5/5 |
| 7 | Build Tool | tsup (migrate to tsdown later) | 3/5 | 1/5 |
| 8 | Package Name | vitest-affected | 4/5 | 2/5 |
| 9 | CJS Support | ESM-only | 4/5 | 2/5 |
| 10 | Test Detection | Vitest's matchesTestGlob API | 5/5 | 3/5 |
| 11 | Monorepo | Single-project first | 4/5 | 2/5 |
| 12 | Dynamic Imports | Include resolvable, flag unresolvable | 4/5 | 3/5 |

---

## Revised Dependency List

```json
{
  "dependencies": {
    "oxc-parser": "^0.x",
    "oxc-resolver": "^6.0.0",
    "xxhash-wasm": "^1.1.0"
  },
  "peerDependencies": {
    "vitest": ">=3.0.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "tsup": "^8.5.0",
    "vitest": "^3.0.0"
  }
}
```

Total install footprint: ~4 MB (oxc-parser ~2MB + oxc-resolver ~2MB + xxhash-wasm 3.7KB)

---

## Competitive Gap Confirmed

| Tool | Test Selection? | Open Source? | Vitest? | File-Level? |
|---|---|---|---|---|
| Vitest `--changed` | Import graph only | Yes | Yes | Yes (buggy) |
| Wallaby.js | Static + dynamic | No ($100-160/yr) | Yes | Yes |
| Datadog TIA | Coverage-based | No (SaaS) | Yes (via dd-trace) | Yes (suite-level) |
| Codecov ATS | Coverage-based | Partial | No (Python only) | Yes |
| Nx affected | Dependency graph | Yes | Partial | No (package-level) |
| Bun test | None | Yes | No | No |
| **vitest-affected** | **Import graph + cache** | **Yes** | **Yes** | **Yes** |

**We are the only open-source, file-level, Vitest-native test impact analysis tool.**

---

## Revised Architecture

```
vitest-affected/
├── src/
│   ├── plugin.ts            # Vitest configureVitest hook (entry point)
│   ├── index.ts             # Public API exports
│   ├── graph/
│   │   ├── builder.ts       # oxc-parser + oxc-resolver → forward graph
│   │   ├── inverter.ts      # Forward → reverse graph (already implemented)
│   │   └── cache.ts         # JSON persistence + mtime/xxHash invalidation
│   ├── git.ts               # Git diff integration (3 commands)
│   ├── selector.ts          # git diff → BFS reverse graph → affected test files
│   └── reporter.ts          # Custom Vitest reporter for coverage data collection (Phase 2)
├── test/
│   ├── plugin-experiment/   # Empirical proof that config.include mutation works
│   └── fixtures/
├── package.json
├── tsconfig.json
└── tsup.config.ts
```

**REVISED 2026-02-21:** Architecture restored to plugin.ts (original plan was correct). Empirical testing proved `configureVitest` + `config.include` mutation DOES filter tests. No CLI wrapper needed. The `bin.ts` + `runner.ts` approach was based on incorrect web research and has been removed.

---

## Market Validation

### The gap is confirmed and massive

The GitHub topic [test-impact-analysis](https://github.com/topics/test-impact-analysis) has only **5 repositories total** — and **zero are JavaScript/TypeScript**. The entire JS/TS ecosystem has no open-source TIA tool.

### Community demand is documented

| Vitest Issue | Request | Status |
|---|---|---|
| [#6735](https://github.com/vitest-dev/vitest/issues/6735) | "Make `--changed` use coverage or static analysis" — directly requests TIA | Open |
| [#280](https://github.com/vitest-dev/vitest/issues/280) | "Run related tests from source file list" — led to `vitest related` | Partial |
| [#1113](https://github.com/vitest-dev/vitest/issues/1113) | "`--changed` ignores test files" | Open (known bug) |
| [#5237](https://github.com/vitest-dev/vitest/issues/5237) | "`--coverage` + `--changed` don't work together" | Open |
| [#9463](https://github.com/vitest-dev/vitest/discussions/9463) | "Per-test coverage mapping" via `@covers` annotation | Discussion |

Bun test has similar unmet demand:
- [oven-sh/bun#22717](https://github.com/oven-sh/bun/issues/22717) — "Add `--findRelatedTests`"
- [oven-sh/bun#7546](https://github.com/oven-sh/bun/issues/7546) — "`--watch` reruns ALL tests on any change"
- [oven-sh/bun#4825](https://github.com/oven-sh/bun/issues/4825) — "Watch should only run relevant tests"

### Commercial landscape confirms the value

| Competitor | Status | Pricing | JS Support |
|---|---|---|---|
| Wallaby.js | Active, IDE tool | $100-160/seat/yr perpetual | Yes |
| Datadog TIA | Active, SaaS | Per-committer/month + $3/M spans | Yes (Vitest via dd-trace) |
| CloudBees Smart Tests (ex-Launchable) | Active, enterprise | Sales call required | Yes (Jest, some JS) |
| Codecov ATS | Beta | Part of Codecov plans | Python only |
| BuildPulse | Active, SaaS | Not public | Unclear |

Every commercial player validates the market. None serve the open-source, standalone, Vitest-native niche.

### Industry research supports the approach

- **Meta:** Predictive test selection catches >95% of failures running only 1/3 of tests. [Paper](https://arxiv.org/abs/1810.05286)
- **Google TAP:** Tests that fail are "closer" to the code they test — proximity in the dependency graph is the strongest signal. [Paper](https://research.google.com/pubs/archive/45861.pdf)
- **Martin Fowler:** Recommends storing test-to-file mappings as **text files in the same repo** — not in a database. This is exactly our JSON-in-.vitest-affected approach. [Article](https://martinfowler.com/articles/rise-test-impact-analysis.html)
- **Symflower (2024):** Even basic TIA yields a **29% average reduction** in test execution time.
- **Datadog (Ruby):** Per-test coverage collection with 25% median overhead, fully deterministic. [Blog](https://www.datadoghq.com/blog/engineering/ruby-test-impact-analysis/)
- **Spotify:** ML-based TIA reduced test time by **67%** while maintaining 99.2% bug detection.

### Why previous JS TIA attempts failed

1. **Dynamic language complexity** — JavaScript's dynamic imports, eval, lazy loading
2. **Ecosystem fragmentation** — too many bundlers, test frameworks, module systems
3. **Build tool opacity** — TS → bundler → runtime creates layers of indirection
4. **Coverage overhead** — per-test collection is expensive in JavaScript

Our advantage: We start with **static import graph analysis** (cheap, fast, no overhead) and layer coverage on top later. We also benefit from the oxc ecosystem which didn't exist when earlier attempts were made.

### Future expansion: Bun test support

Bun has zero test selection features and active demand for it. A future phase could add a Bun adapter alongside the Vitest adapter, making vitest-affected the universal TIA tool for the JS/TS ecosystem.
