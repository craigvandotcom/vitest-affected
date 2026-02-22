---
description: Refine bead structure before implementation — iterative rounds until severity-based convergence
---

**You are the conductor.** Three reviewers hunt independently. You synthesize, apply fixes, and iterate. Competitive framing: agents compete — only evidence-backed findings count.

---

## I/O Contract

|                  |                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| **Input**        | Beads created via `/beadify`                                                         |
| **Output**       | Refined beads ready for `/bead-work`                                                 |
| **Artifacts**    | Round findings in `$ARTIFACTS_DIR/round-{N}-{role}.md`, progress in `$ARTIFACTS_DIR/progress.md` |
| **Verification** | `br list --json`, `br dep cycles`, `br lint`, `br ready --json`                                  |

## Prerequisites

- Beads created via `/beadify`
- beads_rust (`br`) and beads_viewer (`bv`) installed — verify with `which br && which bv`

## Phase 0: Initialize

**MANDATORY FIRST STEP: Create task list with TaskCreate BEFORE starting.**

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
```

### Configuration

```
CURRENT_ROUND=1
MAX_ROUNDS=5
ARTIFACTS_DIR=/tmp/bead-refine-$(date +%Y%m%d-%H%M%S)
```

```bash
mkdir -p "$ARTIFACTS_DIR"
```

### Compaction Recovery

If `$ARTIFACTS_DIR/progress.md` exists, parse the last `### Round N` entry to recover `CURRENT_ROUND` (set to N+1). Previous rounds' changes are already applied to beads. Read any existing findings files in `$ARTIFACTS_DIR` for context on the most recent round.

### Identify Plan File + Skills

Locate the original plan file (check `.claude/plans/*.md`, ask user if unclear). This is needed for cross-referencing during review.

**Skill routing:** Read the beads (`br list --json`) and scan for domain keywords. Check `AGENTS.md` > "Available Skills" for relevant skills. Include skill paths in agent prompts.

### Gather Bead Snapshot

```bash
# Current bead state
br list --json > "$ARTIFACTS_DIR/beads-snapshot.json"

# Dependency health
br dep cycles

# Full bead details for agent context
for id in $(br list --json | jq -r '.[].id'); do
    echo "=== Bead $id ==="
    br show "$id"
    br comments "$id"
    echo ""
done > "$ARTIFACTS_DIR/beads-full-dump.txt"
```

### Create Workflow Tasks

```
TaskCreate(subject: "Phase 0: Initialize bead-refine session", description: "Identify plan file, gather bead snapshot, create tasks", activeForm: "Initializing bead-refine...")

TaskCreate(subject: "Phase 1-4: Refinement loop", description: "Parallel agent review -> synthesize -> apply fixes -> convergence check. Repeat up to MAX_ROUNDS.", activeForm: "Refining beads...")

TaskCreate(subject: "Phase 5: Finalize and verify", description: "Final verification, commit, present summary", activeForm: "Finalizing refinement...")
```


**TaskUpdate(task: "Phase 0", status: "completed")**

---

## REFINEMENT LOOP: Phases 1-4

**TaskUpdate(task: "Phase 1-4: Refinement loop", status: "in_progress", description: "Round {CURRENT_ROUND}/{MAX_ROUNDS}")**

### Phase 1: Spawn 3 Reviewers (parallel)

**All 3 agents in a single message for parallel execution.** Each agent writes findings to `$ARTIFACTS_DIR/round-{CURRENT_ROUND}-{role}.md`.

**Agent 1: Completeness Reviewer**

```
Task(subagent_type: "general-purpose", model: "sonnet", prompt: """
First: read AGENTS.md for project context, coding standards, and conventions.
{If relevant skills identified: "Read the relevant skill file for domain patterns (see AGENTS.md > Available Skills)."}

You are a completeness auditor. You compete with 2 other reviewers — only evidence-backed findings count.

## Your Task

Cross-reference every bead against the original plan to ensure NOTHING was lost or oversimplified during beadification.

## Method

1. Read the original plan file: {PLAN_FILE}
2. Read ALL beads: {paste ARTIFACTS_DIR/beads-full-dump.txt or inline}
3. For each plan section/feature:
   - Is it fully represented in at least one bead?
   - Were any details lost, simplified, or omitted?
   - Are test requirements from the plan captured in bead acceptance criteria?
4. For each bead:
   - Is it self-contained? Could an engineer implement without reading the plan?
   - Are acceptance criteria specific and verifiable (not vague)?
   - Does it include test requirements?

## Output

Write findings to {ARTIFACTS_DIR}/round-{CURRENT_ROUND}-completeness.md

For each issue:
## Issue N: Title
**Severity:** Critical | High | Medium
**Bead:** <id> (or "Missing bead")
**Evidence:** What the plan says vs what the bead says (or doesn't)
**Fix:** Specific change — new bead, updated description, added acceptance criteria

Limit: top 5 issues. If additional Critical/High, add as one-liners. Under 500 words. Skip Low.
""")
```

