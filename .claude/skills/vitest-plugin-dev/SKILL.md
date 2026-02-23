---
name: vitest-plugin-dev
description: Use when working on Vitest plugin code, graph building logic, test selection, import extraction, oxc-parser usage, oxc-resolver usage, or the configureVitest hook. Covers Vitest Plugin API, oxc-parser/oxc-resolver API reference, and project-specific conventions for vitest-affected.
---

# Vitest Plugin Development

## Vitest Plugin API

### configureVitest Hook

The `configureVitest` hook (added in Vitest 3.1.0) is the plugin's entry point:

```typescript
/// <reference types="vitest/config" />
import type { Plugin } from 'vite'

export function vitestAffected(): Plugin {
  return {
    name: 'vitest:affected',
    async configureVitest({ vitest, project }) {
      // project.config.include can be mutated to absolute paths
    }
  }
}
```

### Critical Rules

1. **Triple-slash directive required** — `/// <reference types="vitest/config" />` must appear at the top of any file using `configureVitest`. Without it, TypeScript won't recognize the hook on the `Plugin` type.

2. **config.include accepts absolute paths** — Despite being typed as glob patterns, `project.config.include` accepts absolute file paths. This is undocumented but verified behavior.

3. **DO NOT call project.globTestFiles()** — It pollutes Vitest's internal cache before `config.include` mutation takes effect. Use `tinyglobby` directly instead.

4. **Async hook caveat** — `configureVitest` is typed as returning `void` but async works via Vite's `callHookWithContext`. Verify with integration tests.

5. **Reporters not instantiated** — Reporters aren't available when this hook runs. Use `vitest.onAfterSetServer` (undocumented, not in types) if you need reporter access.

6. **onFilterWatchedSpecification** — Callbacks are AND-ed across all plugins. If another plugin returns false, the test is excluded regardless.

### TestProject API Reference

| Property | Usage | Warning |
|---|---|---|
| `project.config` | Mutate `config.include` | Must use absolute paths |
| `project.matchesTestGlob(id)` | Validate file matches patterns | Safe to call |
| `project.globTestFiles()` | DO NOT USE | Cache pollution |
| `project.serializedConfig` | Re-serializes on every access | Avoid in hot paths |

## oxc-parser API

### Extracting Imports

```typescript
import { parseSync } from 'oxc-parser'

const { module: mod, errors } = parseSync(filePath, sourceCode)
```

### Three Import Sources

**Static imports** — `mod.staticImports`:
```typescript
for (const imp of mod.staticImports) {
  // Skip type-only imports
  if (imp.entries.length > 0 && imp.entries.every(e => e.isType)) continue
  // entries.length === 0 means namespace import — treat as value import
  specifiers.push(imp.moduleRequest.value)
}
```

**Dynamic imports** — `mod.dynamicImports`:
```typescript
for (const imp of mod.dynamicImports) {
  // .value does NOT exist on dynamic imports — must slice from source
  const raw = sourceCode.slice(imp.moduleRequest.start, imp.moduleRequest.end)
  if (raw.startsWith("'") || raw.startsWith('"') || raw.startsWith('`')) {
    specifiers.push(raw.slice(1, -1))
  }
  // Skip template literals with expressions — non-resolvable
}
```

**Re-exports** — `mod.staticExports` (NOT staticImports!):
```typescript
for (const exp of mod.staticExports) {
  for (const entry of exp.entries) {
    if (entry.moduleRequest && !entry.isType) {
      specifiers.push(entry.moduleRequest.value)
    }
  }
}
```

### Common Pitfalls

- Re-exports are in `staticExports`, NOT `staticImports`
- Dynamic import `.moduleRequest` has no `.value` — slice from source text
- Type-only detection: `entries.length === 0` = namespace import, treat as value
- Filter binary assets: `.svg`, `.png`, `.css`, etc.
- oxc-parser is pre-1.0 — lock version, check release notes before upgrading

## oxc-resolver API

```typescript
import { ResolverFactory } from 'oxc-resolver'

const resolver = new ResolverFactory({
  extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.json'],
  conditionNames: ['node', 'import'],
  tsconfig: { configFile: path.join(rootDir, 'tsconfig.json'), references: 'auto' },
  builtinModules: true,
})

// Context MUST be a DIRECTORY, not a file path
const result = resolver.sync(path.dirname(importingFile), specifier)
if (result.error) return null  // Builtins, missing packages
if (result.path?.includes('node_modules')) return null  // External deps
return result.path
```

### Critical Rules

- **First arg is a DIRECTORY** — `path.dirname(importingFile)`, not the file itself
- **Reuse the factory** — Creating per-file destroys internal cache (41ms -> seconds)
- **Filter builtins** — Return `{ error: 'Builtin module...' }` for node:fs, path, etc.
- **Filter node_modules** — External deps are leaf nodes in the graph

## Safety Invariant

**Never silently skip tests.** Any failure in graph building, git commands, or BFS traversal MUST fall back to running the full test suite with a warning. Silent test skipping is the worst possible failure mode.

## Graph Data Structures

- Forward and reverse graphs: `Map<string, Set<string>>` with absolute paths
- Reverse graph is built inline at the end of `buildFullGraph`, not as a separate module. Do not re-introduce a separate inverter — inline keeps forward/reverse maps always consistent.
- BFS uses index-based queue (not `.shift()`) to avoid O(n) cost
- `visited` Set prevents infinite loops on circular imports
- Atomic cache writes: write to `.tmp`, then `rename()` (atomic on same filesystem)

## Integration Testing

**Fixture requirements:** All test fixtures must have `"type": "module"` in their `package.json` and a `tsconfig.json` for oxc-resolver to correctly resolve ESM specifiers.

Cannot use Vitest to test a plugin that affects how Vitest runs. Pattern:

```typescript
import { execa } from 'execa'

const result = await execa('npx', ['vitest', 'run', '--reporter=json'], {
  cwd: fixtureDir,
})
const output = JSON.parse(result.stdout)
// Assert specific test files ran
```

## TypeScript Patterns

- No `any` — use `VitestPluginContext` from `vitest/node`
- `import type` for all type-only imports (required with `isolatedModules`)
- Non-null assertion (`!`) acceptable after `has()` guard on Maps
- `as any` acceptable ONLY at undocumented Vitest API boundaries (e.g., `onAfterSetServer`)
