# Session Start

**Read CORE Context Immediately**

Before proceeding, read: `.claude/skills/CORE/SKILL.md`

This project is **vitest-affected** — an intelligent test selection plugin for Vitest.

Stack: TypeScript, Vitest plugin API, oxc-parser, oxc-resolver, tinyglobby

Quality gate: `tsc --noEmit && npx vitest run && npm run build`

Task workflow: `/plan-init` → `/plan-refine-internal` → `/beadify` → `/bead-refine` → `/bead-work` → `/bead-land`
