#!/bin/bash

# StatusLine generator for Claude Code
# Displays: +123 -45 [████░░░░] 23%
# Lines added/removed reflect current git working tree, not session totals

# Claude Code pipes JSON via stdin
INPUT=$(cat)

# Extract context percentage
if command -v jq >/dev/null 2>&1; then
    CONTEXT_PCT=$(echo "$INPUT" | jq -r '.context_window.used_percentage // 0' | cut -d. -f1)
else
    CONTEXT_PCT=$(echo "$INPUT" | grep -o '"used_percentage":[0-9.]*' | cut -d':' -f2 | cut -d'.' -f1)
fi

CONTEXT_PCT="${CONTEXT_PCT:-0}"

# Git diff stats with 5-second cache
CACHE_FILE="/tmp/claude-statusline-git-cache"
CACHE_MAX_AGE=5
NOW=$(date +%s)

if [ ! -f "$CACHE_FILE" ] || [ $((NOW - $(stat -c %Y "$CACHE_FILE" 2>/dev/null || echo 0))) -gt $CACHE_MAX_AGE ]; then
    if git rev-parse --git-dir > /dev/null 2>&1; then
        STATS=$(git diff --numstat 2>/dev/null | awk '{a+=$1; d+=$2} END {print a+0"|"d+0}')
        echo "$STATS" > "$CACHE_FILE"
    else
        echo "0|0" > "$CACHE_FILE"
    fi
fi

IFS='|' read -r LINES_ADDED LINES_REMOVED < "$CACHE_FILE"
LINES_ADDED="${LINES_ADDED:-0}"
LINES_REMOVED="${LINES_REMOVED:-0}"

# Progress bar (8 blocks)
FILLED=$(( CONTEXT_PCT * 8 / 100 ))
EMPTY=$(( 8 - FILLED ))

PROGRESS_BAR=""
for ((i=0; i<FILLED; i++)); do PROGRESS_BAR+="█"; done
for ((i=0; i<EMPTY; i++)); do PROGRESS_BAR+="░"; done

# ANSI colors
RED="\033[31m"
GREEN="\033[32m"
RESET="\033[0m"

# Format: +123 -45 [████░░░░] 23%
OUTPUT="${GREEN}+${LINES_ADDED}${RESET} ${RED}-${LINES_REMOVED}${RESET}"
OUTPUT+=" [${PROGRESS_BAR}] ${CONTEXT_PCT}%"

echo -e "$OUTPUT"
