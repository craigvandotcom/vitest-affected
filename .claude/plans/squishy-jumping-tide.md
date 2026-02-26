# Plan: Create `prompt-enhance` Command

## Context

We've completed a deep analysis of:
1. **Our 15 agent-compounds commands** — every subagent prompt extracted and categorized
2. **Jeffrey Emanuel's BCA commands** — 30+ commands with distinctive patterns
3. **Jeffrey's recent public posts** — "fresh eyes" loop, "overprompting trap" thesis, intent-over-specification
4. **Our flywheel/CORE skill** — delegation rules, model selection, progressive disclosure

The synthesis reveals our prompts are strong on structure (competitive framing, consensus, convergence) but have gaps in intent clarity, persona authority, and anti-bloat guards. A `prompt-enhance` command will codify these learnings and let us systematically improve all subagent prompts.

---

## What `prompt-enhance` Does

**Input:** A command file (or all commands in a directory)
**Output:** Enhanced subagent prompts scored against a pattern library, with fixes applied

**NOT a subagent command itself** — this is a conductor command where the main agent:
1. Extracts all `Task(` prompt blocks from target file(s)
2. Scores each prompt against a pattern rubric
3. Presents findings grouped by severity
4. Applies approved enhancements

---

## Pattern Rubric (The Scoring Engine)

### Tier 1: Structural Patterns (Must-Have)

