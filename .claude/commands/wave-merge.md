---
description: Merge a wave branch to main — PR creation, CI/agent feedback triage, auto-fix, merge
---

**You are the conductor closing a feature wave.** Create the PR, wait for CI and agent feedback, triage and fix issues, merge when clean.

Run this after `/bead-land` when all beads are complete. This is per-feature (not per-session like bead-land).

---

## I/O Contract

|                  |                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------ |
| **Input**        | Wave branch with all beads complete, pushed (post `/bead-land`)                            |
| **Output**       | PR merged to main, wave branch deleted, feature shipped                                    |
| **Artifacts**    | PR on GitHub, feedback triage in `$ARTIFACTS_DIR/`                                         |
| **Verification** | All CI checks green, PR merged, on main branch                                            |

## Prerequisites

- On a `wave/*` branch
- All beads closed (`br list --json` — none open)
- Branch pushed and up-to-date with remote
- `gh` CLI authenticated

---

## Phase 0: Pre-flight

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
ARTIFACTS_DIR=/tmp/wave-merge-$(date +%Y%m%d-%H%M%S)
mkdir -p "$ARTIFACTS_DIR"
```

### Verify Wave Branch

```bash
CURRENT_BRANCH=$(git branch --show-current)
echo "Current branch: $CURRENT_BRANCH"
```

**If not on a `wave/*` branch:** STOP. "You must be on a wave branch. Current: {CURRENT_BRANCH}"

### Verify All Beads Closed

```bash
br list --json
```

Check for any open/in-progress beads. **If open beads remain:**

```
AskUserQuestion(
  questions: [{
    question: "{N} beads still open. Merge anyway?",
    header: "Open beads",
    multiSelect: false,
    options: [
      { label: "Stop — close beads first", description: "Run /bead-work to finish remaining beads" },
      { label: "Merge anyway", description: "Open beads will remain for a future wave" }
    ]
  }]
)
```

### Quality Gate

```bash
# Run project quality gate (see AGENTS.md > Project Commands > Quality gate)
```

**If any fail:** Fix before proceeding. Do not create a PR with failing local checks.

### Rebase on Main

```bash
git fetch origin main
git rebase origin/main
```

**If conflicts:** Resolve them, run quality gate again, then continue.

```bash
git push --force-with-lease
```

### Ask About CI/Agent Reviews

```
AskUserQuestion(
  questions: [{
    question: "Does this project have GitHub CI checks or agent reviews (e.g., Claude Code Review, CodeRabbit) that run on PRs?",
    header: "PR feedback",
    multiSelect: false,
    options: [
      { label: "Yes — wait for feedback", description: "Wait up to 10 minutes for checks and agent reviews, then triage" },
      { label: "No — merge directly", description: "No CI/agents configured, skip waiting" }
    ]
  }]
)
```

Save as `WAIT_FOR_FEEDBACK` (true/false).

---

## Phase 1: Create PR

### Gather PR Context

```bash
# Bead summary
br list --json > "$ARTIFACTS_DIR/beads.json"

# Commit history on this wave
BASE_BRANCH=main
git log "$BASE_BRANCH"..HEAD --oneline > "$ARTIFACTS_DIR/commits.txt"

# Diff stats
git diff "$BASE_BRANCH"...HEAD --stat > "$ARTIFACTS_DIR/diff-stats.txt"

# Review report (if exists)
ls .claude/reviews/*.md 2>/dev/null | tail -1
```

Also read the plan file (`.claude/plans/*.md`) if it exists for the original intent.

### Build PR Body

Construct a structured PR body from the gathered context:

```markdown
## Summary

{1-3 sentence description of what this wave implements, derived from plan + beads}

## Beads Completed

{list of beads with IDs and titles from br list}

## Changes

{diff stats summary — files changed, insertions, deletions}

## Test Coverage

{quality gate results — tests passing, lint clean, type-check clean}

## Review

{link to .claude/reviews/ report if exists, or "Local review via /work-review"}

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

### Create PR

```bash
gh pr create --title "{wave name}: {short description}" --body "$(cat <<'EOF'
{constructed PR body}
EOF
)"
```

Save the PR number and URL.

**If `WAIT_FOR_FEEDBACK` is false:** Skip to Phase 3 (Merge).

---

## Phase 2: Wait for PR Feedback

### Poll for Checks and Comments

Wait for CI checks and agent reviews to complete. Poll every 30 seconds, timeout after 10 minutes.

```bash
PR_NUMBER={from Phase 1}

# Poll loop (up to 10 minutes)
for i in $(seq 1 20); do
    sleep 30

    # Check CI status
    CHECKS=$(gh pr checks "$PR_NUMBER" 2>/dev/null)
    echo "$CHECKS"

    # Check if all checks have completed (none pending)
    PENDING=$(echo "$CHECKS" | grep -c "pending\|queued\|in_progress" || true)

    if [ "$PENDING" -eq 0 ]; then
        echo "All checks completed."
        break
    fi

    echo "Waiting... ($i/20, ${PENDING} checks still running)"
done
```

### Collect All Feedback

After checks complete (or timeout):

```bash
# CI check results
gh pr checks "$PR_NUMBER" > "$ARTIFACTS_DIR/ci-checks.txt"

# PR comments (agent reviews, bot feedback)
gh api repos/{owner}/{repo}/pulls/$PR_NUMBER/comments --paginate > "$ARTIFACTS_DIR/pr-comments.json"

# PR review comments (review-level feedback)
gh api repos/{owner}/{repo}/pulls/$PR_NUMBER/reviews --paginate > "$ARTIFACTS_DIR/pr-reviews.json"

# Issue comments on the PR
gh pr view "$PR_NUMBER" --comments > "$ARTIFACTS_DIR/pr-discussion.txt"
```

### Assess Feedback

Read all collected feedback. Categorize:

```
IF all checks pass AND no review comments -> Skip to Phase 3 (clean PR)
IF any checks fail OR review comments exist -> Proceed to triage
```

### Triage Feedback

**THIS IS YOUR CORE WORK. Do not delegate triage.**

Parse all PR comments and failed checks into a findings list. For each finding, classify:

**Auto-fix (apply immediately):**
- CI failures with obvious fixes (lint errors, type errors, formatting)
- Agent review items marked as critical or security-related
- Clear, unambiguous single-fix issues (the reviewer told you exactly what to change)

**Conductor decides (apply without asking user):**
- High-severity items with clear fixes
- Easy improvements that don't change architecture
- Items that align with project conventions in AGENTS.md

**Present to user (uncertain items):**
- Architectural suggestions or trade-offs
- Items where the right fix is debatable
- Suggestions that would significantly change the implementation
- Anything the conductor isn't confident about

### Apply Fixes

For auto-fix and conductor-decided items:

```bash
# Apply fixes directly using Edit tool
# After all fixes:
git add <specific files>
git commit -m "$(cat <<'EOF'
fix: address PR feedback

{list of fixes applied}

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
git push
```

### Present Uncertain Items to User

**If uncertain items remain:**

```
AskUserQuestion(
  questions: [{
    question: "Applied {N} fixes from PR feedback. {M} items need your decision:",
    header: "PR feedback",
    multiSelect: true,
    options: [
      { label: "Fix A: <title>", description: "{reviewer}: {file} — <one-line summary>" },
      { label: "Fix B: <title>", description: "{reviewer}: {file} — <one-line summary>" }
    ]
  }]
)
```

**If more than 4 items:** Split across multiple `AskUserQuestion` calls.

Apply user-approved fixes, commit, push.

### Re-poll (Short)

If fixes were pushed, CI/agents will re-run. Brief re-poll — 5 minutes max:

```bash
for i in $(seq 1 10); do
    sleep 30
    CHECKS=$(gh pr checks "$PR_NUMBER" 2>/dev/null)
    PENDING=$(echo "$CHECKS" | grep -c "pending\|queued\|in_progress" || true)
    FAILED=$(echo "$CHECKS" | grep -c "fail" || true)

    if [ "$PENDING" -eq 0 ]; then
        if [ "$FAILED" -gt 0 ]; then
            echo "WARNING: ${FAILED} checks still failing after fixes."
        else
            echo "All checks passing."
        fi
        break
    fi
done
```

**If checks still fail after fixes:** Present failures to user and ask whether to merge anyway or abort.

---

## Phase 3: Merge

### Confirm All Checks

```bash
gh pr checks "$PR_NUMBER"
```

**If any required checks are failing:**

```
AskUserQuestion(
  questions: [{
    question: "{N} required checks still failing. How to proceed?",
    header: "Checks",
    multiSelect: false,
    options: [
      { label: "Abort — fix first", description: "Don't merge. Address failures manually." },
      { label: "Merge anyway", description: "Override failing checks (not recommended)" }
    ]
  }]
)
```

### Merge

```bash
gh pr merge "$PR_NUMBER" --merge --delete-branch
```

Uses merge commit to preserve per-bead commit history.

### Switch to Main

```bash
git checkout main
git pull
```

### Verify

```bash
git log --oneline -5   # Confirm merge commit visible
git branch -d "wave/${WAVE_NAME}" 2>/dev/null || true   # Clean local branch
```

---

## Phase 4: Report + Handoff

### Report

```markdown
## Wave Merged: {wave name}

**PR:** {URL}
**Branch:** wave/{name} → main
**Beads completed:** {count}
**Commits:** {count}
**Files changed:** {count}

### PR Feedback

- **CI checks:** {all passed | N fixed}
- **Agent review findings:** {count} ({auto-fixed} auto-fixed, {user-decided} user-decided, {skipped} skipped)

### What Shipped

{1-3 bullet summary of the feature}
```

### Next Step

```
AskUserQuestion(
  questions: [{
    question: "Wave merged to main. What's next?",
    header: "Next step",
    multiSelect: false,
    options: [
      { label: "Start new feature (Recommended)", description: "Run /plan-init — begin planning the next wave" },
      { label: "Hygiene pass", description: "Run /hygiene — codebase health check after the merge" },
      { label: "Done", description: "Feature shipped — nothing more to do" }
    ]
  }]
)
```

### Cleanup

```bash
rm -rf "$ARTIFACTS_DIR"
```

---

## Remember

- **This is per-feature, not per-session** — run once when all beads are done, not after each bead-work session
- **bead-land handles session closure** — wave-merge handles feature closure. No overlap.
- **Merge commit preserves per-bead history** — don't squash, the flywheel's atomic commits are valuable
- **The wait-triage-fix loop is the core value** — PR creation is trivial, feedback handling is not
- **Bot-agnostic** — works with any CI/agent setup (Claude Code Review, CodeRabbit, Vercel, custom)
- **Auto-fix obvious issues, ask about the rest** — same triage philosophy as the review commands
- **Re-poll is short** — 5 minutes max after pushing fixes, don't loop forever
- **Abort is always an option** — if checks keep failing, let the user decide

---

_Wave merge: create PR, triage feedback, fix, ship. For session closure: `/bead-land`. For next feature: `/plan-init`._
