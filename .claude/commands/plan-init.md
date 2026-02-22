---
description: Create implementation plans with validation baseline — parallel exploration, measurable success criteria, user-gated approval
---

**You are the orchestrator creating implementation plans.** Three explorers investigate in parallel. You synthesize findings into an actionable plan with test specs. **DO NOT implement code — only plan.**

---

## I/O Contract

|                  |                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| **Input**        | User request (feature, fix, improvement) or backlog item                                             |
| **Output**       | Approved plan in `.claude/plans/YYYY-MM-DD-HHMM-[feature].md`, ready for `/plan-refine-internal`     |
| **Artifacts**    | Research in `.claude/plans/research/`, validation baseline, progress in `$ARTIFACTS_DIR/progress.md` |
| **Verification** | Plan committed to main, success criterion defined, tools verified                                    |

## Prerequisites

- Main directory on `main` branch (plans are documentation, committed to main)
- Dev server runnable (see AGENTS.md > Project Commands > Dev server)

## Phase 0: Initialize

**MANDATORY FIRST STEP: Create task list with TaskCreate BEFORE starting.**

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
```

### Main Branch Enforcement (CRITICAL)

Plans are committed directly to main. The main directory MUST be on main.

```bash
CURRENT_BRANCH=$(git branch --show-current)
echo "Current branch: $CURRENT_BRANCH"
```

**If NOT on main: STOP IMMEDIATELY**

```markdown
**ERROR: Main directory must be on main branch for planning.**

Current branch: [branch]

**Options:**

1. Switch to main: `git checkout main`
2. If work in progress: stash first (`git stash && git checkout main`)
3. If feature branch work needs saving: start a NEW session in main directory
```

STOP and wait for user to fix the state. Do not proceed on a feature branch.

### Configuration

```
ARTIFACTS_DIR=/tmp/plan-init-$(date +%Y%m%d-%H%M%S)
```

```bash
mkdir -p "$ARTIFACTS_DIR"
```

### Create Workflow Tasks

```
TaskCreate(subject: "Phase 0: Initialize and classify", description: "Verify branch, classify request type and complexity", activeForm: "Initializing plan session...")

TaskCreate(subject: "Phase 1: Parallel code exploration", description: "Spawn 3 code-explorer agents: patterns, dependencies, constraints", activeForm: "Exploring codebase...")

TaskCreate(subject: "Phase 2: Validation baseline", description: "Capture current state, verify tools, define success criterion and test specs", activeForm: "Establishing baseline...")

TaskCreate(subject: "Phase 3: Synthesize plan", description: "Combine exploration findings into actionable implementation plan", activeForm: "Creating plan...")

TaskCreate(subject: "Phase 4: Get approval and commit", description: "Present plan for user approval, then commit artifacts to main", activeForm: "Awaiting approval...")
```

### Compaction Recovery

If `$ARTIFACTS_DIR/progress.md` exists, parse its `### Phase N` entries to recover state. If research files already exist in `.claude/plans/research/`, skip to the next incomplete phase.


### Classify the Request

```
User request -> Classify:
├── Type: BUILD | IMPROVE | FIX
└── Complexity: MINIMAL | MORE | A LOT (auto-detect or user-specified)
```

**Complexity Detection:**

- MINIMAL: <3 files, clear pattern, 1-2 hours work
- MORE: 3-10 files, some decisions, 2-4 hours work
- A LOT: >10 files, architectural decisions, 4+ hours work

Append to `$ARTIFACTS_DIR/progress.md`:

```markdown
### Phase 0: Initialize

- **Type:** {BUILD|IMPROVE|FIX}
- **Complexity:** {MINIMAL|MORE|A LOT}
- **Request:** {brief summary}
```

**TaskUpdate(task: "Phase 0", status: "completed")**

---

## Phase 1: Parallel Code Exploration

**TaskUpdate(task: "Phase 1", status: "in_progress")**

### Skill Routing

Before spawning agents, check `AGENTS.md` > "Available Skills" for relevant domain skills. Include relevant skill paths in each agent prompt.

### Spawn 3 Explorers Simultaneously

**CRITICAL: All 3 agents run IN PARALLEL using a single message with 3 Task calls.** Each writes findings to `.claude/plans/research/`. Competitive framing: agents compete — only evidence-backed findings count.

**Explorer 1: Patterns**