| # | Pattern | What to Check | Score |
|---|---------|--------------|-------|
| S1 | **Context Loading** | Starts with "First: read AGENTS.md" or equivalent project context file | PASS/FAIL |
| S2 | **Persona + Authority** | "You are X" followed by what agent CAN decide vs must escalate | PASS/WEAK/FAIL |
| S3 | **Task Statement** | Clear "Your task:" or "Your job:" single-sentence intent | PASS/FAIL |
| S4 | **Evidence Requirement** | "Only evidence-backed findings count" or equivalent citation mandate | PASS/FAIL |
| S5 | **Output Format** | Standardized structure (## Finding N: Title, Severity, File, Evidence, Fix) | PASS/WEAK/FAIL |
| S6 | **Output Limits** | Explicit "Limit: top N findings, <M words" constraint | PASS/FAIL |
| S7 | **Output Location** | Specific file path for findings (e.g., `{ARTIFACTS_DIR}/round-{N}-role.md`) | PASS/FAIL |
| S8 | **Honesty Gate** | "If nothing found: say so, don't invent" or equivalent | PASS/FAIL |

### Tier 2: Quality Enhancers (Should-Have)

| # | Pattern | What to Check | Score |
|---|---------|--------------|-------|
| Q1 | **Competitive Framing** | "You compete with N others" (multi-agent only, skip for single-agent) | PASS/N-A/FAIL |
| Q2 | **Scope Constraint** | "Your only verbs: X, Y, Z" or equivalent boundary | PASS/FAIL |
| Q3 | **Reconstruction** | Findings include Fix field — critique must propose solution | PASS/FAIL |
| Q4 | **Scenario Format** | For adversarial/breaker agents: "given [X], when [Y], then [Z]" | PASS/N-A/FAIL |
| Q5 | **Severity Filter** | "Skip Low" or equivalent noise filter | PASS/FAIL |
| Q6 | **Skill Routing** | Dynamic skill loading based on domain ("If relevant skills: read them") | PASS/FAIL |

### Tier 3: Anti-Patterns (Should NOT Have)

| # | Anti-Pattern | What to Check | Score |
|---|-------------|--------------|-------|
| A1 | **Over-specification** | Method section has >10 prescriptive steps (overprompting trap) | CLEAN/FLAG |
| A2 | **Missing Intent** | No clear single-sentence task statement — just jumps into method | CLEAN/FLAG |
| A3 | **Context Assumption** | References files/vars not explicitly passed in prompt | CLEAN/FLAG |
| A4 | **Vague Deliverable** | No specific output file path or format template | CLEAN/FLAG |
| A5 | **Unbounded Scope** | Agent could interpret task too broadly — no hard boundary | CLEAN/FLAG |

---

## Command Design

### Phase 0: Target Selection

```
AskUserQuestion:
  question: "What should I enhance?"
  options: [
    "All commands in directory (Recommended)" — Scan all .md files in commands/
    "Specific command file" — Enhance one command
  ]
```

If specific: ask which file. If all: scan directory.

### Phase 1: Extract & Score (Conductor does this directly)

For each target file:
1. Read file content
2. Extract all `Task(` prompt blocks (text between triple-quote delimiters)
3. For each prompt, score against rubric (Tier 1 + 2 + 3)
4. Produce scorecard per prompt

**Scorecard format:**
```markdown
### [Command]: [Agent Role] ([model])

| Pattern | Score | Notes |
|---------|-------|-------|
| S1: Context Loading | PASS | "First: read AGENTS.md" present |
| S2: Persona + Authority | WEAK | Has persona but no authority boundary |
| ...

**Overall:** 12/14 PASS, 1 WEAK, 1 FAIL
**Priority fixes:** S2 (add authority), Q2 (add scope constraint)
```

### Phase 2: Present Findings

Group by severity:
1. **FAIL items** — Missing must-have patterns (Critical)
2. **WEAK items** — Partially present (High)
3. **FLAG items** — Anti-patterns detected (Medium)
4. **Statistics** — Overall scores per command

Present summary table:
```
| Command | Prompts | Pass | Weak | Fail | Flag | Score |
|---------|---------|------|------|------|------|-------|
| hygiene | 3 | 21/24 | 2 | 1 | 0 | 88% |
| bead-refine | 3 | 20/24 | 3 | 1 | 1 | 83% |
```

### Phase 3: Enhance (With User Approval)

Present top fixes:
```
AskUserQuestion:
  question: "Found N enhancement opportunities across M commands. Apply?"
  multiSelect: true
  options: [
    "All FAIL fixes (Recommended)" — Fix all missing must-have patterns
    "All FAIL + WEAK fixes" — Fix missing + improve partial patterns
    "All fixes including anti-patterns" — Full enhancement pass
  ]
```

### Phase 4: Apply Enhancements

For each approved fix, use Edit tool to modify the prompt in-place.

**Enhancement templates (what gets inserted/modified):**

**S1 fix (Context Loading):**
```
First: read AGENTS.md for project context, coding standards, and conventions.
{If relevant skills identified: "Read the relevant skill file for domain patterns (see AGENTS.md > Available Skills)."}
```

**S2 fix (Persona + Authority):**
Add after persona: `Your authority: [what you can decide]. Escalate: [what needs conductor approval].`

**S8 fix (Honesty Gate):**
Add at end of prompt: `If nothing found: say so honestly. Do not invent issues.`

**Q2 fix (Scope Constraint):**
Add: `Your only verbs: [appropriate verbs for this role].`

**A1 fix (Over-specification):**
Collapse >10 method steps into intent statement + 3-5 key checks. Let agent determine method.

### Phase 5: Verify & Commit

1. Re-score enhanced prompts to confirm improvements
2. Show before/after score comparison
3. Sync to vitest-affected (if in agent-compounds)
4. Commit with descriptive message

---

## Files to Create/Modify

| File | Action |
|------|--------|
| `commands/prompt-enhance.md` | CREATE — The new command |
| Various `commands/*.md` | MODIFY — When enhancement is applied |

---

## Design Decisions

1. **Conductor-only, no subagents** — The scoring rubric is mechanical (pattern matching), doesn't need AI judgment. Conductor reads prompts and checks against rubric directly.

2. **Rubric is inline in the command** — Not a separate file. The patterns ARE the command's knowledge. If patterns evolve, edit the command.

3. **Enhancement templates are prescriptive** — Each fix has an exact template. No ambiguity about what "fix S1" means.

4. **Scores are binary-ish** — PASS/WEAK/FAIL, not 1-10. Prevents analysis paralysis.

5. **Apply is opt-in** — User sees scores and chooses what level of enhancement to apply.

6. **Works on any command** — Not limited to agent-compounds. Could enhance any .md file with Task() prompts.

---

## Verification

1. Run `prompt-enhance` on a single command (e.g., `hygiene.md`) and verify:
   - All 3 prompts extracted correctly
   - Scores match manual inspection
   - Fixes apply cleanly (no broken formatting)
2. Run on all commands and verify:
   - Summary table accurate
   - No false positives (prompts that already pass getting flagged)
   - Enhanced prompts still read naturally (not over-templated)
3. Sync enhanced commands to vitest-affected and verify identical content
