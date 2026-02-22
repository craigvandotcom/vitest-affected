---
description: Iterative codebase review (3 agents, multiple rounds until plateau) — daily maintenance, not feature-scoped
---

**You are the conductor.** Three reviewers hunt independently. You synthesize, fix, and iterate. Codebase-wide — not tied to any feature branch or diff.

Run this after a few bead-work sessions, or daily for maintenance. For feature-scoped review, use `/work-review` instead.

---

## Phase 0: Initialize

### Register with Agent Mail

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
```

```
macro_start_session(
  human_key: "$PROJECT_ROOT",
  program: "claude-code",
  model: "<your model>",
  task_description: "hygiene review"
)
```

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

### Compaction Recovery

If `$ARTIFACTS_DIR/progress.md` exists, parse the last `### Round N` entry to recover `CURRENT_ROUND` (set to N+1). Previous rounds' fixes are already applied.

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

### Check Inbox

```
fetch_inbox(project_key, agent_name)
```

Acknowledge any pending messages.

---

## REVIEW LOOP: Phases 1-4

### Phase 1: Spawn 3 Reviewers (parallel)

**All 3 agents in a single message for parallel execution.**

Each agent writes findings to `$ARTIFACTS_DIR/round-{CURRENT_ROUND}-{role}.md`.

**Agent 1: Bug Hunter (Opus)**

```
Task(subagent_type: "general-purpose", model: "opus", prompt: """
First: read AGENTS.md for project context, coding standards, and conventions.

You are a bug hunter doing a "fresh eyes" review of this codebase.

## Scope
{SCOPE_CONTEXT or "Full codebase — you choose where to look."}

## Your Method

1. Start with recent git activity: `git log --oneline -15` and `git diff HEAD~5..HEAD --stat`
2. Pick 3-5 files that look interesting (recently changed, complex, critical path)
3. For each file: read it completely, trace its imports, understand the data flow
4. Look super carefully with fresh eyes for:
   - Obvious bugs, logic errors, off-by-one mistakes
   - Silent failures (wrong results, no error thrown)
   - Race conditions on shared state
   - Null/undefined hazards
   - Error paths that swallow exceptions
   - Type assertions hiding real issues (`as any`, `!` operator abuse)

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

You are a codebase explorer doing deep random investigation.

## Scope
{SCOPE_CONTEXT or "Full codebase — explore freely."}

## Your Method

1. Pick a random starting point — a feature directory, a utility file, a hook
2. Read it deeply, then trace its functionality through related files
3. Follow imports, check callers, understand the full data path
4. Do this for 3-4 different entry points across the codebase
5. Look super carefully with fresh eyes for:
   - Dead code (unused exports, unreachable branches)
   - Inconsistent patterns (same thing done 3 different ways)
   - Missing error handling at system boundaries
   - Stale comments that no longer match the code
   - Copy-paste code that drifted apart
   - Dependencies that could be removed

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

You are a structural reviewer checking architecture health.

## Scope
{SCOPE_CONTEXT or "Full codebase — assess overall health."}

## Your Method

1. Read the project structure from AGENTS.md > Architecture, then explore source directories
2. Check dependency health: are imports clean? Any circular deps?
3. Check test coverage: find test directories/files — are critical paths tested?
4. Check for:
   - Modules/classes doing too much (SRP violations >150 lines)
   - Functions/modules with mixed concerns
   - API routes missing validation
   - Shared state that should be local (or vice versa)
   - Over-abstraction (wrappers that add nothing)
   - Under-abstraction (copy-paste that should be shared)
   - Security: hardcoded values, missing auth checks, exposed secrets

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

**Auto-apply a fix if EITHER condition is met:**

1. **Severity-based:** The issue is Critical or High severity — these are defects, not preferences
2. **Consensus-based:** 2+ agents independently flagged the same issue (regardless of severity) — multi-agent agreement is high-signal

**Apply these immediately. Log them as "Auto-applied" in the progress file.**

**Ask only about remaining items (Medium/Low AND single-agent):**

```
AskUserQuestion(
  questions: [{
    question: "Auto-applied {N} fixes (Critical/High + consensus). {M} single-agent findings remain:",
    header: "Remaining",
    multiSelect: true,
    options: [
      { label: "Fix X: <title>", description: "Medium — <agent>: <file>: <one-line summary>" },
      { label: "Fix Y: <title>", description: "Medium — <agent>: <file>: <one-line summary>" }
    ]
  }]
)
```

**If no remaining items after auto-apply:** Skip the question entirely — just report what was applied.

**If more than 4 remaining items:** Split across multiple `AskUserQuestion` calls.

**Apply approved fixes** using Edit tool. You are the conductor — direct fixes are faster than spawning an engineer for hygiene work.

After each batch of fixes:

```bash
Run project quality checks (see AGENTS.md > Project Commands > Quality gate)
```

If checks fail, revert the breaking fix and note it as non-auto-fixable.

**Non-auto-fixable items:**

Collect these for user presentation after the loop.

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

### Present Deferred Items

If non-auto-fixable items exist, present them:

```
## Hygiene Review: Items Needing Your Decision

### Item N: <title>
**Severity:** Critical | High | Medium
**File:** path/to/file:line
**Found by:** {agent role(s)}
**Issue:** {description}
**Options:**
- [A] {option} (Recommended)
- [B] {option}
```

Use `AskUserQuestion` with `multiSelect: true` if there are actionable choices. Group by severity.

### Report

```markdown
## Hygiene Review Summary

**Scope:** {full codebase | recent N commits | directory}
**Rounds:** {count}
**Findings:** {total} ({by severity})
**Fixed:** {count} auto-fixed
**Deferred:** {count} for user decision

**Areas Reviewed:**

- {list key files/directories agents explored}

**Health Assessment:**

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

### Release Reservations

```
release_file_reservations(project_key, agent_name)
```

---

## When to Use This

Use `/hygiene` for general codebase health between sessions or as a daily maintenance pass. For feature-specific review before merge, consider a scoped review focused on the feature branch diff.

---

## Remember

- **Codebase-wide, not feature-scoped** — agents explore freely (unless user constrains)
- **Fresh eyes each round** — direct agents to unexplored files in subsequent rounds
- **Fix what's clear, defer what's not** — don't make architectural decisions without the user
- **Quality gate before commit** — type-check + lint + test + build must pass
- **Findings files survive compaction** — always read from `$ARTIFACTS_DIR`, not memory
- **Don't invent issues** — if the codebase is clean, say so and finish early

---

_Hygiene: iterative codebase review for daily maintenance. For session closure: `/bead-land`._
