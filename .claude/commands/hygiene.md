---
description: Iterative codebase review (3 agents, multiple rounds until plateau) — daily maintenance, not feature-scoped
---

**You are the conductor.** Three reviewers hunt independently. You synthesize, fix, and iterate. Codebase-wide — not tied to any feature branch or diff.

Run this after a few bead-work sessions, or daily for maintenance. For feature-scoped review, use `/work-review` instead.

---

## I/O Contract

|                  |                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------ |
| **Input**        | Full codebase, recent commits, or specific directory (user-selected scope)                 |
| **Output**       | Fixed issues committed, health assessment report                                           |
| **Artifacts**    | Round findings in `$ARTIFACTS_DIR/round-{N}-{role}.md`, consensus registry                 |
| **Verification** | Quality gate (test, lint, type-check, build) all passing                                   |

## Phase 0: Initialize

### Select Scope

Ask user with `AskUserQuestion`:

```
question: "What should the review focus on?"
header: "Scope"
options:
  - label: "Full codebase (Recommended)"
    description: "Agents choose where to look — recent changes, hot paths, random exploration"
  - label: "Recent changes"
    description: "Focus on last N commits (asks how many)"
  - label: "Specific directory"
    description: "Constrain to a directory tree (asks which)"
```

If "Recent changes": ask for commit count, then `git log --oneline -N` to build scope context.
If "Specific directory": ask for path, then list source files in that directory to build scope context.

### Configuration

```
SCOPE=<user selection>
SCOPE_CONTEXT=<commit list or directory listing, if scoped>
CURRENT_ROUND=1
MAX_ROUNDS=4
ARTIFACTS_DIR=/tmp/hygiene-$(date +%Y%m%d-%H%M%S)
```

```bash
mkdir -p "$ARTIFACTS_DIR"
```

### Initialize Consensus Registry

```bash
cat > "$ARTIFACTS_DIR/consensus-registry.md" <<'EOF'
# Consensus Registry

Tracks single-agent findings across rounds. If a finding recurs in a later round, it achieves cross-round consensus and is auto-applied.

## Deferred Findings

<!-- Format: | Round | Agent | Severity | File | Summary | -->
EOF
```

### Compaction Recovery

If `$ARTIFACTS_DIR/progress.md` exists, parse the last `### Round N` entry to recover `CURRENT_ROUND` (set to N+1). Previous rounds' fixes are already applied. If `$ARTIFACTS_DIR/consensus-registry.md` exists, read it to recover the deferred findings pool for cross-round consensus detection.

### Gather Codebase Context

Build a brief context snapshot for the agents:

```bash
# Recent activity
git log --oneline -20

# Project structure (discover source directories)
ls -d */ | head -20

# Current test health — run project test command (see AGENTS.md > Project Commands)
# Example: pnpm test, pytest, cargo test

# Any existing lint/type issues — run project lint/type-check (see AGENTS.md > Project Commands)
```

Save this as `CODEBASE_CONTEXT` for agent prompts.

### Skill Routing

Scan codebase for domain keywords. Check `AGENTS.md > Available Skills` for relevant skills. Include skill paths in reviewer prompts where applicable.

### Create Workflow Tasks

```
TaskCreate(subject: "Phase 0: Initialize hygiene review", description: "Select scope, gather context, create consensus registry", activeForm: "Initializing hygiene review...")
TaskCreate(subject: "Phases 1-4: Review loop", description: "3 Opus agents per round, synthesize, apply fixes, convergence check. Up to MAX_ROUNDS.", activeForm: "Running hygiene review...")
TaskCreate(subject: "Phase 5: Finalize", description: "Present no-consensus findings, quality gate, commit, report", activeForm: "Finalizing hygiene review...")
```

**TaskUpdate(task: "Phase 0", status: "completed")**

---

## REVIEW LOOP: Phases 1-4

### Phase 1: Spawn 3 Reviewers (parallel)

