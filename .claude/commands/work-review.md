---
description: Feature-branch code review — 4 parallel reviewers, severity-based auto-fix, validation gate, user-escalated decisions
---

**You are the conductor.** Four reviewers hunt independently. You synthesize, auto-fix, and escalate. Feature-branch scoped — run after implementation, before merge.

For codebase-wide health checks, use `/hygiene` instead.

---

## I/O Contract

|                  |                                                                                                            |
| ---------------- | ---------------------------------------------------------------------------------------------------------- |
| **Input**        | Feature branch with implementation commits (from `/bead-work`, `/work`, or manual coding)                  |
| **Output**       | Review report in `.claude/reviews/`, auto-fixed issues committed, NEEDS_DECISION items presented           |
| **Artifacts**    | Reviewer findings in `$ARTIFACTS_DIR/round-1-*.md`, progress in `$ARTIFACTS_DIR/progress.md`              |
| **Verification** | All project checks pass (test, lint, type-check), fixes committed, decisions resolved or documented        |

## Prerequisites

- On a feature branch (not main/master)
- Implementation committed and pushed
- Project test/lint/type-check commands runnable

---

## Phase 0: Initialize

**MANDATORY FIRST STEP: Create task list with TaskCreate BEFORE starting.**

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
```

### Configuration

```
ARTIFACTS_DIR=/tmp/work-review-$(date +%Y%m%d-%H%M%S)
```

```bash
mkdir -p "$ARTIFACTS_DIR"
```

### Discover Project Commands

Read `AGENTS.md > Project Commands` for the project's toolchain. Map to workflow variables:

| Variable        | Source                              |
| --------------- | ----------------------------------- |
| `CMD_TEST`      | AGENTS.md > Project Commands > Test |
| `CMD_LINT`      | AGENTS.md > Project Commands > Lint |
| `CMD_TYPECHECK` | AGENTS.md > Project Commands > Type-check |
| `CMD_BUILD`     | AGENTS.md > Project Commands > Build |
| `CMD_FORMAT`    | AGENTS.md > Project Commands > Format |
| `CMD_QUALITY`   | AGENTS.md > Project Commands > Quality gate |

If AGENTS.md doesn't exist or is incomplete, fall back to auto-detection:

```bash
if [ -f "package.json" ]; then
  if [ -f "pnpm-lock.yaml" ]; then PKG="pnpm"
  elif [ -f "yarn.lock" ]; then PKG="yarn"
  elif [ -f "bun.lockb" ]; then PKG="bun"
  else PKG="npm"; fi
  echo "Available scripts:"
  grep -E '^\s+"[^"]+":' package.json | head -20
fi

if [ -f "Cargo.toml" ]; then echo "Rust: cargo test, cargo clippy, cargo build"; fi
if [ -f "Makefile" ]; then echo "Makefile targets:"; grep -E '^[a-zA-Z_-]+:' Makefile | head -10; fi
if [ -f "pyproject.toml" ] || [ -f "setup.py" ]; then echo "Python project"; fi
if [ -f "go.mod" ]; then echo "Go: go test ./..., go vet, go build"; fi
```

If a command doesn't exist for this project, set it to empty and skip in validation phases.

### Create Workflow Tasks

```
TaskCreate(subject: "Phase 0: Initialize", description: "Discover commands, create tasks", activeForm: "Initializing review...")

TaskCreate(subject: "Phase 1: Gather context", description: "Branch safety, diff scope, plan context, baseline check", activeForm: "Gathering context...")

TaskCreate(subject: "Phase 2: Parallel review", description: "Spawn 4 reviewers (security, performance, architecture, correctness)", activeForm: "Running parallel reviews...")

TaskCreate(subject: "Phase 3: Synthesize findings", description: "Dedup, consensus detection, severity-based auto-apply rules", activeForm: "Synthesizing findings...")

TaskCreate(subject: "Phase 4: Auto-fix", description: "Engineer sub-agent applies fixes, runs project tests", activeForm: "Applying auto-fixes...")

