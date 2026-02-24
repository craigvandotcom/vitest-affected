---
description: Sequential bead implementation — conductor reviews, engineers implement, one bead at a time
---

**You are the conductor.** Engineers implement. You review, verify, and commit. One bead at a time. Quality over velocity.

For parallelism, open multiple terminal sessions — each runs `/bead-work` independently.

---

## I/O Contract

|                  |                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------ |
| **Input**        | Unblocked beads (from `/bead-refine` or `/beadify`)                                       |
| **Output**       | Implemented code, committed per bead, pushed to wave branch                                |
| **Artifacts**    | Per-bead results in `/tmp/bead-work/bead-{id}-result.md`, progress in `/tmp/bead-work/progress.md` |
| **Verification** | Per-bead quality gate (test, lint, type-check), beads closed in `br`                       |

## Phase 0: Initialize

**MANDATORY FIRST STEP: Create task list with TaskCreate BEFORE starting (after asking user for bead count).**

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
```

### Verify Beads Exist

```bash
br ready --json
```

If no unblocked beads, STOP: "No unblocked beads. Run `/bead-refine` first, or check `br list --json` for blocked items."

### Ensure Wave Branch

Check if a `wave/` branch exists for this work:

```bash
git branch --list 'wave/*'
```

- **No wave branch exists:** Ask user for a wave name, then create it:
  ```bash
  git checkout -b wave/<feature-name>
  ```
- **One wave branch exists:** Switch to it if not already on it:
  ```bash
  git checkout wave/<feature-name>
  git pull --rebase
  ```
- **Multiple wave branches:** Ask user which to join via `AskUserQuestion`.

All parallel sessions join the same wave branch. Trunk-based — merge to main when wave is complete.

### Ask User

Ask two questions via `AskUserQuestion`:

1. "How many beads to target this session?" (default: all unblocked)
2. "Session mode?" → **Solo** (single terminal, default) or **Parallel** (multiple terminals)

### Configuration

```
TARGET_BEADS=<user input>
BEADS_COMPLETED=0
SESSION_MODE=<solo|parallel>
ARTIFACTS_DIR=/tmp/bead-work
```

```bash
mkdir -p "$ARTIFACTS_DIR"
```

### Create Workflow Tasks

**Create session config task + one task per target bead + final task.** The session config task encodes mode and bead count so they survive context compaction. Bead tasks use "X of N" numbering to make the stop condition explicit.

```
# Session config — always completed, serves as compaction-resilient state
TaskCreate(subject: "Session config: {SESSION_MODE} | {TARGET_BEADS} beads", description: "SESSION_MODE={SESSION_MODE}. TARGET_BEADS={TARGET_BEADS}. Stop after {TARGET_BEADS} beads.", activeForm: "Configuring session...")
TaskUpdate(task: "Session config", status: "completed")

TaskCreate(subject: "Phase 0: Initialize bead-work session", description: "Verify beads, ensure wave branch, create tasks", activeForm: "Initializing session...")

# "X of N" naming — makes the boundary crystal clear even after compaction
for i in 1..TARGET_BEADS:
    TaskCreate(subject: "Bead {i} of {TARGET_BEADS}", description: "Select next bead via bv --robot-next, implement with TDD, review, commit. Bead ID assigned when selected.", activeForm: "Implementing bead {i} of {TARGET_BEADS}...")