```
Task(subagent_type: "general-purpose", model: "haiku", prompt: """
First: Read AGENTS.md for project context and conventions.
{If relevant skills identified: "Read the relevant skill file for domain patterns (see AGENTS.md > Available Skills)."}

You are finding existing patterns for [feature] in this codebase. You compete with 2 other explorers — only evidence-backed findings with file paths count.

## Method

1. Search project source directories (see AGENTS.md > Architecture) for similar components and utilities
2. Read neighboring files to understand established patterns
3. Note naming conventions, file structure, import patterns
4. Identify reusable code (hooks, utils, components) that the new feature should use
5. Check for similar features that were implemented before — what patterns did they follow?

## Output

Write findings to .claude/plans/research/YYYY-MM-DD-HHMM-exploration-patterns-[feature].md

For each pattern found:
## Pattern N: Title
**File(s):** path/to/file:line
**What it does:** {description}
**Relevance:** How the new feature should use this pattern
**Evidence:** Code snippet or reference

Limit: top 7 patterns. Under 500 words. Cite files, not guesses.
""")
```

**Explorer 2: Dependencies**

```
Task(subagent_type: "general-purpose", model: "haiku", prompt: """
First: Read AGENTS.md for project context and conventions.
{If relevant skills identified: "Read the relevant skill file for domain patterns (see AGENTS.md > Available Skills)."}

You are identifying dependencies and APIs needed for [feature]. You compete with 2 other explorers — only evidence-backed findings count.

## Method

1. Check project dependency manifest for relevant libraries already available
2. Search for imports of key libraries used in this project
3. Identify API routes and server actions that exist or need creation
4. Check database schema or data layer for relevant tables/models
5. Note any environment variables or config needed

## Output

Write findings to .claude/plans/research/YYYY-MM-DD-HHMM-exploration-dependencies-[feature].md

For each dependency:
## Dependency N: Title
**Type:** Library | API Route | DB Table | Config | New Requirement
**Current state:** {exists/needs creation/needs modification}
**File(s):** path/to/file:line
**Details:** What's available and what's needed
**Evidence:** Import paths, function signatures, schema definitions

Limit: top 7 dependencies. Under 500 words. Cite files, not guesses.
""")
```

**Explorer 3: Constraints**

```
Task(subagent_type: "general-purpose", model: "haiku", prompt: """
First: Read AGENTS.md for project context and conventions.
{If relevant skills identified: "Read the relevant skill file for domain patterns (see AGENTS.md > Available Skills)."}

You are researching constraints for [feature]. You compete with 2 other explorers — only evidence-backed constraints with file citations count.

## Method

1. Search for validation patterns, error handling, auth checks
2. Check for platform-specific constraints (offline sync, mobile, PWA, etc.)
3. Look at existing test patterns for similar features
4. Check for rate limiting, access policies, security boundaries
5. Identify potential conflicts with existing functionality

## Output

Write findings to .claude/plans/research/YYYY-MM-DD-HHMM-exploration-constraints-[feature].md

For each constraint:
## Constraint N: Title
**Type:** Validation | Auth | Performance | Mobile | Testing | Security
**File(s):** path/to/file:line
**Impact:** How this constrains the implementation
**Evidence:** Code reference showing the constraint

Limit: top 7 constraints. Under 500 words. Cite files, not guesses.
""")
```

**Wait for all 3 agents to complete. Read their output files.**

Append to `$ARTIFACTS_DIR/progress.md`:

```markdown
### Phase 1: Exploration

- **Patterns found:** {count} across {files}
- **Dependencies identified:** {count} ({existing} exist, {new} need creation)
- **Constraints found:** {count}
- **Key finding:** {most important discovery}
```

**TaskUpdate(task: "Phase 1", status: "completed")**

---

## Phase 2: Validation Baseline ("Taste the Tools")

**TaskUpdate(task: "Phase 2", status: "in_progress")**

**Purpose:** Capture current state AND verify you can actually measure success BEFORE planning.

### Step 1: Identify Validation Method

| Task Type   | Primary Validation       | Secondary             |
| ----------- | ------------------------ | --------------------- |
| UI Feature  | Browser automation test  | Screenshot comparison |
| API Change  | Response shape assertion | Integration tests     |
| Bug Fix     | Reproduction script      | Unit tests            |
| Performance | Baseline metrics         | Load tests            |

### Step 2: Capture Current State

**For UI features (ALWAYS capture both):**