TaskCreate(subject: "Phase 5: Validation gate", description: "Run all discovered project checks", activeForm: "Running validation...")

TaskCreate(subject: "Phase 6: Commit report & fixes", description: "Generate review report, safety check, commit, push", activeForm: "Committing review...")

TaskCreate(subject: "Phase 7: Present decisions", description: "NEEDS_DECISION items via AskUserQuestion", activeForm: "Preparing decisions...")

TaskCreate(subject: "Phase 8: Final report + hand-off", description: "Summary, next step choice, cleanup", activeForm: "Generating final report...")
```

### Initialize Consensus Registry

```bash
cat > "$ARTIFACTS_DIR/consensus-registry.md" <<'EOF'
# Consensus Registry

Tracks single-reviewer findings across rounds. If a finding recurs in a verification round, it achieves cross-round consensus and is auto-fixed.

## Deferred Findings

<!-- Format: | Round | Reviewer | Severity | File | Summary | -->
EOF
```

### Compaction Recovery

If `$ARTIFACTS_DIR/progress.md` exists, parse its `### Phase N` entries to recover state. If reviewer findings files exist, skip to Phase 3 (synthesis). If `$ARTIFACTS_DIR/consensus-registry.md` exists, read it to recover the deferred findings pool for cross-round consensus detection.

**TaskUpdate(task: "Phase 0", status: "completed")**

---

## Phase 1: Gather Context

**TaskUpdate(task: "Phase 1", status: "in_progress")**

### Branch Safety Check (CRITICAL)

```bash
CURRENT_BRANCH=$(git branch --show-current)
echo "Current branch: $CURRENT_BRANCH"
```

**If on main or master:** STOP. "You must be on a feature branch for review. Create one first: `git checkout -b fix/<name>`"

### Detect Review Scope

```bash
# Determine base branch
BASE_BRANCH=$(git merge-base --fork-point main HEAD 2>/dev/null && echo "main" || echo "master")

# Diff against base
git diff "$BASE_BRANCH"...HEAD --stat
git diff "$BASE_BRANCH"...HEAD --name-only
```

### Uncommitted Implementation Check

```bash
UNCOMMITTED=$(git diff --name-only | grep -v "^\.claude/" || true)

if [ -n "$UNCOMMITTED" ]; then
  echo "WARNING: Uncommitted implementation files detected!"
  echo "$UNCOMMITTED"
fi
```

If uncommitted files exist, ask user whether to commit them first or proceed reviewing only committed work.

### Load Plan Context (if exists)

```bash
ls -la .claude/plans/*.md 2>/dev/null | head -5
```

If a plan exists, read it for success criteria, test specifications, and original requirements.

### Skill Routing

Scan changed files for domain keywords. Check `AGENTS.md > Available Skills` for relevant skills to include in reviewer prompts:

- DB/SQL/migrations -> database skills
- UI components/styling -> design-system skills
- React hooks/perf -> performance skills
- Security/auth -> security skills
- Tests -> testing skills

Include relevant skill paths in each reviewer prompt: `"Read .claude/skills/<skill>/SKILL.md for domain patterns."`

### Save Context

Append to `$ARTIFACTS_DIR/progress.md`:

```markdown
### Phase 1: Context

- **Branch:** {CURRENT_BRANCH}
- **Base:** {BASE_BRANCH}
- **Changed files:** {count} files, {lines} lines
- **Plan:** {path or "none"}
- **Project commands:** {CMD_TEST}, {CMD_LINT}, {CMD_TYPECHECK}
- **Skills routed:** {list or "none"}
```

**TaskUpdate(task: "Phase 1", status: "completed")**

---

## Phase 2: Parallel Review

**TaskUpdate(task: "Phase 2", status: "in_progress")**

### Get Diff

```bash
git diff "$BASE_BRANCH"...HEAD
```

### Diff Size Check

```bash
git diff "$BASE_BRANCH"...HEAD --stat | tail -1
```

**If diff is very large (>2000 lines):** Ask user with `AskUserQuestion`:

