---
description: Plan correctness check — 3 Sonnet agents verify accuracy, structure, and polish across 1-3 rounds with cross-round consensus
---

**You are the conductor.** Three Sonnet reviewers check plan correctness independently. You track consensus across rounds and apply fixes. This is a hygiene pass — targeted edits, not a rewrite.

Run this as the final step before implementation. The plan's strategy and architecture are already settled; you're checking that the document is accurate, consistent, and clean.

---

## I/O Contract

|                  |                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------ |
| **Input**        | Approved plan file (`.claude/plans/*.md` or user-specified)                                |
| **Output**       | Same plan file, corrected in-place                                                         |
| **Artifacts**    | Findings in `$ARTIFACTS_DIR/`, consensus registry in `$ARTIFACTS_DIR/consensus-registry.md` |
| **Verification** | Plan committed after corrections                                                           |

## Phase 0: Initialize

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
```

### Identify Plan File

`PLAN_FILE`: Check argument, then `.claude/plans/*.md`, then `PLAN.md` in project root. If none found, STOP: "No plan found. Provide a path or run /plan-init first."

### Skill Routing

Scan the plan for domain keywords. Check `AGENTS.md > Available Skills` for relevant skills. Include skill paths in reviewer prompts where applicable.

### Configuration

```
CURRENT_ROUND=1
MAX_ROUNDS=3
AGENT_MODEL=sonnet
ARTIFACTS_DIR=/tmp/plan-clean-$(date +%Y%m%d-%H%M%S)
```

```bash
mkdir -p "$ARTIFACTS_DIR"
```

### Checkpoint Plan

```bash
git add "$PLAN_FILE" && git commit -m "docs(plan): checkpoint before plan-clean

Co-Authored-By: Claude <noreply@anthropic.com>" || true
```

### Initialize Consensus Registry

Create the cross-round tracking file:

```bash
cat > "$ARTIFACTS_DIR/consensus-registry.md" <<'EOF'
# Consensus Registry

Tracks single-agent findings across rounds. If a finding recurs in a later round, it achieves cross-round consensus and is auto-applied.

## Deferred Findings

<!-- Format: | Round | Agent | Finding ID | Summary | Section | -->
EOF
```

### Compaction Recovery

If `$ARTIFACTS_DIR/progress.md` exists, parse the last `### Round N` entry to recover `CURRENT_ROUND` (set to N+1). If `consensus-registry.md` exists, read it to recover the deferred findings pool.

### Create Workflow Tasks

```
TaskCreate(subject: "Phase 0: Initialize plan-clean", description: "Identify plan, checkpoint, create consensus registry", activeForm: "Initializing plan-clean...")
TaskCreate(subject: "Phases 1-3: Review loop", description: "3 Sonnet reviewers per round, synthesize, convergence check. Up to MAX_ROUNDS.", activeForm: "Reviewing plan...")
TaskCreate(subject: "Phase 4: Finalize", description: "Present no-consensus findings, commit, report", activeForm: "Finalizing plan-clean...")
```

**TaskUpdate(task: "Phase 0", status: "completed")**

---

## REVIEW LOOP: Phases 1-3

### Phase 1: Spawn 3 Reviewers (parallel)

**All 3 agents in a single message for parallel execution.** Each writes findings to `$ARTIFACTS_DIR/round-{CURRENT_ROUND}-{role}.md`.

**Agent 1: Verifier (Sonnet)**

```
Task(subagent_type: "general-purpose", model: "sonnet", prompt: """
First: read AGENTS.md for project context and conventions.

You are verifying plan ACCURACY against the actual codebase. You compete with 2 other reviewers — only evidence-backed findings count.

## Plan

{Read and include PLAN_FILE content}

## Your Method

Cross-reference the plan's claims against reality. Extract file paths, function names, type names, imports, and external APIs — then verify each against the actual codebase and package manifests.

## Examples of What to Look For (not exhaustive)

- File paths that don't exist or have wrong names
- Functions/types referenced with wrong signatures or locations
- External library APIs assumed incorrectly (wrong method names, wrong parameters)
- Version-specific features assumed but not available in installed version
- Internal plan references that point to wrong sections

Use your judgment — if something seems inaccurate, verify it.

## Output

Write findings to {ARTIFACTS_DIR}/round-{CURRENT_ROUND}-verifier.md

For each finding:
## Finding N: Title
**Section:** Which plan section contains the error
**Reference:** The exact claim in the plan
**Reality:** What actually exists (with file:line evidence)
**Fix:** The specific correction needed

Limit: top 7 findings. Under 400 words. Only report real inaccuracies — don't flag stylistic issues.
If nothing found, say so — don't invent issues.
""")
```

**Agent 2: Auditor (Sonnet)**

```
Task(subagent_type: "general-purpose", model: "sonnet", prompt: """
First: read AGENTS.md for project context and conventions.

You are auditing plan STRUCTURE and LOGIC. You compete with 2 other reviewers — only evidence-backed findings count.

## Plan

{Read and include PLAN_FILE content}

## Your Method

Read the plan end-to-end, checking that the logical flow holds. Trace what each phase produces and what the next phase consumes — verify the chain is unbroken.

## Examples of What to Look For (not exhaustive)

- Logical gaps: Phase 3 needs X but no prior phase creates X
- Contradictions: two sections making incompatible claims
- Circular dependencies: A needs B needs A
- Missing steps: jumps from state A to state C without B
- Unclear ownership: deliverables not assigned to a specific phase
- Redundant sections: same information stated in multiple places

Use your judgment — if the logic feels off somewhere, dig into it.

## Output

Write findings to {ARTIFACTS_DIR}/round-{CURRENT_ROUND}-auditor.md

For each finding:
## Finding N: Title
**Section(s):** Which plan section(s) are involved
**Issue:** What's wrong with the logic or structure
**Evidence:** Quote the conflicting/missing content
**Fix:** The specific correction needed

Limit: top 7 findings. Under 400 words. Only report structural issues — don't flag accuracy or style.
If nothing found, say so — don't invent issues.
""")
```

**Agent 3: Editor (Sonnet)**

```
Task(subagent_type: "general-purpose", model: "sonnet", prompt: """
First: read AGENTS.md for project context and conventions.

You are checking plan HYGIENE and CLARITY. You compete with 2 other reviewers — only evidence-backed findings count.

## Plan

{Read and include PLAN_FILE content}

## Your Method

Read the plan looking for anything that doesn't belong in a final, clean document. Check for artifacts of the planning process, verbosity, inconsistencies, and ambiguity.

## Examples of What to Look For (not exhaustive)

- Iteration artifacts: "TODO", "FIXME", "we discussed", "in a previous round", "originally we planned"
- Verbose commentary: paragraphs that could be bullet points, explanations of obvious things
- Inconsistent terminology: same concept called different names in different sections
- Formatting inconsistencies: mixed heading levels, inconsistent list styles
- Hedging language: "maybe", "possibly", "we could consider" — a final plan should be decisive
- Dead content: commented-out sections, crossed-out alternatives, old options that weren't chosen

Use your judgment — if something reads poorly for an implementer picking this up cold, flag it.

## Output

Write findings to {ARTIFACTS_DIR}/round-{CURRENT_ROUND}-editor.md

For each finding:
## Finding N: Title
**Section:** Which plan section
**Issue:** What's wrong with the presentation
**Current:** Quote the problematic text
**Suggested:** The cleaner replacement
**Fix:** Brief description of the edit

Limit: top 7 findings. Under 400 words. Only report hygiene issues — don't flag accuracy or logic.
If nothing found, say so — don't invent issues.
""")
```

**Wait for all 3 agents to complete. Read their output files.**

### Phase 2: Synthesize with Consensus Tracking

**THIS IS YOUR CORE WORK. Do not delegate synthesis.**

Read findings from all 3 agents. For each finding, determine its consensus status:

#### Step 1: Classify Each Finding

For every finding across all 3 agents:

1. **Same-round consensus:** 2+ agents flagged the same issue (same section, same underlying problem) in this round → **auto-apply**
2. **Cross-round consensus:** Check the consensus registry — was this same issue flagged by any agent in a previous round? If yes → **auto-apply**
3. **Single-agent, no prior match:** Add to the consensus registry as a deferred finding for potential cross-round consensus in the next round

#### Step 2: Auto-Apply Consensus Findings

Apply all consensus findings (both same-round and cross-round) immediately using the Edit tool. Log each as "Auto-applied" with the consensus type:

```markdown
- **Finding X:** [title] — Auto-applied (same-round consensus: Verifier + Auditor)
- **Finding Y:** [title] — Auto-applied (cross-round consensus: Round 1 Editor + Round 2 Verifier)
```

#### Step 3: Update Consensus Registry

For single-agent findings that had no consensus match, append them to the deferred pool:

```markdown
| {CURRENT_ROUND} | {agent role} | {finding ID} | {one-line summary} | {plan section} |
```

#### Step 4: Log Round Progress

Append to `$ARTIFACTS_DIR/progress.md`:

```markdown
### Round {CURRENT_ROUND}

- **Findings:** {count} total (Verifier: {n}, Auditor: {n}, Editor: {n})
- **Auto-applied (same-round consensus):** {count}
- **Auto-applied (cross-round consensus):** {count}
- **Deferred to registry:** {count}
- **Registry total:** {cumulative deferred count}
```

### Phase 3: Convergence Check

```
IF any findings were auto-applied this round AND CURRENT_ROUND < MAX_ROUNDS
   -> continue (fixes are unverified — need another round to confirm)
   -> increment CURRENT_ROUND, loop to Phase 1

IF no findings from any agent (clean round)
   -> finalize (proceed to Phase 4)

IF CURRENT_ROUND >= MAX_ROUNDS
   -> force finalize (proceed to Phase 4)
```

**Between rounds:** Include in the next prompt: "Previous round applied these fixes: {list}. Verify they're correct and look for anything missed."

---

## Phase 4: Finalize

### Present Remaining No-Consensus Findings (once)

Read the consensus registry. Any deferred findings that never achieved cross-round consensus are presented to the user in a single batch:

**If no remaining deferred findings:** Skip — report a clean result.

**If deferred findings remain:**

```
AskUserQuestion(
  questions: [{
    question: "All consensus findings applied. {N} single-agent findings never confirmed by another round. Apply any of these?",
    header: "Remaining",
    multiSelect: true,
    options: [
      { label: "Finding X: <title>", description: "Round {R}, {agent}: <section> — <one-line summary>" },
      { label: "Finding Y: <title>", description: "Round {R}, {agent}: <section> — <one-line summary>" }
    ]
  }]
)
```

**If more than 4 remaining items:** Split across multiple `AskUserQuestion` calls.

Apply any user-approved findings using the Edit tool.

### Safety Check and Commit

```bash
git status --short
```

**If ANY deletions (D):** STOP and confirm with user.

```bash
git add "$PLAN_FILE"
git commit -m "docs(plan): plan-team correctness check - {CURRENT_ROUND} rounds

Plan: {PLAN_FILE}
Rounds: {CURRENT_ROUND} (3x Sonnet per round)
Consensus applied: {total auto-applied count}
User-approved: {user-approved count}
Deferred (no consensus): {remaining count}

Co-Authored-By: Claude <noreply@anthropic.com>"
git push
```

### Cleanup

```bash
find "$ARTIFACTS_DIR" -mindepth 1 -delete && rmdir "$ARTIFACTS_DIR" 2>/dev/null || true
```

### Report

```markdown
## Plan Clean: Correctness Check Complete

**Plan:** {PLAN_FILE}
**Rounds:** {CURRENT_ROUND}

### Convergence

Round  Verifier  Auditor  Editor  Total  Applied  Deferred
  1      {n}       {n}     {n}     {n}     {n}       {n}
  2      {n}       {n}     {n}     {n}     {n}       {n}
  3      {n}       {n}     {n}     {n}     {n}       {n}

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

### What Was Checked

- **Accuracy:** File paths, code references, external dependencies verified against codebase
- **Structure:** Logical flow, phase dependencies, internal consistency
- **Hygiene:** Iteration artifacts, verbosity, terminology consistency, formatting

**Plan committed. Ready for implementation.**
```

**Present next step choice with `AskUserQuestion`:**

```
AskUserQuestion(
  questions: [{
    question: "Plan correctness check complete ({CURRENT_ROUND} rounds). What's next?",
    header: "Next step",
    multiSelect: false,
    options: [
      { label: "Beadify (Recommended)", description: "Run /beadify — convert plan to beads with parallel validation" },
      { label: "Implement directly", description: "Start building from the corrected plan" },
      { label: "Done for now", description: "Plan saved — pick up later" }
    ]
  }]
)
```

---

## Remember

- **This is a hygiene pass, not a rewrite** — targeted edits only, preserve the plan's intent
- **Consensus is the gating mechanism** — single-agent findings must be confirmed by recurrence or user approval
- **Cross-round consensus is novel** — deferred findings that recur in later rounds are high-signal
- **One human touchpoint** — remaining no-consensus items presented once at the end, not per-round
- **Sonnets are cost-effective** — accuracy/structure/hygiene checks don't need Opus-level reasoning
- **Findings files survive compaction** — always read from `$ARTIFACTS_DIR`, not memory
- **Consensus registry is compaction recovery** — parse it to know the deferred pool state

---

_Plan team: verify accuracy, audit structure, polish hygiene. Consensus-gated corrections across 1-3 rounds._
