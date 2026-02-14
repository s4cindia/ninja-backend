#!/bin/bash
# ============================================================================
# Post-Edit Code Quality
# ============================================================================
# Runs after Claude writes/edits a file.
# For React + TypeScript files:
#   1. Auto-formats with Prettier (if available)
#   2. Runs TypeScript type check
#   3. Reports errors back so Claude can fix them immediately
#
# This gives Claude the same tight feedback loop that IDE agents have.
# ============================================================================

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Skip if no file path (some tool calls don't have one)
if [ -z "$FILE_PATH" ] || [ "$FILE_PATH" = "null" ]; then
  exit 0
fi

# Only process TypeScript/JavaScript/React files
if [[ ! "$FILE_PATH" =~ \.(ts|tsx|js|jsx)$ ]]; then
  exit 0
fi

# Skip node_modules and build artifacts
if echo "$FILE_PATH" | grep -qE "(node_modules|\.next|dist|build)/"; then
  exit 0
fi

HAD_ERRORS=false

# ── Prettier Auto-Format ────────────────────────────────────────────────────
if command -v npx &> /dev/null; then
  # Check if prettier is available in the project
  if [ -f "node_modules/.bin/prettier" ] || [ -f ".prettierrc" ] || [ -f ".prettierrc.json" ] || [ -f "prettier.config.js" ]; then
    npx prettier --write "$FILE_PATH" 2>/dev/null
  fi
fi

# ── TypeScript Check ────────────────────────────────────────────────────────
if [ -f "tsconfig.json" ] && [[ "$FILE_PATH" =~ \.(ts|tsx)$ ]]; then
  TSC_OUTPUT=$(npx tsc --noEmit 2>&1)
  TSC_EXIT=$?
  if [ $TSC_EXIT -ne 0 ]; then
    # Filter to only errors related to the edited file for focused feedback
    RELEVANT_ERRORS=$(echo "$TSC_OUTPUT" | grep -A 2 "$FILE_PATH" 2>/dev/null)
    if [ -n "$RELEVANT_ERRORS" ]; then
      echo "TypeScript errors in $FILE_PATH:" >&2
      echo "$RELEVANT_ERRORS" >&2
      HAD_ERRORS=true
    else
      # Show all errors if we can't filter
      echo "TypeScript errors detected (may affect $FILE_PATH):" >&2
      echo "$TSC_OUTPUT" | head -20 >&2
      HAD_ERRORS=true
    fi
  fi
fi

# ── ESLint Check ────────────────────────────────────────────────────────────
HAS_ESLINT=false
for cfg in eslint.config.js eslint.config.mjs eslint.config.cjs .eslintrc.js .eslintrc.json .eslintrc.yml .eslintrc; do
  if [ -f "$cfg" ]; then
    HAS_ESLINT=true
    break
  fi
done

if [ "$HAS_ESLINT" = true ]; then
  # Try auto-fix first
  npx eslint --fix "$FILE_PATH" 2>/dev/null
  
  # Check if errors remain
  LINT_OUTPUT=$(npx eslint "$FILE_PATH" 2>&1)
  LINT_EXIT=$?
  if [ $LINT_EXIT -ne 0 ]; then
    echo "ESLint errors in $FILE_PATH:" >&2
    echo "$LINT_OUTPUT" >&2
    HAD_ERRORS=true
  fi
fi

if [ "$HAD_ERRORS" = true ]; then
  echo "" >&2
  echo "Fix the errors above before continuing." >&2
  exit 2
fi

exit 0