**All 3 agents in a single message for parallel execution.**

Each agent writes findings to `$ARTIFACTS_DIR/round-{CURRENT_ROUND}-{role}.md`.

**Agent 1: Bug Hunter (Opus)**

```
Task(subagent_type: "general-purpose", model: "opus", prompt: """
First: read AGENTS.md for project context, coding standards, and conventions.

You are a bug hunter doing a "fresh eyes" review of this codebase. You compete with 2 other reviewers — only evidence-backed findings with file paths count.

## Scope
{SCOPE_CONTEXT or "Full codebase — you choose where to look."}

## Your Method

Explore the codebase with completely fresh eyes. Start wherever interests you — recent git activity, hot paths, complex modules, or random exploration. Read files deeply, trace imports, and follow data flows across the full chain.

Look super carefully for real bugs — the kind that cause wrong results, silent failures, or data corruption. Trust your judgment on where to dig and what matters. Some areas worth considering: logic errors, race conditions, null hazards, swallowed exceptions, type assertion abuse — but follow your instincts, not a checklist.

## Output

Write findings to {ARTIFACTS_DIR}/round-{CURRENT_ROUND}-bug-hunter.md

For each finding:
## Finding N: Title
**Severity:** Critical | High | Medium
**File:** path/to/file:line
**Evidence:** What you read, what's wrong, why it's a problem
**Fix:** Specific change needed
**Auto-fixable:** YES | NO (YES = unambiguous single fix, NO = needs judgment)

Limit: top 7 findings. Skip Low severity. Under 600 words total.
If nothing found, say so — don't invent issues.
""")
```

**Agent 2: Explorer (Opus)**

```
Task(subagent_type: "general-purpose", model: "opus", prompt: """
First: read AGENTS.md for project context, coding standards, and conventions.

You are a codebase explorer doing deep random investigation. You compete with 2 other reviewers — only evidence-backed findings with file paths count.

## Scope
{SCOPE_CONTEXT or "Full codebase — explore freely."}

## Your Method

Pick random starting points across the codebase and go deep. Read files thoroughly, follow import chains, trace data flows end-to-end, check callers and callees. Do this for 3-4 different entry points — let curiosity guide you.

You're looking for anything a fresh pair of eyes would catch — dead code, inconsistent patterns, missing error handling, stale comments, copy-paste drift, unnecessary dependencies. But don't limit yourself to these categories. If something feels off, investigate it. Trust your instincts.

## Output

Write findings to {ARTIFACTS_DIR}/round-{CURRENT_ROUND}-explorer.md

For each finding:
## Finding N: Title
**Severity:** Critical | High | Medium
**File:** path/to/file:line
**Evidence:** What you traced, what's inconsistent/dead/wrong
**Fix:** Specific change needed
**Auto-fixable:** YES | NO

Limit: top 7 findings. Skip Low severity. Under 600 words total.
If nothing found, say so — don't invent issues.
""")
```

**Agent 3: Structural Reviewer (Opus)**

```
Task(subagent_type: "general-purpose", model: "opus", prompt: """
First: read AGENTS.md for project context, coding standards, and conventions.

You are a structural reviewer checking architecture health. You compete with 2 other reviewers — only structural improvements backed by evidence count.

## Scope
{SCOPE_CONTEXT or "Full codebase — assess overall health."}

## Your Method

Read the project structure, then explore source directories with fresh eyes. Assess the overall health of the architecture — dependency cleanliness, test coverage, module boundaries, abstraction levels.

Think about structural integrity: are modules well-bounded? Are dependencies flowing in the right direction? Is there over-abstraction or under-abstraction? Are critical paths tested? But explore broadly — structural issues often hide in unexpected places. Trust your architectural intuition.

## Output

Write findings to {ARTIFACTS_DIR}/round-{CURRENT_ROUND}-structural.md

For each finding:
## Finding N: Title
**Severity:** Critical | High | Medium
**File:** path/to/file:line (or pattern across files)
**Evidence:** What you checked, what's wrong, why it matters
**Fix:** Specific change needed
**Auto-fixable:** YES | NO

Limit: top 7 findings. Skip Low severity. Under 600 words total.
If nothing found, say so — don't invent issues.
""")
```

