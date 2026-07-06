#!/usr/bin/env bash
set -euo pipefail

# Ensure Node/npm are available in hook context
export PATH="$HOME/.npm-global/bin:$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node/" 2>/dev/null | tail -1)/bin:$PATH" 2>/dev/null || true

# Read tool input from stdin
input=$(cat)
command=$(echo "$input" | jq -r '.tool_input.command // ""')

# Only intercept git commit commands
if ! echo "$command" | grep -q "git commit"; then
  exit 0
fi

echo "Running pre-commit checks..." >&2

# Helper function to run checks with detailed error output
run_check() {
  local step=$1
  local description=$2
  local cmd=$3

  echo "$step $description..." >&2

  # Create temporary file for output
  local output_file=$(mktemp)

  # Run command and capture output
  if eval "$cmd" > "$output_file" 2>&1; then
    rm -f "$output_file"
    echo "  ✓ Passed" >&2
    return 0
  else
    local exit_code=$?
    echo "  ✗ Failed" >&2
    echo "" >&2
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
    echo "ERROR: $description failed" >&2
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
    echo "" >&2

    # Show last 50 lines of output (or all if less than 50)
    tail -n 50 "$output_file" >&2
    echo "" >&2
    echo "  You must fix these errors manually before committing." >&2
    echo "" >&2

    rm -f "$output_file"
    return $exit_code
  fi
}

# 1. Build FIRST (cannot auto-fix)
# tests/type-check import from the BUILT ./dist artifact (vitest.config.ts +
# tools/replay), so a stale dist would make steps 2-4 validate the pre-edit
# build. Mirror CI, which builds before type-checking/testing.
run_check "1/4" "Building project" "npm run build" || {
  exit 2
}

# 2. Type check (cannot auto-fix)
run_check "2/4" "Type checking" "npx tsc --noEmit" || {
  exit 2
}

# 3. Type check tests (cannot auto-fix)
# The base tsconfig excludes test/ from the build, so the suite is never
# type-checked by step 2. tsconfig.test.json includes test/ + src/ (noEmit)
# to enforce strict / "no any" across the tests too.
run_check "3/4" "Type checking tests" "npx tsc -p tsconfig.test.json --noEmit" || {
  exit 2
}

# 4. Tests (cannot auto-fix)
run_check "4/4" "Running tests" "npx vitest run" || {
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
  echo "TIPS FOR FIXING TEST FAILURES:" >&2
  echo "  • Run 'npx vitest run test/path/to/file.test.ts' for a specific test" >&2
  echo "  • Run 'npx vitest' for interactive watch mode" >&2
  echo "  • Check test fixtures in test/fixtures/ for known dependency structures" >&2
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
  exit 2
}

echo "" >&2
echo "All pre-commit checks passed!" >&2
echo "" >&2
exit 0