```markdown
1. Start dev server (see AGENTS.md > Project Commands > Dev server) if not running
2. Navigate to relevant page using browser automation tool (if available)
3. Take accessibility snapshot (if browser tool available)
   -> Save as: research/YYYY-MM-DD-HHMM-baseline-snapshot-[feature].md
4. Take screenshot (if browser tool available)
   -> Save as: research/YYYY-MM-DD-HHMM-baseline-screenshot-[feature].png
5. Document current state
```

**For API changes:** Hit current endpoint, record response shape, note errors/limitations.

**For bug fixes:** Follow reproduction steps, document broken behavior, confirm you can see the bug.

**Save baseline to:** `.claude/plans/research/YYYY-MM-DD-HHMM-baseline-[feature].md`

### Step 3: "Taste the Tools" (Verify Validation Capability)

```markdown
## Tool Verification Checklist

### Unit/Integration Tests

- [ ] Run project test command (see AGENTS.md > Project Commands > Test)
- [ ] Result: [X passing / Y failing]
- [ ] Status: Can run tests | BLOCKED

### Browser Access (if available)

- [ ] Navigate to: /[relevant-page]
- [ ] Result: [Can access | Cannot access]
- [ ] Status: Can browse | BLOCKED | N/A

### Dev Server

- [ ] Check: dev server running (see AGENTS.md > Project Commands > Dev server)
- [ ] Result: [Running | Not running]
- [ ] Status: Accessible | BLOCKED

### API Endpoints (if applicable)

- [ ] Endpoint: /api/[endpoint]
- [ ] Result: [Response code]
- [ ] Status: Reachable | BLOCKED
```

**IF all tools blocked:** STOP. Present blocker details and recovery procedure. Await user confirmation.

**IF partial tools available:** Present working vs blocked tools. Propose alternative validation. Get user approval before proceeding with adjusted criteria.

### Step 4: Define Success Criterion (Silver Bullet)

```markdown
## Success Criterion (Silver Bullet)

**Type:** [Journey | Screenshot | Test | Output | Metric]

**Definition:**
[What exactly constitutes success - machine-verifiable]

**Validation Command:**
[Exact command to run - e.g., pytest tests/test_feature.py, pnpm test tests/feature.spec.ts]

**Expected Outcome:**
[What passing looks like - e.g., "All 3 assertions pass, journey completes"]
```

### Step 5: Define Test Specifications (Machine-Readable)

**CRITICAL: Tests are designed here, built in implementation phase.** These specs are "hardcoded" in the plan — engineer cannot modify them during implementation.

```yaml
## Test Specifications

test_specs:
  silver_bullet:
    file: '[test-file-path]'
    type: 'Journey' # Journey | Screenshot | API | Performance | Custom
    description: '[What this test verifies]'
    assertions:
      - '[First assertion]'
      - '[Second assertion]'
      - '[Third assertion]'

  supporting_tests:
    - name: '[Test 1 Name]'
      file: '[unit-test-file-path]'
      type: 'Unit'
      description: '[What it verifies]'
      cases:
        - '[happy path]'
        - '[edge case]'
        - '[error case]'

    - name: '[Test 2 Name]'
      file: '[integration-test-file-path]'
      type: 'Integration'
      description: '[What it verifies]'
      cases:
        - '[case 1]'
        - '[case 2]'
```

**Why structured YAML:** Machine-parseable by implementation commands. Tests designed before code prevents "cheating". User reviews specs. Engineer implements to spec, can't modify requirements.

### Step 6: Document Baseline vs Target

```markdown
## Baseline vs Target

| Aspect         | Current State      | Target State        |
| -------------- | ------------------ | ------------------- |
| [Feature area] | [What exists now]  | [What should exist] |
| [Behavior]     | [Current behavior] | [Desired behavior]  |
| [Test status]  | [Current coverage] | [Expected coverage] |
```

Append to `$ARTIFACTS_DIR/progress.md`:

```markdown
### Phase 2: Validation Baseline

- **Tools verified:** {list of working tools}
- **Blocked tools:** {list, or "none"}
- **Success criterion:** {brief description}
- **Tests designed:** 1 Silver Bullet + {X} supporting tests
```

**TaskUpdate(task: "Phase 2", status: "completed")**

---

## Phase 3: Synthesize Findings and Create Plan

**TaskUpdate(task: "Phase 3", status: "in_progress")**

**THIS IS YOUR CORE WORK. Do not delegate synthesis.**

### Review All Research

Read the outputs:

- `.claude/plans/research/*-patterns-*.md`
- `.claude/plans/research/*-dependencies-*.md`
- `.claude/plans/research/*-constraints-*.md`
- `.claude/plans/research/*-baseline-*.md`

### Check for Conflicts/Gaps

- Multiple conflicting patterns found?
- Missing information needing more exploration?
- Unclear requirements needing user input?
- Architectural decisions required?

If any gaps are blocking, use `AskUserQuestion` to clarify before proceeding.

### Create Plan Document

**Create plan file:** `.claude/plans/YYYY-MM-DD-HHMM-[feature-name].md`

### Select Template Based on Complexity

| Complexity  | Criteria                              | Template Sections                                                            |
| ----------- | ------------------------------------- | ---------------------------------------------------------------------------- |
| **MINIMAL** | <3 files, clear pattern, 1-2 hours    | Summary, Success Criterion, Implementation, Validation                       |
| **MORE**    | 3-10 files, some decisions, 2-4 hours | All 7 sections (Context, Outcome, Journey, Spec, Success, Phases, Risks)     |
| **A LOT**   | >10 files, architectural, 4+ hours    | All MORE sections + Decision Log, Alternatives, Phased Rollout, Dependencies |

#### For MINIMAL complexity:

```markdown
# [Feature Name]

## Summary

[1-2 sentences]

**Type:** BUILD | IMPROVE | FIX
**Complexity:** MINIMAL

## Backlog Items (optional)

<!-- Link backlog items this plan addresses, if using a backlog system -->
<!-- e.g., _backlog/XXX-primary-item.md, GitHub issue #123, Jira ticket -->

- (primary item)
- (related, if any)

## Success Criterion

[From Phase 2]

## Test Specifications

[YAML test specs from Phase 2]

## Implementation

1. [Step 1]
2. [Step 2]
3. [Step 3]

## Validation

[How to verify success]
```

#### For MORE complexity:

```markdown
# [Feature Name]

## Summary

[1-2 sentences]

**Type:** BUILD | IMPROVE | FIX
**Complexity:** MORE

## Backlog Items

- `_backlog/XXX-primary-item.md` (primary)
- `_backlog/YYY-related-item.md` (related, if any)

## Context & Research

[Synthesized from 3 exploration reports]

## Outcome Definition

[What success looks like - from Phase 2 baseline]

## User Journey (if UI)

[Flow description]

## Technical Specification

- API contracts
- Data model changes
- Component structure

## Success Criteria

[From Phase 2 - measurable!]

## Test Specifications

[YAML test specs from Phase 2]

## Implementation Phases

### Phase 1: [Foundation]

### Phase 2: [Core Logic]

### Phase 3: [UI/Integration]

### Phase 4: [Testing]

## Risks & Mitigations

[What could go wrong]
```

#### For A LOT complexity:

All sections from MORE, plus:

- Decision log (alternatives considered)
- Phased rollout plan
- Detailed test matrix
- Dependencies/blockers

Append to `$ARTIFACTS_DIR/progress.md`:

```markdown
### Phase 3: Plan Created

- **Plan file:** {path}
- **Complexity:** {MINIMAL|MORE|A LOT}
- **Phases:** {count}
- **Test specs:** 1 Silver Bullet + {X} supporting
```

**TaskUpdate(task: "Phase 3", status: "completed")**

---

## Phase 4: Present for Approval and Commit

**TaskUpdate(task: "Phase 4", status: "in_progress")**

### Ask Questions If Needed

If ambiguities remain, use `AskUserQuestion` to resolve them before presenting.

### Present Plan Summary

```markdown
## Plan Created: [Feature Name]

**Plan:** `.claude/plans/YYYY-MM-DD-HHMM-[feature].md`
**Research:** `.claude/plans/research/` ({N} files)

### Summary

[2-3 sentences describing approach]

### Type & Complexity

- **Type:** BUILD | IMPROVE | FIX
- **Complexity:** MINIMAL | MORE | A LOT

### Validation Baseline

- **Current state captured:** {yes/no}
- **Tools verified:** {list of working tools}
- **Success criterion:** [Brief description]

### Key Decisions

- **Architecture:** [Main choice]
- **Dependencies:** [New libraries, if any]
- **Database:** [Schema changes, if any]

### Test Specs

- **Silver Bullet:** [file + description]
- **Supporting:** [count] tests

---

**Proceed with implementation?**
```

**Present plan for approval with `AskUserQuestion`:**