### Phase 2: Synthesize

**Read all 3 findings files.** This is your core job — do not delegate.

Synthesis principles:

- **Consensus is high-signal** — 2+ agents flagging the same area is almost certainly real
- **Evidence over opinion** — findings need file paths and line numbers
- **Don't pile on** — if explorer finds dead code, that's cleanup, not a bug
- **Critical/High first** — skip Medium unless trivial to fix

Produce a numbered change list. For each: target file, what to change, auto-fixable or not.

### Phase 3: Apply Fixes

**Auto-apply a fix if ANY condition is met:**

1. **Severity-based:** The issue is Critical or High severity — these are defects, not preferences
2. **Same-round consensus:** 2+ agents independently flagged the same issue (regardless of severity) — multi-agent agreement is high-signal
3. **Cross-round consensus:** A single-agent finding from THIS round matches a deferred finding in the consensus registry from a PREVIOUS round — recurrence across rounds is high-signal

**Apply these immediately. Log them as "Auto-applied" in the progress file with the consensus type.**

After each batch of fixes:

```bash
Run project quality checks (see AGENTS.md > Project Commands > Quality gate)
```

If checks fail, revert the breaking fix and note it as non-auto-fixable.

**Defer remaining findings (DO NOT ask user per-round):**

After auto-applying, any remaining changes (Medium/Low severity AND only flagged by a single agent with no cross-round match) are added to the consensus registry — NOT presented to the user.

For each deferred finding, append to `$ARTIFACTS_DIR/consensus-registry.md`:

```markdown
| {CURRENT_ROUND} | {agent role} | {severity} | {file:line} | {one-line summary} |
```

**Non-auto-fixable items** (need judgment, not just low consensus) are also tracked in the registry with a `NO-AUTOFIX` tag for presentation in Phase 5.

### Phase 4: Convergence Check + Progress

Append to `$ARTIFACTS_DIR/progress.md`:

```markdown
### Round {CURRENT_ROUND}

- **Findings:** {count} total ({Critical} Critical, {High} High, {Medium} Medium)
- **Auto-fixed:** {count}
- **Deferred:** {count} (need judgment)
- **Consensus areas:** {where agents agreed}
- **Trajectory:** {assessment}
```

**Rule: if this round's agents found ANY Critical or High issues, you MUST run another round after applying fixes.** Fixes are unverified until the next round's agents confirm no new Critical/High issues emerge. Only finalize after a round where all findings are Medium or lower.

```
IF agents found any Critical or High issues -> apply fixes, continue (increment CURRENT_ROUND)
IF only Medium or no new issues -> finalize (proceed to Phase 5)
IF CURRENT_ROUND >= MAX_ROUNDS -> force finalize (note unverified fixes)
IF this round found same issues as last round -> force finalize (agents are circling)
```

**Between rounds:** Each agent explores DIFFERENT files in the next round. Include in the next prompt: "Files already reviewed: {list from previous round findings}. Look elsewhere."

---

## Phase 5: Finalize

### Present Remaining No-Consensus Findings (once)

Read the consensus registry. Combine two categories into a single presentation:

1. **No-consensus findings:** Single-agent findings that never recurred across rounds
2. **Non-auto-fixable items:** Findings tagged `NO-AUTOFIX` that need judgment regardless of consensus

**If nothing remains:** Skip — proceed to quality gate.

**If items remain:**

```
AskUserQuestion(
  questions: [{
    question: "All consensus findings applied across {CURRENT_ROUND} rounds. {N} items remain for your decision:",
    header: "Remaining",
    multiSelect: true,
    options: [
      { label: "Fix X: <title>", description: "Round {R}, {severity} — {agent}: {file} — <one-line summary>" },
      { label: "Fix Y: <title>", description: "NO-AUTOFIX, {severity} — {agent}: {file} — <one-line summary>" }
    ]
  }]
)
```