```
question: "Large diff detected ({X} files, {Y} lines). How to proceed?"
header: "Scope"
options:
  - label: "Full review (Recommended)"
    description: "Review everything — may take longer"
  - label: "Key files only"
    description: "Review only the most critical files — suggest list"
  - label: "By directory"
    description: "Split into focused reviews per directory"
```

### Gather Project Context

Read project config files and `AGENTS.md` to build context for reviewers. Extract: framework, key dependencies, test framework, patterns used, language settings, architecture overview.

### Spawn All 4 Reviewers Simultaneously

**CRITICAL: All 4 agents run IN PARALLEL using a single message with 4 Task calls.**

Competitive framing: "You compete with 3 other reviewers — only evidence-backed findings with file paths count."

Each agent writes findings to `$ARTIFACTS_DIR/round-1-{role}.md`.

**Agent 1: Security Reviewer**

```
Task(subagent_type: "general-purpose", model: "sonnet", prompt: """
First: read AGENTS.md for project context, coding standards, and conventions.
{If project has security skills: "Read .claude/skills/<security-skill>/SKILL.md for security patterns."}

You are a security reviewer. You compete with 3 other reviewers — only evidence-backed findings with file paths count.

## Diff to Review
```diff
{DIFF CONTENT}
```

## Examples of What to Look For (not exhaustive)

- OWASP Top 10 vulnerabilities (injection, XSS, CSRF, SSRF)
- Auth/authz bypass opportunities
- Hardcoded secrets or credentials
- Data exposure risks (PII leaks, verbose errors)
- Input validation gaps at system boundaries
- Insecure defaults (permissive CORS, missing rate limits)
- Dependency vulnerabilities (known CVEs in new deps)

Use your judgment — these are starting points, not a complete list. If you spot something security-relevant not listed here, report it.

## Output

Write findings to {ARTIFACTS_DIR}/round-1-security.md

For each finding:
## Finding N: Title
**Severity:** Critical | High | Medium
**File:** path/to/file:line
**Evidence:** What you read, what's wrong, why it's exploitable
**Fix:** Specific change needed
**Auto-fixable:** YES | NO (YES = unambiguous single fix, NO = needs judgment)

Limit: top 7 findings. Skip Low severity. Under 600 words total.
If nothing found, say so — don't invent issues.
""")
```

**Agent 2: Performance Reviewer**

```
Task(subagent_type: "general-purpose", model: "sonnet", prompt: """
First: read AGENTS.md for project context, coding standards, and conventions.
{If project has performance skills: "Read .claude/skills/<perf-skill>/SKILL.md for optimization patterns."}

You are a performance reviewer. You compete with 3 other reviewers — only evidence-backed findings with file paths count.

## Diff to Review
```diff
{DIFF CONTENT}
```

## Examples of What to Look For (not exhaustive)

- N+1 queries or sequential awaits (waterfalls)
- Missing caching opportunities
- Unnecessary re-renders or recomputations
- Heavy imports that should be lazy/dynamic
- Missing pagination or unbounded queries
- Inefficient algorithms (O(n^2) where O(n) suffices)
- Bundle size impact (barrel imports, large deps)
- Missing indexes on queried columns

Use your judgment — these are starting points, not a complete list. If you spot something performance-relevant not listed here, report it.

## Output

Write findings to {ARTIFACTS_DIR}/round-1-performance.md

For each finding:
## Finding N: Title
**Severity:** Critical | High | Medium
**File:** path/to/file:line
**Evidence:** What you measured/traced, why it's slow, what the impact is
**Fix:** Specific change needed
**Auto-fixable:** YES | NO

Limit: top 7 findings. Skip Low severity. Under 600 words total.
If nothing found, say so — don't invent issues.
""")
```

**Agent 3: Architecture Reviewer**

