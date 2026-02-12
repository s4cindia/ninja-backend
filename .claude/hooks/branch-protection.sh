#!/bin/bash
# ============================================================================
# Branch Protection
# ============================================================================
# Prevents Claude from committing or pushing directly to main/master.
# Forces use of feature branches.
# ============================================================================

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Only check git commit and git push commands
if ! echo "$COMMAND" | grep -qE "^git (commit|push)"; then
  exit 0
fi

BRANCH=$(git branch --show-current 2>/dev/null)

# Check if current branch is main/master
if [ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ]; then
  cat >&2 <<EOF
🚫 Direct commits to '$BRANCH' are not allowed.

Please create a feature branch first:
  git checkout -b feature/your-feature-name

Or if you have uncommitted changes:
  git stash
  git checkout -b feature/your-feature-name
  git stash pop
EOF
  exit 2
fi

# For push commands, also check if targeting main/master (catches "git push origin HEAD:main" style bypasses)
if echo "$COMMAND" | grep -q "^git push"; then
  if echo "$COMMAND" | grep -qE '(:|[[:space:]]|refs/heads/|/)(main|master)([[:space:]]|$)'; then
    cat >&2 <<EOF
🚫 Direct pushes to 'main' or 'master' are not allowed.

Detected push target in command: $COMMAND

Please create a feature branch first:
  git checkout -b feature/your-feature-name

Or if you have uncommitted changes:
  git stash
  git checkout -b feature/your-feature-name
  git stash pop
EOF
    exit 2
  fi
fi

exit 0