```
AskUserQuestion(
  questions: [{
    question: "Plan created for [Feature Name]. Approve?",
    header: "Approval",
    multiSelect: false,
    options: [
      { label: "Approve", description: "Plan looks good — commit and proceed to implementation" },
      { label: "Adjust", description: "Needs changes — specify what to revise (will re-present after edits)" },
      { label: "Reject", description: "Wrong approach — discuss concerns and rethink" }
    ]
  }]
)
```

- **Approve** -> Commit and proceed to hand-off
- **Adjust** -> Update plan based on feedback, re-present
- **Reject** -> Discuss concerns, revise approach

### Safety Check (Before Commit)

```bash
git status --short
```

**If ANY deletions (D):** STOP and ask "You're about to delete X files. Is this intentional?" Wait for confirmation.

### Commit Plan Artifacts

**Plans are low-risk documentation — commit directly to main.**

```bash
git add .claude/plans/research/*.md
git add .claude/plans/YYYY-MM-DD-HHMM-[feature].md
git commit -m "$(cat <<'EOF'
docs(plan): [feature-name] - approved implementation plan

Research: patterns, dependencies, constraints
Baseline: current state captured, tools verified
Success criterion: [brief description]
Tests designed: 1 Silver Bullet + [X] supporting tests

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
git push
```

### Update Plan Status

Add to plan document:

```markdown
---
**Status:** Approved - Ready for Implementation
**Approved:** YYYY-MM-DD
---
```

### Report Completion and Hand-Off

```markdown
## Plan Complete: [Feature Name]

**Plan:** `.claude/plans/YYYY-MM-DD-HHMM-[feature].md`
**Status:** Approved & Committed

### Ready for Implementation

| Complexity | Recommended Next Step                                            |
| ---------- | ---------------------------------------------------------------- |
| MINIMAL    | `/bead-work` directly (if beads exist) or implement from plan    |
| MORE       | `/plan-refine-internal` -> `/beadify` -> `/bead-work`            |
| A LOT      | `/plan-refine-internal` or `/plan-refine-external` -> `/beadify` |

**Flywheel commands:**

- `/plan-refine-internal` - Multi-agent plan refinement (light/medium/heavy tiers)
- `/plan-refine-external` - Multi-model refinement via OpenRouter (multiple external models)
- `/beadify` - Convert plan to beads with parallel validation
- `/bead-refine` - Refine bead structure (severity-based convergence)
- `/bead-work` - Sequential implementation (conductor + engineer sub-agents)

**Key context:**

- Plan: `.claude/plans/YYYY-MM-DD-HHMM-[feature].md`
- Success criterion: [from plan]
- Watch out for: [one key constraint or pattern discovered]

**Plan committed. Ready for next step.**
```

**Present next step choice with `AskUserQuestion`:**

```
AskUserQuestion(
  questions: [{
    question: "Plan approved and committed. What's next?",
    header: "Next step",
    multiSelect: false,
    options: [
      { label: "Refine plan (Recommended)", description: "Run /plan-refine-internal — multi-agent refinement before beadification" },
      { label: "Beadify directly", description: "Run /beadify — convert plan to beads (skip refinement for simple plans)" },
      { label: "External multi-model refine", description: "Run /plan-refine-external — multiple diverse AI models for critical decisions" },
      { label: "Done for now", description: "Plan saved — pick up implementation later" }
    ]
  }]
)
```

**TaskUpdate(task: "Phase 4", status: "completed")**

---

## Flexibility & Overrides

### User Can Adjust Process

**"Just do a quick plan"**
-> Skip parallel exploration, use single-pass analysis

**"Focus on [specific aspect]"**
-> Emphasize that area in plan

**"Skip validation baseline"**
-> Proceed without tool verification (risky but fast)

**Trust the user's judgment on when to follow/skip steps.**

---

## Remember

- **YOU synthesize findings and create the plan** — explorers find patterns, you decide what matters
- **Planning is thinking, not doing** — do NOT write implementation code
- **Competitive framing sharpens exploration** — agents cite files, not guesses
- **Tests are designed in plan, built in implementation** — specs are hardcoded
- **Artifacts survive compaction** — always read from files, not memory
- **Progress file is compaction recovery** — parse it to know where you left off
- **Plans commit to main** — low-risk documentation, always pushed
- **WAIT for approval** — never proceed without the user's explicit approval

---

_Plan init: classify, explore, baseline, synthesize, approve. For refinement: `/plan-refine-internal`. For beadification: `/beadify`._