```
Task(subagent_type: "general-purpose", model: "sonnet", prompt: """
First: read AGENTS.md for project context, coding standards, and conventions.
{If project has architecture/coding skills: "Read .claude/skills/<arch-skill>/SKILL.md for patterns."}

You are an architecture reviewer. You compete with 3 other reviewers — only evidence-backed findings with file paths count.

## Diff to Review
```diff
{DIFF CONTENT}
```

## Examples of What to Look For (not exhaustive)

- Pattern misalignment with existing codebase
- Single Responsibility Principle violations
- YAGNI violations (over-engineering, premature abstraction)
- Tight coupling between modules
- Circular dependencies or import cycles
- Wrong abstraction level (under/over-abstraction)
- Missing error handling at system boundaries
- Naming inconsistencies

Use your judgment — these are starting points, not a complete list. If you spot architectural issues not listed here, report them.

## Output

Write findings to {ARTIFACTS_DIR}/round-1-architecture.md

For each finding:
## Finding N: Title
**Severity:** Critical | High | Medium
**File:** path/to/file:line
**Evidence:** What pattern is broken, how it deviates from codebase conventions
**Fix:** Specific change needed
**Auto-fixable:** YES | NO

Limit: top 7 findings. Skip Low severity. Under 600 words total.
If nothing found, say so — don't invent issues.
""")
```

**Agent 4: Correctness Reviewer**

```
Task(subagent_type: "general-purpose", model: "sonnet", prompt: """
First: read AGENTS.md for project context, coding standards, and conventions.
{If project has testing skills: "Read .claude/skills/<testing-skill>/SKILL.md for test patterns."}

You are a correctness reviewer. You compete with 3 other reviewers — only evidence-backed findings with file paths count.

## Diff to Review
```diff
{DIFF CONTENT}
```

## Examples of What to Look For (not exhaustive)

- Logic errors and off-by-one mistakes
- Silent failures (wrong results without errors)
- Race conditions on shared state
- Null/undefined hazards
- Error paths that swallow exceptions
- Type assertions hiding real issues (as any, ! operator abuse)
- Edge cases not handled (empty arrays, zero values, unicode)
- State management issues (stale closures, missing cleanup)
- Missing test coverage for new functionality

Use your judgment — these are starting points, not a complete list. If you spot correctness issues not listed here, report them.

## Output

Write findings to {ARTIFACTS_DIR}/round-1-correctness.md

For each finding:
## Finding N: Title
**Severity:** Critical | High | Medium
**File:** path/to/file:line
**Evidence:** What you traced, the scenario that breaks, expected vs actual behavior
**Fix:** Specific change needed
**Auto-fixable:** YES | NO

Limit: top 7 findings. Skip Low severity. Under 600 words total.
If nothing found, say so — don't invent issues.
""")
```

**Wait for all 4 reviewers to complete.**

**TaskUpdate(task: "Phase 2", status: "completed")**

---

## Phase 3: Synthesize

**TaskUpdate(task: "Phase 3", status: "in_progress")**

**THIS IS YOUR CORE WORK. Do not delegate synthesis.**

### Read All Findings Files

Read from `$ARTIFACTS_DIR/`:
- `round-1-security.md`
- `round-1-performance.md`
- `round-1-architecture.md`
- `round-1-correctness.md`

### Synthesis Principles

- **Consensus is high-signal** — 2+ reviewers flagging the same area is almost certainly real
- **Evidence over opinion** — findings need file paths and line numbers
- **Don't pile on** — if one reviewer flags dead code and another flags architecture, those are different fixes
- **Critical/High first** — skip Medium unless trivial to fix

### Deduplicate

If the same issue is found by multiple reviewers:
- Keep the most detailed description
- Note which reviewers flagged it (consensus signal)

### Produce Numbered Change List

For each item: target file, what to change, severity, which reviewers flagged it, auto-fixable or not.

### Auto-Apply Rules

**Auto-apply a fix if ANY condition is met:**

1. **Severity-based:** The issue is Critical or High severity — these are defects, not preferences
2. **Same-round consensus:** 2+ reviewers independently flagged the same issue (regardless of severity) — multi-agent agreement is high-signal
3. **Cross-round consensus:** A single-reviewer finding from THIS round matches a deferred finding in the consensus registry from a PREVIOUS round — recurrence across rounds is high-signal

