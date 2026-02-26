---
argument-hint: '[--all] [--deep] [--push]'
disable-model-invocation: false
name: commit
user-invocable: true
description: Use when the user asks to "commit changes", "craft a commit message", "stage and commit", or run a commit workflow. Creates atomic git commits with conventional-commit formatting and optional push.
---

# Git Commit

## Overview

Create atomic commits by staging the right files, analyzing the staged diff, composing a conventional commit message, and optionally pushing.

## Workflow

### 0) Pre-flight checks

- Verify inside a git worktree: `git rev-parse --is-inside-work-tree`
- Verify not detached: `git symbolic-ref HEAD`
- Verify not in rebase/merge/cherry-pick state
- If any check fails, stop with a clear error and suggested fix.

### 1) Collect context

- Current branch: `git branch --show-current`
- Git status: `git status --short --branch`
- Initial staged diff: `git diff --cached`

### 2) Handle staging

- If `--all`:
  - If no changes at all: error "No changes to commit"
  - If unstaged changes exist: `git add -A`
  - If already staged: proceed
- Otherwise (atomic commits):
  - Session-modified files = files edited in this session
  - Currently staged files: `git diff --cached --name-only`
  - For staged files NOT in session-modified set: `git restore --staged <file>`
  - For session-modified files with changes: `git add <file>`
  - If none: error "No files modified in this session"
- Re-read staged diff: `git diff --cached`

### 3) Analyze changes

- Read the staged diff
- Determine change type from behavior:
  - New functionality -> `feat`
  - Bug fix or error handling -> `fix`
  - Code reorganization without behavior change -> `refactor`
  - Documentation changes -> `docs`
  - Test additions/changes -> `test`
  - Build system -> `build`
  - Dependencies -> `chore(deps)`
  - Performance improvements -> `perf`
  - Other maintenance -> `chore`
- Infer scope only when path makes it obvious (lowercase)
- Extract a specific description of what changed

### 4) Compose message

- Subject line (<= 50 chars): `type(scope): description` or `type: description`
- Imperative mood ("add" not "added"), lowercase, no period
- Describe what the change does, not which files changed
- Body: hyphenated lines for distinct changes (skip for trivial changes)
- If `--deep`: 2-3 lines max focused on WHY, detect breaking changes

### 5) Commit

- Use `git commit -m "subject"` (add `-m "body"` only if body is non-empty)
- Output: commit hash + subject + file count summary

### 6) Push (if `--push`)

- If upstream exists: `git push`
- If no upstream: `git push -u origin HEAD`