**If more than 4 remaining items:** Split across multiple `AskUserQuestion` calls.

**Apply any user-approved fixes** using Edit tool.

### Quality Gate

```bash
Run full project quality gate (see AGENTS.md > Project Commands > Quality gate)
```

If any fail, fix before proceeding.

### Commit Fixes

Only commit if there are actual code changes (not just findings):

```bash
git add <specific files>
git commit -m "chore: hygiene review - {N} issues fixed across {M} files

Round(s): {CURRENT_ROUND}
Scope: {SCOPE}

Co-Authored-By: Claude <noreply@anthropic.com>"
git push
```

### Report

```markdown
## Hygiene Review Summary

**Scope:** {full codebase | recent N commits | directory}
**Rounds:** {CURRENT_ROUND}

### Convergence

Round  Bug Hunter  Explorer  Structural  Total  Applied  Deferred
  1      {n}         {n}       {n}        {n}     {n}       {n}
  2      {n}         {n}       {n}        {n}     {n}       {n}
  3      {n}         {n}       {n}        {n}     {n}       {n}

R1  {▓▓░░░████}  {total}
R2  {░████}      {total}  {-N%}
R3  {██}         {total}  {-N%}

▓ Critical  ░ High  █ Medium

### Resolution

Found: {total} across {CURRENT_ROUND} rounds
  ├─ Auto-applied (severity):      {n}  {bars}
  ├─ Auto-applied (same-round):    {n}  {bars}
  ├─ Auto-applied (cross-round):   {n}  {bars}
  ├─ User-approved:                {n}  {bars}
  └─ Discarded (no consensus):     {n}  {bars}

### Areas Reviewed

- {list key files/directories agents explored}

### Health Assessment

- Tests: {PASS/FAIL}
- Type-check: {PASS/FAIL}
- Lint: {PASS/FAIL}
- Build: {PASS/FAIL}

**Next:** Run again in a few sessions, or after major changes.
```

**Present next step choice with `AskUserQuestion`:**

```
AskUserQuestion(
  questions: [{
    question: "Hygiene review complete ({CURRENT_ROUND} rounds, {fixed} fixed, {deferred} deferred). What's next?",
    header: "Next step",
    multiSelect: false,
    options: [
      { label: "Done", description: "Review complete — no further action needed" },
      { label: "Run again", description: "Another hygiene pass — agents explore different files" },
      { label: "Address deferred items", description: "Work through the items that needed judgment" }
    ]
  }]
)
```

### Cleanup

Remove the temp artifacts directory (safe — always under /tmp):

```bash
find "$ARTIFACTS_DIR" -mindepth 1 -delete && rmdir "$ARTIFACTS_DIR" 2>/dev/null || true
```

---

## When to Use This

Use `/hygiene` for general codebase health between sessions or as a daily maintenance pass. For feature-specific review before merge, consider a scoped review focused on the feature branch diff.

---

## Remember

- **Codebase-wide, not feature-scoped** — agents explore freely (unless user constrains)
- **Fresh eyes each round** — direct agents to unexplored files in subsequent rounds
- **Auto-apply Critical/High + same-round consensus + cross-round consensus — defer the rest**
- **Cross-round consensus:** single-agent findings that recur in later rounds are high-signal — auto-apply on match
- **One human touchpoint:** remaining no-consensus + non-auto-fixable items presented once in Phase 5, not per-round
- **Quality gate before commit** — type-check + lint + test + build must pass
- **Findings files + consensus registry survive compaction** — always read from `$ARTIFACTS_DIR`, not memory
- **Don't invent issues** — if the codebase is clean, say so and finish early

---

_Hygiene: iterative codebase review for daily maintenance. For session closure: `/bead-land`._