Tag these as `AUTO_FIX`.

**Defer remaining findings (DO NOT present to user yet):**

Single-reviewer Medium/Low findings with no cross-round match are added to the consensus registry — NOT tagged as NEEDS_DECISION yet. They may achieve cross-round consensus if a verification round runs.

For each deferred finding, append to `$ARTIFACTS_DIR/consensus-registry.md`:

```markdown
| {round} | {reviewer} | {severity} | {file:line} | {one-line summary} |
```

**Non-auto-fixable items** (need judgment regardless of consensus) are tagged `NEEDS_DECISION` immediately — these skip the registry.

Append to `$ARTIFACTS_DIR/progress.md`:

```markdown
### Phase 3: Synthesis

- **Total findings:** {count} ({Critical} Critical, {High} High, {Medium} Medium)
- **After dedup:** {count}
- **AUTO_FIX:** {count} (severity-based: {N}, consensus-based: {M})
- **NEEDS_DECISION:** {count}
- **Consensus areas:** {where reviewers agreed}
```

**TaskUpdate(task: "Phase 3", status: "completed")**

---

## Phase 4: Auto-Fix

**TaskUpdate(task: "Phase 4", status: "in_progress")**

### If No AUTO_FIX Items

Skip to Phase 5.

### If AUTO_FIX Items Exist

Spawn engineer with the specific fix list:

```
Task(subagent_type: "general-purpose", model: "sonnet", prompt: """
Read AGENTS.md for project context.

## Your Task

Apply these fixes exactly as specified. Do NOT modify NEEDS_DECISION items.

## Fixes to Apply

{numbered list of AUTO_FIX items with file, line, and exact change}

## After All Fixes

Run the project's checks (from AGENTS.md > Project Commands):
{CMD_TEST} && {CMD_LINT} && {CMD_TYPECHECK}

## Output

Write results to {ARTIFACTS_DIR}/auto-fix-result.md:
- Files modified (with paths)
- Fixes applied (reference finding numbers)
- Check results (test, lint, type-check — all must pass)
- Any fixes that couldn't be applied (and why)
""")
```

### Verify Fixes

Read the engineer's result file. Confirm:
1. All AUTO_FIX items applied (or documented why not)
2. Project checks pass
3. No unintended side effects (review diff)

**If checks fail:** Revert the breaking fix and move that item to NEEDS_DECISION.

**TaskUpdate(task: "Phase 4", status: "completed")**

---

## Phase 5: Validation Gate

**TaskUpdate(task: "Phase 5", status: "in_progress")**

Run all discovered project commands:

```bash
{CMD_FORMAT}    # if exists
{CMD_LINT}      # if exists
{CMD_TYPECHECK} # if exists
{CMD_TEST}      # if exists
{CMD_BUILD}     # if exists — full build check
```

**If all pass:** Continue to Phase 6.

**If any fail:**
- Fix the issue (small fixes directly, larger ones via engineer sub-agent)
- Re-run the failing command
- Only proceed after all pass OR user explicitly says "skip validation"

**TaskUpdate(task: "Phase 5", status: "completed")**

---

## Phase 5.5: Optional Convergence Round

**Only offer this if auto-fixes touched Critical or High issues.** Fixes are unverified until fresh reviewers confirm no new issues emerged.

```
AskUserQuestion(
  questions: [{
    question: "Auto-fixes touched {N} Critical/High issues. Run a verification round?",
    header: "Convergence",
    multiSelect: false,
    options: [
      { label: "Run verification round (Recommended)", description: "Spawn reviewers again to confirm fixes didn't introduce new issues" },
      { label: "Skip — trust the fixes", description: "Proceed to commit without re-review" }
    ]
  }]
)
```

