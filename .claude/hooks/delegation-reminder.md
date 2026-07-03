# STOP - MEMORY FIRST

**DO NOT respond until you complete this:**

```bash
qmd search "<task keywords>" --limit 5
```

- Run a search (task = 2-6 word summary of what you're about to do)
- Review results: facts, rules, decisions, recipes relevant to this task
- Integrate into working context before acting
- If the task touches prior work, widen the search and check hits carefully

**qmd is the memory substrate — query it directly for facts, rules, decisions, recipes.**

**Skip = context blindness. No exceptions.**

---

## Core Protocol

**Read:** `CLAUDE.md` (project architecture, commands, rules)

**Execution default:** Direct execution using tools. No subagent routing for this library project.

---

## Beads Workflow

`/plan-init` → `/plan-refine-internal` → `/beadify` → `/bead-refine` → `/bead-work` → `/bead-land`

Master plan: `_backlog/intelligent-test-selection.md`

---

## Quality Gate

Before committing, all three checks must pass:

```bash
tsc --noEmit && npx vitest run && npm run build
```

The pre-commit hook enforces this automatically on `git commit`.

---

## Navigation Lost?

1. Check `CLAUDE.md` — project commands, architecture, rules
2. Search knowledge base: `qmd search "<task keywords>" --limit 5`
