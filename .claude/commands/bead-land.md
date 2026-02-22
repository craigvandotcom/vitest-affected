---
description: Session closure with retrospective learning and system compounding — land, learn, compound, hand off
---

**You are the conductor closing a bead-work session.** Land the plane, extract learnings, propose system upgrades, hand off cleanly.

Run this after `/bead-work` completes its target beads.

---

## Phase 0: Initialize

### Gather Session Context

```
ARTIFACTS_DIR=/tmp/bead-work
```

Read `$ARTIFACTS_DIR/progress.md` — this is the record of what was accomplished. If it doesn't exist, STOP: "No bead-work progress found. Run `/bead-work` first."

Also gather:

```bash
# What beads were completed this session
br list --json

# Recent commits (the session's work)
git log --oneline -20

# Current state
git status
git diff --stat
```

---

## Phase 1: Land the Plane

**NON-NEGOTIABLE. No work stranded locally.**

### 1a. File Remaining Work

- Check for any started-but-unclosed beads: `br list --json` — look for claimed/in-progress items
- For each: either close it (if done) or add a comment documenting where you left off
- Create new beads for any loose ends discovered during the session:
  ```bash
  br create "Follow-up: <description>" --priority P1 --description "Discovered during bead-work session. Context: ..."
  ```

### 1b. Quality Gates

```bash
# Run full project quality gate (see AGENTS.md > Project Commands > Quality gate)
```

If any fail:

- **Fixable in <5 min:** Fix them now, commit the fix
- **Larger issues:** Create a P0 bead, document the failure, continue landing

### 1c. UI Validation Suite (Optional)

After code quality gates pass, optionally run UI validation if browser testing tools are available.

**Skip if:**
- Session was purely docs/config with zero runtime code changes
- No browser testing tool is available (e.g., `agent-browser`, Playwright MCP)
- No UI journeys defined in project

**Run if:**
- Browser testing tool is available AND the project defines UI journeys (in AGENTS.md or `.claude/skills/`)
- Runtime code was changed (API routes, UI components, hooks, utils)

#### Step 1: Check Browser Testing Availability

```bash
# Check if browser testing tool is available
which agent-browser 2>/dev/null || echo "No browser testing tool found — skipping UI validation"
```

If no browser testing tool is available, skip to Phase 1d (Git Operations).

#### Step 2: Route to Relevant Journeys

Use `git diff --stat` against the session's first commit to determine which areas were changed. Cross-reference with project journey definitions (if any) to identify relevant UI tests.

#### Step 3: Spawn Testers

**One tester per matched journey, all in parallel.** If 2+ journeys match, send all Task calls in a single message for concurrent execution.

````
Task(subagent_type: "general-purpose", model: "haiku", prompt: """
You are a browser tester. Your job: run a UI journey happy path and report results. You test and report — never edit code.

## Your Task
Run the <journey-name> journey happy path. This is session closure smoke testing.

### Setup
1. Dev server is already running
2. Open the journey's starting URL using the project's browser testing tool

### Test

Run Happy Path steps from the journey definition. Focus on:

- Elements render correctly
- Interactions work (clicks, form fills, navigation)
- No console errors
- Correct data flow (saves, displays, updates)

### Output

Write report to /tmp/bead-work/ui-suite-<journey-name>.md
Include screenshots for any failures.
Happy path only — skip edge cases.
""")
````

#### Step 4: Review Results

Read all report files from `/tmp/bead-work/ui-suite-*.md`.

- **All PASS:** Continue to git operations
- **Any FAIL:** Fix the issue, re-run only the failing journey's tester, then continue
- **Skipped:** Note "UI validation skipped (no browser tool / no journeys defined)"

### 1d. Git Operations

```bash
git add <specific files>
git commit -m "chore: bead-work session cleanup

Co-Authored-By: Claude <noreply@anthropic.com>"
```

Only commit if there are uncommitted changes (cleanup, format fixes, etc.).

```bash
git pull --rebase
git push
git status   # Must show "up to date with origin"
```

**If push fails:** Resolve and retry. Do not proceed until pushed.

---

## Phase 2: Learn (Retrospective)

**Goal:** With complete information, identify what worked, what didn't, and what friction occurred.

### Spawn Retrospective Sub-Agent

