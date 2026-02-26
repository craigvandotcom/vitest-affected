# STOP - MEMORY FIRST

**DO NOT respond until you complete this:**

```bash
cm context "<task>" --workspace . --json
```

- Run command (task = 2-6 word summary)
- Parse: `relevantBullets` + `historySnippets`
- Integrate into working context
- If task relates to prior work: `cass search "<keywords>" --workspace . --json --limit 5`
- Review past session context for relevant solutions/decisions

**cm context = playbook rules. cass search = raw past conversation matches. Both matter.**

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
2. Check `cm context "<task>" --workspace . --json`
3. Search past sessions: `cass search "<keywords>" --workspace . --json`