**Agent 2: Implementability Reviewer**

```
Task(subagent_type: "general-purpose", model: "sonnet", prompt: """
First: read AGENTS.md for project context, coding standards, and conventions.
{If relevant skills identified: "Read the relevant skill file for domain patterns (see AGENTS.md > Available Skills)."}

You are an implementer auditing these beads. You compete with 2 other reviewers — only implementation-blocking findings count.

## Your Task

Can an engineer cold-start on each bead tomorrow and implement it mechanically? If you'd need to ask a question, that's a finding.

## Method

1. Read ALL beads: {paste ARTIFACTS_DIR/beads-full-dump.txt or inline}
2. For each bead, check:
   - Is the scope clear and bounded? (no ambiguous "handle all edge cases")
   - Are dependencies correct? Does this bead actually need what it depends on?
   - Is granularity right? (Too big = needs splitting. Too small = merge candidate.)
   - Are there blocking ambiguities where you'd have to guess?
   - Could you write RED tests from just the acceptance criteria?
3. You have codebase access. Read referenced files to verify:
   - Functions/types mentioned in beads actually exist
   - File paths referenced are correct
   - Patterns described match actual codebase patterns

## Output

Write findings to {ARTIFACTS_DIR}/round-{CURRENT_ROUND}-implementability.md

For each issue:
## Issue N: Title
**Severity:** Critical | High | Medium
**Bead:** <id>
**Evidence:** What's ambiguous/wrong/missing, with codebase citations
**Fix:** Specific change — clearer spec, split proposal, dependency fix

Limit: top 5 issues. If additional Critical/High, add as one-liners. Under 500 words. Skip Low.
""")
```

**Agent 3: Structure Optimizer**

```
Task(subagent_type: "general-purpose", model: "sonnet", prompt: """
First: read AGENTS.md for project context, coding standards, and conventions.

You are a dependency graph and structure optimizer. You compete with 2 other reviewers — only structural improvements backed by evidence count.

## Your Task

Optimize the bead dependency graph, ordering, and granularity. Your only verbs: split, merge, reorder, add dep, remove dep.

## Method

1. Read ALL beads: {paste ARTIFACTS_DIR/beads-full-dump.txt or inline}
2. Check dependency graph:
   - Run `br dep cycles` mentally — any cycles?
   - Are there missing dependencies? (Bead A needs code from Bead B but no dep link)
   - Are there unnecessary dependencies? (Bead A depends on B but doesn't actually need it)
   - Is the critical path optimal? Could reordering unblock more parallel work?
3. Check granularity:
   - Beads that touch >5 files or span multiple concerns -> split candidate
   - Beads that are trivial (<30 min) with no dependents -> merge candidate
   - Beads that mix backend + frontend -> split candidate
4. Check priority assignments:
   - P0 beads should be on the critical path
   - P2 beads should genuinely be deferrable

## Output

Write findings to {ARTIFACTS_DIR}/round-{CURRENT_ROUND}-structure.md

For each issue:
## Issue N: Title
**Severity:** Critical | High | Medium
**Bead(s):** <id(s)>
**Evidence:** Current structure, what's wrong, why it matters
**Fix:** Specific structural change — split into X+Y, merge A+B, add/remove dep

Limit: top 5 issues. If additional Critical/High, add as one-liners. Under 500 words. Skip Low.
""")
```

### Phase 2: Synthesize and Apply

**THIS IS YOUR CORE WORK. Do not delegate synthesis.**

Read all 3 findings files from `$ARTIFACTS_DIR`.

Synthesis principles:

- **Consensus is high-signal** — 2+ agents flagging the same bead is almost certainly real
- **Evidence over opinion** — findings need bead IDs and specific content citations
- **Structure Optimizer counterbalances** — Completeness wants to add, Structure wants to simplify
- **Critical/High first** — skip Medium unless trivial to fix

Produce a numbered change list. For each item: target bead(s), what to change, the fix.

**Auto-apply without asking. No user approval needed — the convergence loop self-corrects.**

- **Critical/High:** Apply immediately — these are defects, regardless of how many agents flagged it
- **Medium/Low + consensus (2+ agents):** Apply immediately — multi-agent agreement is high-signal
- **Medium/Low + single-agent:** Skip — not enough confidence. Log as "Skipped (single-agent)" in round summary. If it's real, another agent will independently flag it next round.

**Log all applied and skipped changes in the round summary.**

**Apply approved changes using `br` commands:**

