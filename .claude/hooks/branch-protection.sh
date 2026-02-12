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

exit 0