**If verification round:** Re-run Phase 2-5 with the updated diff. Include in reviewer prompts: "Previous round found and fixed: {list}. Check if fixes are correct and look for NEW issues only." Max 2 total rounds. During Phase 3 of the verification round, check new findings against the consensus registry for cross-round matches — any match auto-applies.

---

## Phase 6: Commit Report & Fixes

**TaskUpdate(task: "Phase 6", status: "in_progress")**

### Generate Review Report

Create file: `.claude/reviews/YYYY-MM-DD-HHMM-[feature].md`

```markdown
# Code Review: [Feature/Branch Name]

**Date:** YYYY-MM-DD
**Branch:** {CURRENT_BRANCH}
**Base:** {BASE_BRANCH}
**Plan:** {plan path or "none"}
**Reviewers:** Security, Performance, Architecture, Correctness
**Rounds:** {count}

---

## Summary

| Category     | Critical | High | Medium | Auto-Fixed |
| ------------ | -------- | ---- | ------ | ---------- |
| Security     | X        | Y    | Z      | A          |
| Performance  | X        | Y    | Z      | B          |
| Architecture | X        | Y    | Z      | C          |
| Correctness  | X        | Y    | Z      | D          |
| **Total**    | X        | Y    | Z      | E          |

---

## Auto-Fixed Issues

{list of issues auto-applied with finding IDs}

---

## Needs Decision

{list of NEEDS_DECISION items}

---

## All Findings

### Security
{findings}

### Performance
{findings}

### Architecture
{findings}

### Correctness
{findings}
```

### Safety Check

```bash
git status --short
```

**If ANY deletions (D):** STOP and ask "About to delete {N} files. Is this intentional?" Wait for confirmation.

### Commit

```bash
git add .claude/reviews/YYYY-MM-DD-HHMM-[feature].md
git add <files modified by auto-fixes>
git commit -m "$(cat <<'EOF'
review: [feature] - {N} issues fixed, {M} need decision

Auto-fixed: {count} ({Critical} Critical, {High} High, {consensus} consensus)
Needs decision: {count}

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
git push
```

**TaskUpdate(task: "Phase 6", status: "completed")**

---

## Phase 7: Present Decisions

**TaskUpdate(task: "Phase 7", status: "in_progress")**

### Collect All Remaining Items

Combine two categories into a single presentation:

1. **NEEDS_DECISION items:** Non-auto-fixable findings that need judgment
2. **No-consensus findings:** Read the consensus registry — single-reviewer findings that never achieved cross-round consensus

### If Nothing Remains

Report auto-fix results and skip to Phase 8.

### If Items Remain

Present via `AskUserQuestion` (once):

```
AskUserQuestion(
  questions: [{
    question: "Auto-applied {N} fixes (severity + consensus). {M} items remain for your decision:",
    header: "Decisions",
    multiSelect: true,
    options: [
      { label: "Fix A: <title>", description: "NEEDS_DECISION, {severity} — {reviewer}: {file}: {one-line summary}" },
      { label: "Fix B: <title>", description: "No consensus, Round {R}, {severity} — {reviewer}: {file}: {one-line summary}" }
    ]
  }]
)
```

**If more than 4 items:** Split across multiple `AskUserQuestion` calls.

### Apply Chosen Fixes

Spawn engineer for approved items:

```
Task(subagent_type: "general-purpose", model: "sonnet", prompt: """
Read AGENTS.md for project context.

Apply these changes based on user decisions:

{list of approved NEEDS_DECISION items with specific fixes}

Run project checks after changes (from AGENTS.md > Project Commands):
{CMD_TEST} && {CMD_LINT} && {CMD_TYPECHECK}
""")
```

### Commit Decision Fixes

```bash
git add <specific files>
git commit -m "$(cat <<'EOF'
review: implement decisions for [feature]

Applied: {list of chosen items}

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
git push
```

**TaskUpdate(task: "Phase 7", status: "completed")**

---

## Phase 8: Final Report + Hand-Off

**TaskUpdate(task: "Phase 8", status: "in_progress")**

### Summary

