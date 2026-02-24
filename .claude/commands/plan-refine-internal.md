---
description: Multi-agent plan refinement (light/medium/heavy tiers) - no external API
---

**You are the conductor.** Agents provide focused lenses. You synthesize. You apply edits directly. Repeat until convergence.

Competitive framing: agents compete — only evidence-backed findings count. Codebase verification is mandatory.

---

## I/O Contract

|                  |                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------ |
| **Input**        | Approved plan file (from `/plan-init`)                                                     |
| **Output**       | Refined plan (in-place edit), Refinement Log appended                                      |
| **Artifacts**    | Round findings in `$ARTIFACTS_DIR/round-{N}-{role}.md`, consensus registry                 |
| **Verification** | Convergence trend (fewer findings each round), plan committed                              |

## Phase 0: Initialize

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
```

### Identify Plan File

`PLAN_FILE`: Check argument, then `.claude/plans/*.md`, then `PLAN.md` in project root. If none found, STOP: "No plan found. Provide a path or run /plan-init first."

### Select Intensity Tier

Ask user with `AskUserQuestion`:

```
question: "Which refinement intensity?"
header: "Tier"
options:
  - label: "Light"
    description: "3 Sonnet agents (Builder/Breaker/Trimmer), 1-4 rounds — fast sanity check"
  - label: "Medium (Recommended)"
    description: "3 Opus agents (Builder/Breaker/Trimmer), 1-4 rounds — deep review, simple personas"
  - label: "Heavy"
    description: "6 Opus agents (Architect/Adversary/Devil's Advocate/Implementer/Spec Auditor/Simplifier), 3-6 rounds — thorough validation"
```

### Configuration

```
TIER=<user selection>

# Tier-dependent settings:
# Light:  AGENT_MODEL=sonnet, AGENT_COUNT=3, PERSONAS=simple, MIN_ROUNDS=1, MAX_ROUNDS=4
# Medium: AGENT_MODEL=opus,   AGENT_COUNT=3, PERSONAS=simple, MIN_ROUNDS=1, MAX_ROUNDS=4
# Heavy:  AGENT_MODEL=opus,   AGENT_COUNT=6, PERSONAS=heavy,  MIN_ROUNDS=3, MAX_ROUNDS=6

CURRENT_ROUND=1
ARTIFACTS_DIR=/tmp/plan-refine-internal-$(date +%Y%m%d-%H%M%S)
```

```bash
mkdir -p "$ARTIFACTS_DIR"
```

### Initialize Consensus Registry

Create the cross-round tracking file for single-agent findings:

```bash
cat > "$ARTIFACTS_DIR/consensus-registry.md" <<'EOF'
# Consensus Registry

Tracks single-agent findings across rounds. If a finding recurs in a later round, it achieves cross-round consensus and is auto-applied.

## Deferred Findings

<!-- Format: | Round | Agent | Severity | Summary | Section | -->
EOF
```

### Checkpoint Original Plan

```bash
git add "$PLAN_FILE" && git commit -m "docs(plan): checkpoint before plan-refine-internal

Co-Authored-By: Claude <noreply@anthropic.com>" || true
```

### Create Workflow Tasks

```
TaskCreate(subject: "Phase 0: Initialize plan-refine", description: "Identify plan, select tier, checkpoint, create consensus registry", activeForm: "Initializing plan-refine...")
TaskCreate(subject: "Phases 1-4: Refinement loop", description: "Parallel agents per round, synthesize, apply, convergence check. Repeat up to MAX_ROUNDS.", activeForm: "Refining plan...")
TaskCreate(subject: "Phase 5: Finalize", description: "Present no-consensus findings, commit, report", activeForm: "Finalizing refinement...")
```

**TaskUpdate(task: "Phase 0", status: "completed")**

---

## REFINEMENT LOOP: Phases 1-4

### Phase 1: Read Current Plan + Identify Skills

```
PLAN_CONTENT = Read(PLAN_FILE)
```

**Compaction recovery:** If PLAN_CONTENT contains a `## Refinement Log` section, parse the last `### Round N` entry to recover CURRENT_ROUND (set to N+1). Previous rounds' changes are already applied to the plan. Read any existing findings files in `ARTIFACTS_DIR` for context on the most recent round. If `$ARTIFACTS_DIR/consensus-registry.md` exists, read it to recover the deferred findings pool for cross-round consensus detection.

**Skill routing:** Scan plan content for domain keywords. Check `AGENTS.md` > "Available Skills" for relevant skills. Include a line in each subagent prompt: `"Domain skills relevant to this plan: <list>. Read the corresponding skill file when evaluating sections that touch those domains."`

### Phase 2: Parallel Subagent Review

**Spawn all agents simultaneously in a single message.** Light/Medium -> 3 agents (simple personas). Heavy -> 6 agents (heavy personas).

Each agent receives the plan content and this output format:

```
For each issue: ## Issue N: Title | Severity: Critical/High/Medium | Section: X | Evidence: [file paths, line numbers] | Problem: X | Suggestion: X
```

**File output:** Each agent writes its complete findings to `ARTIFACTS_DIR/round-{CURRENT_ROUND}-{role}.md` using the Write tool. Conductor substitutes actual paths when spawning agents.

#### Simple Personas (Light + Medium tiers)

**Agent 1: Builder ({AGENT_MODEL})**

```
First: read AGENTS.md for project context.

You are a practical implementer and spec auditor. Can I build this tomorrow?

Check: steps complete and unambiguous, dependencies correctly ordered, every deliverable owned by exactly one phase, no gaps between what one phase produces and the next requires. Trace what each phase produces vs what the next phase consumes.

You have codebase access. Read referenced files to confirm functions/types exist with claimed signatures. For each issue: quote the plan, show what code actually has, state what's needed.

Limit: top 5 issues. If you have additional Critical/High, add as one-liners. Under 400 words. Skip Low.

Write your complete findings to {ARTIFACTS_DIR}/round-{CURRENT_ROUND}-builder.md using the Write tool.
```

Task(subagent_type: "general-purpose", model: "{AGENT_MODEL}", description: "Builder review")

**Agent 2: Breaker ({AGENT_MODEL})**

```
First: read AGENTS.md for project context.

You are an adversary and architect critic. What breaks?

Check: silent failures (wrong results, no error), race conditions on shared state, missing error paths, wrong abstractions, tight coupling. Show the scenario: given [precondition], when [action], then [bad outcome]. Check: do new fields survive existing read-modify-write cycles?

You have codebase access. Read write paths for shared data structures. Cite specific files and functions. Skip theoretical risks — every finding needs a concrete scenario.

Limit: top 5 issues. If you have additional Critical/High, add as one-liners. Under 400 words. Skip Low.

Write your complete findings to {ARTIFACTS_DIR}/round-{CURRENT_ROUND}-breaker.md using the Write tool.
```

Task(subagent_type: "general-purpose", model: "{AGENT_MODEL}", description: "Breaker review")

**Agent 3: Trimmer ({AGENT_MODEL})**

```
First: read AGENTS.md for project context.

You are a simplifier and devil's advocate. What to cut, and is this the right approach?

Check: what can be deleted without losing core value, what's built for v3 but not needed now, where abstraction adds overhead without reuse, whether a fundamentally simpler approach achieves 90% of the value at 30% of the cost. If a fundamentally simpler approach exists, that's your highest-priority finding.

You have codebase access. Verify claimed constraints are real, not assumed. Your only verbs: remove, defer, inline, collapse. Challenge the approach itself — not just the details.

Limit: top 5 issues. If you have additional Critical/High, add as one-liners. Under 400 words. Skip Low.

Write your complete findings to {ARTIFACTS_DIR}/round-{CURRENT_ROUND}-trimmer.md using the Write tool.
```

Task(subagent_type: "general-purpose", model: "{AGENT_MODEL}", description: "Trimmer review")

#### Heavy Personas (Heavy tier only — spawn these INSTEAD of simple personas)

**Agent 1: Architect (Opus)**

```
First: read AGENTS.md for project context.

You are a systems architect. You compete with 5 other reviewers -- only evidence-grounded findings matter.

Check: structural flaws (wrong abstractions, misplaced responsibilities, tight coupling), data flow integrity (trace 2-3 key flows end-to-end through source files), dependency direction (cycles, upward deps), integration boundaries (clean and minimal?), scale at 10x.

You have codebase access. Read actual source files to verify client/server context, data shapes, import chains. If the plan says "X calls Y", open both files and confirm. For each finding: what you checked, what you found, why it's a problem.

Limit: top 5 issues. Under 400 words. Skip Low.

Write your complete findings to {ARTIFACTS_DIR}/round-{CURRENT_ROUND}-architect.md using the Write tool.
```

Task(subagent_type: "general-purpose", model: "opus", description: "Architect review")

**Agent 2: Adversary (Opus)**

```
First: read AGENTS.md for project context.

You are an adversarial reviewer. Your job is to BREAK this plan. You compete with 5 other reviewers -- only real, demonstrable breaks count.

Check: unstated assumptions (flip each one -- does the plan survive?), silent failures (wrong results, no error), data integrity (all write paths to shared state -- do new fields survive read-modify-write?), race conditions, security (verify auth patterns actually exist).

You have codebase access. Read ALL existing write paths for shared data structures. Verify auth middleware/factories exist. Cite specific files and functions. Show the scenario: given [precondition], when [action], then [bad outcome].

Limit: top 5 issues. Under 400 words. Skip Low.

Write your complete findings to {ARTIFACTS_DIR}/round-{CURRENT_ROUND}-adversary.md using the Write tool.
```

Task(subagent_type: "general-purpose", model: "opus", description: "Adversary review")

**Agent 3: Devil's Advocate (Opus)**

```
First: read AGENTS.md for project context.

You are a Devil's Advocate. Argue AGAINST this plan's fundamental approach -- not details, but core design decisions. Your strongest finding proves a foundational assumption is false.

Check: inversion test (for each major decision, argue the opposite), hidden constraints (are stated constraints actually real?), simpler alternatives (90% value at 30% cost?), assumption mapping (which beliefs are unvalidated?).

You have codebase access. Read referenced plans and actual code to verify claimed constraints are real, not assumed. Be intellectually honest -- if the approach is genuinely best, say so, then find the ONE thing it got wrong.

Limit: top 5 issues. Under 400 words. Skip Low.

Write your complete findings to {ARTIFACTS_DIR}/round-{CURRENT_ROUND}-devils-advocate.md using the Write tool.
```

Task(subagent_type: "general-purpose", model: "opus", description: "Devil's Advocate review")

**Agent 4: Implementer (Opus)**

```
First: read AGENTS.md for project context.

You are implementing this plan tomorrow. You compete with 5 other reviewers -- only implementation-blocking findings count.

Check: blocking ambiguity (steps where you'd guess), hidden complexity (looks like 1 day but is 5), wrong sequencing, missing ownership (each new field/function/route owned by exactly ONE phase), practical shortcuts.

You have codebase access. Read EVERY file the plan references. Verify functions, types, utilities exist with claimed signatures. For each issue: quote the plan's claim, show what the code actually has, state what's needed.

Limit: top 5 issues. Under 400 words. Skip Low.

Write your complete findings to {ARTIFACTS_DIR}/round-{CURRENT_ROUND}-implementer.md using the Write tool.
```

Task(subagent_type: "general-purpose", model: "opus", description: "Implementer review")

**Agent 5: Spec Auditor (Opus)**

```
First: read AGENTS.md for project context.

You are a specification completeness auditor. If you'd need to ask a question to implement it, that's a finding.

Check: gaps (trace each phase's inputs -- does a prior phase produce them?), contradictions (where do two sections disagree?), undefined behavior, phase ownership (every deliverable owned by exactly one phase), self-sufficiency (could someone implement with ONLY this document?).

You have codebase access. For each referenced function, type, or factory -- read the source. Verify it exists, is exported, has the claimed signature.

Limit: top 5 issues. Under 400 words. Skip Low.

Write your complete findings to {ARTIFACTS_DIR}/round-{CURRENT_ROUND}-spec-auditor.md using the Write tool.
```

Task(subagent_type: "general-purpose", model: "opus", description: "Spec Auditor review")

**Agent 6: Simplifier (Opus)**

```
First: read AGENTS.md for project context.

You are a ruthless simplifier. Your only job: find what to CUT. If total complexity budget is 100, where is it being wasted?

Check: remove (delete without losing core value?), defer (built for v3 but not needed now?), inline (abstraction overhead without reuse?), collapse (merge multiple steps/phases?), complexity budget.

DO NOT suggest adding anything. Your only verbs: remove, simplify, defer, inline.

Limit: top 5 issues. Under 400 words. Skip Low.

Write your complete findings to {ARTIFACTS_DIR}/round-{CURRENT_ROUND}-simplifier.md using the Write tool.
```

Task(subagent_type: "general-purpose", model: "opus", description: "Simplifier review")

### Phase 3: Synthesize and Apply

**THIS IS YOUR CORE WORK. Do not delegate synthesis.**

Read findings from files (all agents in parallel):

**Light/Medium:** Read builder, breaker, trimmer findings.
**Heavy:** Read architect, adversary, devils-advocate, implementer, spec-auditor, simplifier findings.

Synthesis principles:

- **Consensus is high-signal** — 2+ agents flagging the same issue is almost certainly real
- **Evidence over opinion** — cite file paths, not vague concerns
- **Simplifier/Trimmer counterbalances** — other agents tend to add; Trimmer/Simplifier cuts
- **Devil's Advocate + Simplifier agreement** (heavy) — strongest signal to cut/change
- **Critical/High first** — skip Medium unless trivial to fix

Produce a numbered change list. For each item: target section, what to change, new content, severity, and which agents flagged it.

### Auto-Apply Rules (DO NOT ask about these)

**Auto-apply a change if ANY condition is met:**

1. **Severity-based:** The issue is Critical or High severity — these are defects, not preferences
2. **Same-round consensus:** 2+ agents independently flagged the same issue (regardless of severity) — multi-agent agreement is high-signal
3. **Cross-round consensus:** A single-agent finding from THIS round matches a deferred finding in the consensus registry from a PREVIOUS round — recurrence across rounds is high-signal

**Apply these immediately using the Edit tool. Log them in the round summary as "Auto-applied" with the consensus type.**

### Defer Remaining Findings (DO NOT ask user per-round)

After auto-applying, any remaining changes (Medium/Low severity AND only flagged by a single agent with no cross-round match) are added to the consensus registry — NOT presented to the user.

For each deferred finding, append to `$ARTIFACTS_DIR/consensus-registry.md`:

```markdown
| {CURRENT_ROUND} | {agent role} | {severity} | {one-line summary} | {plan section} |
```

These deferred findings serve two purposes:
- **Cross-round consensus detection:** If a later round's agent flags the same issue, it auto-applies
- **Final presentation:** Any findings that never achieve consensus are presented to the user once in Phase 5

**After applying edits, append a round summary to the plan file:**

```markdown
<!-- Append to end of PLAN_FILE. Create "## Refinement Log" heading if it doesn't exist. -->

### Round {CURRENT_ROUND} ({TIER}: {PERSONA_NAMES})

- **Changes:** {count} applied ({Critical count} Critical, {High count} High)
- **Key fixes:** {1-2 sentence summary of main changes}
- **Consensus:** {notable agreements or disagreements between agents}
- **Trajectory:** {assessment} -> {continue|finalize}
```

### Phase 4: Convergence Check

**Rule: if this round's agents found ANY Critical or High issues, you MUST run another round after applying fixes.** Fixes are unverified until the next round's agents confirm no new Critical/High issues emerge. Only finalize after a round where all findings are Medium or lower.

```
IF agents found any Critical or High issues -> apply fixes, continue (increment CURRENT_ROUND, loop to Phase 1)
IF 3+ Medium issues across agents -> continue
IF only few Medium or no issues -> finalize (proceed to Phase 5)
IF CURRENT_ROUND >= MAX_ROUNDS -> force finalize (note unverified fixes in Refinement Log)
```

---

## Phase 5: Finalize

### Present Remaining No-Consensus Findings (once)

Read the consensus registry. Any deferred findings that never achieved cross-round consensus are presented to the user in a single batch:

**If no remaining deferred findings:** Skip — just proceed to commit.

**If deferred findings remain:**

```
AskUserQuestion(
  questions: [{
    question: "All consensus findings applied across {CURRENT_ROUND} rounds. {N} single-agent findings never confirmed. Apply any of these?",
    header: "Remaining",
    multiSelect: true,
    options: [
      { label: "Change X: <title>", description: "Round {R}, {severity} — {agent}: {section} — <one-line summary>" },
      { label: "Change Y: <title>", description: "Round {R}, {severity} — {agent}: {section} — <one-line summary>" }
    ]
  }]
)
```

**If more than 4 remaining items:** Split across multiple `AskUserQuestion` calls.

**Apply any user-approved findings using the Edit tool.**

### Safety Check and Commit

```bash
git status --short
# If ANY deletions (D): STOP and confirm with user

git add "$PLAN_FILE"
git commit -m "docs(plan): {TIER} multi-agent refinement - {CURRENT_ROUND} rounds complete

Plan: {PLAN_FILE}
Tier: {TIER} ({AGENT_COUNT}x {AGENT_MODEL})
Rounds: {CURRENT_ROUND}

Co-Authored-By: Claude <noreply@anthropic.com>"
git push
```

### Cleanup

Remove the temp artifacts directory once the commit is done:

```bash
# Remove temp findings from /tmp (safe -- ARTIFACTS_DIR is always under /tmp)
find "$ARTIFACTS_DIR" -mindepth 1 -delete && rmdir "$ARTIFACTS_DIR" 2>/dev/null || true
```

### Summary

```markdown
## Plan Refinement Complete ({TIER})

**Plan:** {PLAN_FILE}
**Tier:** {TIER} ({AGENT_COUNT}x {AGENT_MODEL})
**Rounds:** {CURRENT_ROUND}

### Convergence

Round  Crit  High  Med   Total  Applied  Deferred
  1     {n}   {n}   {n}   {n}     {n}       {n}
  2     {n}   {n}   {n}   {n}     {n}       {n}
  ...

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

### Top Agent Contributions

- **{agent}:** {key finding pattern}
- **{agent}:** {key finding pattern}

**Stop reason:** {severity converged | MAX_ROUNDS | clean round}
```

**Present next step choice with `AskUserQuestion`:**

```
AskUserQuestion(
  questions: [{
    question: "Plan refinement complete ({CURRENT_ROUND} rounds, {TIER} tier). What's next?",
    header: "Next step",
    multiSelect: false,
    options: [
      { label: "Plan clean (Recommended)", description: "Run /plan-clean — final correctness check before beadification" },
      { label: "Beadify directly", description: "Run /beadify — skip correctness check, convert to beads now" },
      { label: "External multi-model refine", description: "Run /plan-refine-external — multiple diverse AI models for deeper review" },
      { label: "Done for now", description: "Plan saved and committed — pick up later" }
    ]
  }]
)
```

---

## Remember

- YOU synthesize and apply edits directly — never delegate synthesis or spawn subagents for edits
- **Auto-apply Critical/High + same-round consensus + cross-round consensus — defer the rest**
- **Cross-round consensus:** single-agent findings that recur in later rounds are high-signal — auto-apply on match
- **One human touchpoint:** remaining no-consensus findings presented once in Phase 5, not per-round
- Trimmer/Simplifier counterbalances other agents — don't let them pile on complexity
- Evidence over opinion — findings need file citations, not speculation
- Findings files + consensus registry in ARTIFACTS_DIR persist through compaction — always read from files, not memory
- Refinement Log in plan file is your compaction recovery — parse it to know where you left off

---

_3-tier plan refinement (light/medium/heavy). For external multi-model: `/plan-refine`._