```bash
# Update bead description/spec
br update <id> --description "Revised spec..."

# Add context, reasoning, edge cases as comments
br comments add <id> "Acceptance criteria update: ..."

# Fix dependency structure
br dep add <child-id> <depends-on-id>
br dep remove <child-id> <depends-on-id>

# Adjust priority or labels
br update <id> --priority P0
br label add <id> "new-label"

# Split a bead that's too large
br create "Split: first half" --parent <epic-id> --priority P0 --description "..."
br create "Split: second half" --parent <epic-id> --priority P0 --description "..."
br dep add <second-half-id> <first-half-id>
br close <original-id>
```

### Phase 3: Round Reporting

Append to `$ARTIFACTS_DIR/progress.md`:

```markdown
### Round {CURRENT_ROUND}

- **Findings:** {count} total ({Critical} Critical, {High} High, {Medium} Medium)
- **Changes applied:** {count} ({list bead IDs + brief change description})
- **Dependencies added/removed:** {count}
- **Structural changes:** {splits, new beads, merges — or "none"}
- **Consensus areas:** {where agents agreed}
- **Trajectory:** {assessment} -> {continue|finalize}
```

### Phase 4: Convergence Check

**Rule: if this round's agents found ANY Critical or High issues, you MUST run another round after applying fixes.** Fixes are unverified until the next round's agents confirm no new Critical/High issues emerge. Only finalize after a round where all findings are Medium or lower.

```
IF agents found any Critical or High issues -> apply fixes, continue (increment CURRENT_ROUND)
IF 3+ Medium issues across agents -> continue
IF only few Medium or no issues -> finalize (proceed to Phase 5)
IF CURRENT_ROUND >= MAX_ROUNDS -> force finalize (note unverified fixes in progress.md)
```

**Between rounds:** Include in next prompt: "Previous round findings are in {ARTIFACTS_DIR}/round-{N-1}-\*.md. Focus on areas NOT covered in previous rounds, plus verify previous fixes landed correctly."

**Loop back to Phase 1.**

---

## Phase 5: Finalize

**TaskUpdate(task: "Phase 1-4: Refinement loop", status: "completed")**
**TaskUpdate(task: "Phase 5: Finalize", status: "in_progress")**

### Verify Final Structure

```bash
br list --json
br dep cycles    # Must return clean
br lint          # Check for missing sections
br ready --json  # Show what's ready to implement
bv               # Visual TUI overview
```

### Quality Checklist

Verify:

- [ ] Beads are self-contained (no need to consult original plan)
- [ ] Dependencies correctly mapped (`br dep cycles` returns clean)
- [ ] Tasks appropriately granular for mechanical implementation
- [ ] Test requirements included in each bead
- [ ] Comments explain reasoning/justification
- [ ] Acceptance criteria are clear and verifiable

### Report

```markdown
## Bead Refinement Complete

**Rounds completed:** {CURRENT_ROUND}
**Findings total:** {sum across rounds}
**Changes applied:** {sum across rounds}
**Stop reason:** {severity converged | MAX_ROUNDS | user decision}

### Agent Contributions

- **Completeness:** {key findings pattern}
- **Implementability:** {key findings pattern}
- **Structure:** {key findings pattern}

### Bead Status

- Ready to implement: {count} (`br ready --json`)
- Total beads: {count}
- Blocked: {count}

### Next Steps

1. **Implement** -> `/bead-work`
2. **Further refine** -> Run again with updated beads
3. **Review beads** -> `bv` for visual overview
```

**Present next step choice with `AskUserQuestion`:**

```
AskUserQuestion(
  questions: [{
    question: "Bead refinement complete. What's next?",
    header: "Next step",
    multiSelect: false,
    options: [
      { label: "Implement (Recommended)", description: "Run /bead-work — sequential implementation with conductor + engineer sub-agents" },
      { label: "Further refine", description: "Run /bead-refine again — another round of 3 parallel reviewers" },
      { label: "Review visually", description: "Open bv TUI for manual inspection before deciding" }
    ]
  }]
)
```

**TaskUpdate(task: "Phase 5: Finalize", status: "completed")**

---

## Jeffrey's Standard

> "The beads should be so detailed that we never need to consult back to the original markdown plan document."

---

## Remember

- **YOU synthesize and apply fixes** — agents find issues, you decide and fix
- **Competitive framing sharpens output** — agents know they compete for relevance
- **Structure Optimizer counterbalances** — prevents completeness reviewer from piling on complexity
- **Findings files survive compaction** — always read from `$ARTIFACTS_DIR`, not memory
- **Progress file is compaction recovery** — parse it to know where you left off
- **3 agents per round > 1 pass repeated** — more perspectives, faster convergence
- **Evidence over opinion** — bead IDs and content citations, not vague concerns

---

_Bead refine: parallel agents iterate until severity-converged. For implementation: `/bead-work`. For landing: `/bead-land`._