```markdown
## Review Complete: [Feature]

**Status:** APPROVED
**Report:** `.claude/reviews/YYYY-MM-DD-HHMM-[feature].md`
**Rounds:** {count}

### Convergence

Round  Security  Performance  Architecture  Correctness  Total  Applied  Deferred
  1      {n}       {n}          {n}           {n}         {n}     {n}       {n}
  2      {n}       {n}          {n}           {n}         {n}     {n}       {n}

R1  {▓▓░░░████}  {total}
R2  {░████}      {total}  {-N%}

▓ Critical  ░ High  █ Medium

### Resolution

Found: {total} across {count} rounds
  ├─ Auto-applied (severity):      {n}  {bars}
  ├─ Auto-applied (same-round):    {n}  {bars}
  ├─ Auto-applied (cross-round):   {n}  {bars}
  ├─ User-approved:                {n}  {bars}
  └─ Discarded (no consensus):     {n}  {bars}

### Changes Made

- {list key auto-fixes}

### Decisions Made

- {list decisions and outcomes, or "none needed"}

**All project checks passing.**
```

### Next Step

```
AskUserQuestion(
  questions: [{
    question: "Review complete ({N} fixed, {M} decisions resolved). What's next?",
    header: "Next step",
    multiSelect: false,
    options: [
      { label: "Merge (Recommended)", description: "Run /wave-merge — create PR, triage CI/agent feedback, ship to main" },
      { label: "Another review pass", description: "Run /work-review again — fresh eyes on the updated code" },
      { label: "Manual review", description: "Done with automated review — you'll review manually" },
      { label: "Done for now", description: "Review saved — pick up later" }
    ]
  }]
)
```

### Cleanup

```bash
rm -rf "$ARTIFACTS_DIR"
```

**TaskUpdate(task: "Phase 8", status: "completed")**

---

## Flexibility & Overrides

**"Quick review"**
-> Spawn single comprehensive reviewer (Opus) instead of 4 specialized ones

**"Just report, don't fix"**
-> Skip Phase 4 (auto-fix), present all findings as report only

**"Review these files only: [list]"**
-> Scope diff to specified files instead of full branch diff

**"Skip validation"**
-> Bypass Phase 5 validation gate

**"Skip convergence"**
-> Never offer Phase 5.5 verification round

---

## When to Use This vs /hygiene

|            | `/work-review`                            | `/hygiene`                             |
| ---------- | ----------------------------------------- | -------------------------------------- |
| **Scope**  | Feature branch diff                       | Whole codebase                         |
| **When**   | After `/bead-work` or `/work`             | Between sessions, daily maintenance    |
| **Agents** | 4 specialized Sonnet reviewers, 1-2 rounds | 3 Opus explorers, multi-round          |
| **Fixes**  | Engineer sub-agent                        | Conductor applies directly             |
| **Focus**  | Security, perf, arch, correctness         | Bugs, dead code, drift, health         |

Use both: `work-review` for pre-merge validation, `hygiene` for general health.

---

## Remember

- **YOU synthesize, engineers fix** — reviewers analyze, you decide what's real, engineer applies
- **Auto-apply Critical/High + same-round consensus + cross-round consensus** — defer the rest to registry
- **Cross-round consensus:** single-reviewer findings that recur in verification rounds are high-signal — auto-apply on match
- **One human touchpoint:** remaining no-consensus + NEEDS_DECISION items presented once in Phase 7, not per-round
- **Findings files + consensus registry survive compaction** — always read from `$ARTIFACTS_DIR`, not memory
- **Progress file is compaction recovery** — parse it on restart for phase state
- **Project commands come from AGENTS.md** — detect from config files only as fallback
- **Skill routing is dynamic** — check AGENTS.md > Available Skills, don't hardcode paths
- **No decisions without the user** — architectural choices and trade-offs are NEEDS_DECISION
- **Convergence is optional** — only offer verification round for Critical/High auto-fixes

---

_Work review: parallel reviewers, severity-based auto-fix, user-gated decisions. For codebase health: `/hygiene`. For implementation: `/bead-work`._
