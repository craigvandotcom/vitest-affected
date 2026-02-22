# Flywheel Commands

Agentic engineering workflows for Claude Code. Drop into any project's `.claude/commands/` directory.

Inspired by Jeffrey Emanuel's Agentic Coding Flywheel methodology: 80-85% planning, 15-20% implementation.

## Installation

1. Copy `commands/*.md` into your project's `.claude/commands/` (or a subdirectory like `.claude/commands/flywheel/`)
2. Copy `AGENTS.md` template into your project root
3. Fill in `AGENTS.md` with your project's commands, architecture, and conventions
4. Optionally copy `CLAUDE.md` template as a starter

## Commands

### Planning

| Command | Purpose |
| ------- | ------- |
| `plan-init` | Create implementation plans — 3 parallel explorers, validation baseline, test specs, user-gated approval |
| `plan-refine-internal` | Multi-agent plan refinement — 3-tier (light/medium/heavy), no external API |
| `plan-refine-external` | Multi-model refinement via OpenRouter — 4 diverse external models |
| `plan-review-genius` | Single-model deep forensic review |
| `plan-transcender-alien` | Paradigm-breaking alternative perspectives |

### Beads (Implementation)

| Command | Purpose |
| ------- | ------- |
| `beadify` | Convert refined plan to beads task structure |
| `bead-refine` | Refine bead structure — 3 parallel reviewers, severity-based convergence |
| `bead-work` | Sequential implementation — conductor + engineer sub-agents |
| `bead-land` | Session closure — retrospective learning + system compounding |

### Review & Maintenance

| Command | Purpose |
| ------- | ------- |
| `work-review` | Feature-branch code review — 4 parallel reviewers, severity-based auto-fix, user-escalated decisions |
| `hygiene` | Iterative codebase review — 3 agents, multiple rounds until plateau |

### Ideas

| Command | Purpose |
| ------- | ------- |
| `idea-review-genius` | Deep review of specific ideas |
| `idea-transcender-alien` | Alien-perspective idea enhancement |

## Workflow

```
plan-init → plan-refine-internal → beadify → bead-refine → bead-work → work-review → bead-land
```

## Dependencies

### Required (for bead-* commands)

- **beads_rust** (`br`) — bead task management
- **beads_viewer** (`bv`) — TUI viewer + AI-driven work selection

### Optional

- **Agent Mail** (MCP) — multi-session coordination, file reservations, messaging
- **OpenRouter** (`openrouter` CLI) — required only for `plan-refine-external`
- **Browser testing tool** (e.g., `agent-browser`) — optional UI validation in `bead-land`

## Key Files

| File | Purpose |
| ---- | ------- |
| `AGENTS.md` | **Template** — project context for subagents (commands, architecture, skills, rules) |
| `CLAUDE.md` | **Template** — minimal pointer for main orchestrator |

## Philosophy

> "Planning tokens are cheaper than implementation tokens"
> — Jeffrey Emanuel

Each cycle improves the next. `bead-land` extracts learnings and proposes system upgrades, making subsequent sessions faster and higher quality.