TaskCreate(subject: "FINAL: Session summary + quality gate ({TARGET_BEADS} beads total)", description: "Full quality gate (format, lint, type-check, test, build), report results, hand off to bead-land. Do NOT implement more beads after this.", activeForm: "Running final quality gate...")
```

**As each bead is selected in Phase 1a, update the corresponding task:**

```
TaskUpdate(task: "Bead {N} of {TARGET_BEADS}", subject: "Bead {N} of {TARGET_BEADS}: <actual-bead-id> - <bead-title>", status: "in_progress", description: "Implementing bead <id>: <title>", activeForm: "Implementing <bead-title>...")
```

**TaskUpdate(task: "Phase 0", status: "completed")**

### Compaction Recovery

If `$ARTIFACTS_DIR/progress.md` exists, parse its header to recover `TARGET_BEADS` and `SESSION_MODE`. Count entries marked `COMPLETE` to recover `BEADS_COMPLETED`. Skip completed beads.


Acknowledge any pending messages.

---

## BEAD LOOP: Phases 1a–1f

### Phase 1a: Select Bead

```bash
bv --robot-next
```

This returns the top pick AND a claim command. **Run the claim command from the output** — do not use `br start` (it doesn't exist).

Then read bead details:

```bash
br show <id>
br comments <id>
```

**Update the corresponding bead task with the actual bead ID and title:**

```
TaskUpdate(task: "Bead {BEADS_COMPLETED + 1} of {TARGET_BEADS}", subject: "Bead {BEADS_COMPLETED + 1} of {TARGET_BEADS}: <bead-id> - <bead-title>", status: "in_progress", activeForm: "Implementing <bead-title>...")
```

### Phase 1b: Identify Skills + Spawn Engineer Sub-Agent

**Skill routing (conductor's job):** Read the bead spec and identify relevant domain skills from `AGENTS.md` > "Available Skills". Include the relevant skill paths in the engineer prompt below.

Give the engineer the bead's full spec (self-contained — no plan reference needed):

```
Task(subagent_type: "general-purpose", model: "sonnet", prompt: """
You are an implementation engineer. Your job: implement one bead with strict TDD, following project conventions exactly.

Read AGENTS.md first for project context, coding standards, and conventions.
{If relevant skills identified: "Read the relevant skill file for domain patterns (see AGENTS.md > Available Skills)."}

## Your Task

Implement this bead using strict TDD (RED → GREEN).

### TDD Flow

1. **Write tests FIRST** — based on the bead spec's acceptance criteria
2. **Run tests — confirm RED** (tests fail because code doesn't exist yet)
3. **Implement the code** — minimal code to make tests pass
4. **Run tests — confirm GREEN** (all tests pass)
5. **Only modify tests if you're certain there's a bug in the test itself** — not to make failing tests pass

### Bead Spec

<paste full br show + br comments output here>

### Requirements

- Follow existing code patterns (read neighboring files first)
- Follow domain skill guidelines (loaded above)
- Follow project type discipline (see AGENTS.md > Rules)
- Run ALL project quality checks before finishing (see AGENTS.md > Project Commands > Quality gate)

### Output

MANDATORY: Write your implementation report to $ARTIFACTS_DIR/bead-<id>-result.md BEFORE reporting done. This is the primary artifact for retrospective analysis. Do NOT skip this step.
- Files created/modified (with paths)
- Test files created/modified (with paths) — list EVERY new test
- Verification results (quality checks — all must pass)
- Any decisions made or assumptions
- Any issues encountered
""")
```

### Phase 1c: Review Quality (Conductor's Core Job)

**YOU are the quality gate.** Read the engineer's result file and verify:

1. **Run bead-relevant tests** (not full suite — just what this bead touches):

   ```bash
   # Run project test command scoped to relevant test files
   # See AGENTS.md > Project Commands > Test
   ```

2. **Lint + type-check** — catch errors early:

   ```bash
   # Run project lint and type-check commands
   # See AGENTS.md > Project Commands > Lint, Type-check
   ```

   (Full build deferred to session-end quality gate — too slow per-bead.)

3. **Test coverage verification** — confirm the engineer actually wrote new tests:
   - Read the engineer's result file for "Test files created/modified"
   - If the bead adds new functionality (modules, handlers, utilities, etc.) there MUST be new test files or new test cases
   - If the engineer's report lists zero new tests for new code, **re-spawn the engineer** with explicit instructions to add test coverage
   - Pure refactors or config changes may not need new tests — use judgment

4. **Acceptance criteria check** — does the implementation match the bead's spec? Tests passing is necessary but not sufficient.

5. **Fresh-eyes diff scan:**

   ```bash
   git diff --stat
   git diff
   ```

UI validation is deferred to `/bead-land` where it runs once for the entire session with pre-authenticated browser state. This saves ~N browser-tester agent spawns (one per bead) without reducing coverage.

**If minor issues:** Fix them directly. You are the conductor — small fixes are faster than re-spawning.

**If major issues:** Re-spawn an engineer sub-agent for the same bead with specific feedback on what's wrong or incomplete. Include the previous result file for context. Repeat until satisfied.

**Be extremely strict.** Do not move to the next bead until this one is fully complete.

### Phase 1d: Commit + Close Bead

```bash
git add <specific files>
git commit -m "feat(<scope>): <bead title>