```
Task(subagent_type: "general-purpose", model: "sonnet", prompt: """
You are a retrospective analyst reviewing a completed bead-work session.

## Session Artifacts

Read these files:
1. /tmp/bead-work/progress.md — beads completed, commits, files changed
2. Any /tmp/bead-work/bead-*-result.md files — engineer implementation reports
3. AGENTS.md — current project context, conventions, and coding standards

## Git Context

Run these commands to understand the session's work:
- `git log --oneline -20` — recent commits
- `git diff HEAD~N..HEAD --stat` (where N = number of session commits) — files changed

## Your Analysis

Write your findings to /tmp/bead-work/retrospective.md with these sections:

### What Worked
- Patterns that produced clean, fast results
- Bead specs that led to good implementations
- Tools/commands that worked smoothly

### What Didn't Work
- Beads that needed multiple engineer attempts (and why)
- Quality gate failures and their causes
- Friction points in the workflow

### Patterns Observed
- Recurring code patterns across beads
- Common test patterns
- Dependency patterns

### System Upgrade Opportunities
For each opportunity, provide:
- **Target:** Which file to update (AGENTS.md, MEMORY.md, skills, commands, etc.)
- **Change:** What specifically to add, modify, or remove
- **Severity:** Critical / High / Medium / Low
  - Critical: Prevents failures or fixes broken workflow
  - High: Significant efficiency gain or quality improvement
  - Medium: Nice-to-have improvement
  - Low: Minor polish
- **Evidence:** Concrete examples from this session

Be aggressive — look for meaningful improvements. But every suggestion must have evidence from this session.
Context bloat is the enemy. Prefer refining existing content over adding new content.
""")
```

### Conductor Reviews Retrospective

Read `/tmp/bead-work/retrospective.md`. Verify findings against your own experience of the session. Remove anything speculative — keep only evidence-backed items.

---

## Phase 3: Compound (System Upgrades)

**Goal:** Turn learnings into system improvements. User decides what ships.

### Present Upgrades to User

First, output each upgrade opportunity so the user can see the details:

```
## Upgrade N: <title>
**Severity:** Critical | High | Medium | Low
**Target:** <file path>
**Evidence:** <what happened this session>
**Proposed Change:**
<exact diff or content to add/modify/remove>
```

Group by severity (Critical first, Low last). Present ALL of them.

Then use `AskUserQuestion` with `multiSelect: true` to let the user pick interactively:

```
AskUserQuestion(
  questions: [{
    question: "Which system upgrades should I apply?",
    header: "Compound",
    multiSelect: true,
    options: [
      { label: "Upgrade 1: <title>", description: "Critical — <one-line summary>" },
      { label: "Upgrade 2: <title>", description: "High — <one-line summary>" },
      { label: "Upgrade 3: <title>", description: "Medium — <one-line summary>" },
      ...up to 4 options per question (AskUserQuestion limit)
    ]
  }]
)
```

**If more than 4 upgrades:** Split across multiple `AskUserQuestion` calls grouped by severity. Critical+High in the first question, Medium+Low in the second. The user can always select "Other" to provide custom input (skip all, apply all, etc.).

### Apply Approved Upgrades

For each approved upgrade, apply the edit directly. Common targets:

| Target                              | What Gets Updated                      |
| ----------------------------------- | -------------------------------------- |
| `AGENTS.md`                         | Workflow improvements, new conventions |
| `CLAUDE.md`                         | Orchestrator context updates           |
| `.claude/commands/*.md`             | Command improvements based on friction |
| `MEMORY.md`                         | New patterns, gotchas, workflow notes  |

### Commit Compound Changes

```bash
git add <specific files>
git commit -m "chore: compound learnings from bead-work session

Applied N system upgrades from retrospective.

Co-Authored-By: Claude <noreply@anthropic.com>"
git push
```

---

## Phase 4: Hand Off

### Session Summary

Output for the user and next session:

```markdown
## Bead-Work Session Summary

**Beads Completed:** N (list IDs + titles)
**Beads Remaining:** M (from `br ready --json`)
**Commits:** K commits pushed

**Quality Gates:** All passing | Issues filed (list)
**UI Validation:** All PASS | Failures fixed (list) | Skipped (docs/config only)

**Learnings Applied:** X upgrades (list targets)

**Open Issues:**

- (any filed beads or blockers)
```

**Present next session choice with `AskUserQuestion`:**

```
AskUserQuestion(
  questions: [{
    question: "Session landed. What's next?",
    header: "Next step",
    multiSelect: false,
    options: [
      { label: "Continue bead-work", description: "Run /bead-work — {M} beads remaining" },
      { label: "Refine remaining beads", description: "Run /bead-refine — revise remaining beads before implementing" },
      { label: "Feature complete", description: "All beads done — ready for final review or merge" },
      { label: "Done for now", description: "Close session — pick up later" }
    ]
  }]
)
```

### Cleanup Temp Files

Remove session artifacts (they've been consumed by retrospective). Run each separately to avoid shell chaining that triggers safety hooks:

```bash
rm -rf /tmp/bead-work
rm -rf /tmp/plan-refine-internal-*
rm -rf /tmp/bead-refine-*
rm -rf /tmp/beadify-*
```

### Final Verification

```bash
git status          # Clean working tree
git log --oneline -1  # Latest commit pushed
br ready --json     # What's left
```

---

## Remember

- **Land is NON-NEGOTIABLE** — push before learning
- **Learn from evidence, not speculation** — every finding needs a concrete example from this session
- **Compound aggressively but user-gated** — propose bold changes, let user decide
- **Context bloat is the enemy** — refine existing content, don't just append
- **Temp files are the source of truth** — read from `$ARTIFACTS_DIR`, not memory
- **This is what makes the flywheel accelerate** — each session improves the next

---

_Bead land: close clean, learn deep, compound forward. The flywheel spins faster every session._