Bead: <id>
Co-Authored-By: Claude <noreply@anthropic.com>"
git push
```

Push after every bead commit prevents stranded work if the session crashes before bead-land.

Close the bead:

```bash
br close <id> --reason "Implemented and tested"
```

### Phase 1e: Update Progress

**Mark bead task as completed:**

```
TaskUpdate(task: "Bead {BEADS_COMPLETED + 1} of {TARGET_BEADS}", status: "completed")
```

Append to `$ARTIFACTS_DIR/progress.md` (include header on first write):

```markdown
<!-- Header (first bead only) -->

TARGET_BEADS={TARGET_BEADS}
SESSION_MODE={SESSION_MODE}

### Bead <id>: <title>

- Status: COMPLETE
- Commit: <hash>
- Files: <list of modified files>
```

Increment `BEADS_COMPLETED`.

**Loop control:**

- If `BEADS_COMPLETED >= TARGET_BEADS` → exit loop
- If no more unblocked beads (`br ready --json` returns empty) → exit loop
- Otherwise → loop back to Phase 1a

---

## Phase Final: Session Summary

**TaskUpdate(task: "FINAL: Session summary + quality gate ({TARGET_BEADS} beads total)", status: "in_progress")**

### Report

Output summary:

- Beads completed (count + list with IDs)
- Beads remaining (`br ready --json`)
- Any issues encountered

### Full Quality Gate

Run the complete suite (this is where the full run happens):

```bash
# Run full project quality gate (see AGENTS.md > Project Commands > Quality gate)
```

If any fail, fix the issues before proceeding.

### Next Steps

**Always run `/bead-land` next.** It handles:

- Clean git push
- Retrospective learning from this session
- System upgrades (user-gated) that make the next session better

This is what makes the flywheel accelerate — don't skip it.

**Present next step with `AskUserQuestion`:**

```
AskUserQuestion(
  questions: [{
    question: "Bead-work session complete ({BEADS_COMPLETED} beads). What's next?",
    header: "Next step",
    multiSelect: false,
    options: [
      { label: "Land session (Recommended)", description: "Run /bead-land — push, retrospective, system upgrades. Don't skip this." },
      { label: "Continue implementing", description: "Run /bead-work again for more beads (land later)" },
      { label: "Done for now", description: "Stop here — remember to run /bead-land before closing" }
    ]
  }]
)
```

**TaskUpdate(task: "FINAL: Session summary + quality gate ({TARGET_BEADS} beads total)", status: "completed")**

---

## Multi-Session Parallelism

```
Terminal 1: /bead-work   → "target 5 beads"
Terminal 2: /bead-work   → "target 5 beads"

Each session independently:
- bv --robot-next picks best available bead (no pre-assigned ranges)
- Sessions may work on interleaved bead numbers — that's fine
```

---

## Remember

- **YOU review, YOU commit** — engineers implement, you verify
- **Be extremely strict** — bead must be fully complete before moving on
- **Minor fixes: do them yourself. Major gaps: re-spawn engineer.**
- **Temp files survive compaction** — read from `$ARTIFACTS_DIR`, not memory
- **Progress file is compaction recovery** — parse it on restart for TARGET_BEADS + SESSION_MODE
- **Per-bead: tests + type-check + lint. Full quality gate at session end.**
- **UI validation runs once at session end** (in bead-land) — not per-bead
- **No new code without new tests** — verify engineer wrote tests before approving
- **"Bead X of N" task naming prevents drift** — the task list IS the stop condition

---

_Bead work: sequential implementation with quality gates. For planning: `/bead-refine`. For landing: `/bead-land`._
