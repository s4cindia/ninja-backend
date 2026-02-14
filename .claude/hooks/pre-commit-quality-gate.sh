#!/bin/bash
# ============================================================================
# Pre-Commit Quality Gate
# ============================================================================
# Intercepts `git commit` commands and runs:
#   1. TypeScript compilation check (npx tsc --noEmit)
#   2. ESLint on staged JS/TS files
#   3. CodeRabbit CLI review (non-blocking warning only)
#
# Blocks the commit (exit 2) if TypeScript or lint checks fail.
# CodeRabbit issues are reported as warnings but don't block.
# ============================================================================

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Only intercept git commit commands
if ! echo "$COMMAND" | grep -qE "^git commit"; then
  exit 0
fi

echo "🚦 Pre-commit quality gate triggered..."
ERRORS=""
WARNINGS=""

# ── Step 1: TypeScript Compilation ──────────────────────────────────────────
echo ""
echo "📘 [1/3] TypeScript type checking..."
if [ -f "tsconfig.json" ]; then
  TSC_OUTPUT=$(npx tsc --noEmit 2>&1)
  TSC_EXIT=$?
  if [ $TSC_EXIT -ne 0 ]; then
    ERRORS="${ERRORS}\n━━━ TypeScript Errors ━━━\n${TSC_OUTPUT}\n"
    echo "  ❌ TypeScript errors found"
  else
    echo "  ✅ No type errors"
  fi
else
  echo "  ⏭️  No tsconfig.json found — skipping"
fi

# ── Step 2: ESLint ──────────────────────────────────────────────────────────
echo ""
echo "🔍 [2/3] Running ESLint on staged files..."

# Detect ESLint config (supports flat config and legacy)
HAS_ESLINT=false
for cfg in eslint.config.js eslint.config.mjs eslint.config.cjs .eslintrc.js .eslintrc.json .eslintrc.yml .eslintrc.yaml .eslintrc; do
  if [ -f "$cfg" ]; then
    HAS_ESLINT=true
    break
  fi
done

# Also check package.json for eslintConfig key
if [ "$HAS_ESLINT" = false ] && [ -f "package.json" ]; then
  if grep -q '"eslintConfig"' package.json 2>/dev/null; then
    HAS_ESLINT=true
  fi
fi

if [ "$HAS_ESLINT" = true ]; then
  STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null | grep -E '\.(ts|tsx|js|jsx)$')
  if [ -n "$STAGED_FILES" ]; then
    LINT_OUTPUT=$(echo "$STAGED_FILES" | xargs npx eslint 2>&1)
    LINT_EXIT=$?
    if [ $LINT_EXIT -ne 0 ]; then
      # Try auto-fix first
      echo "$STAGED_FILES" | xargs npx eslint --fix 2>/dev/null
      # Re-check after fix
      LINT_OUTPUT_AFTER=$(echo "$STAGED_FILES" | xargs npx eslint 2>&1)
      LINT_EXIT_AFTER=$?
      if [ $LINT_EXIT_AFTER -ne 0 ]; then
        ERRORS="${ERRORS}\n━━━ ESLint Errors (could not auto-fix) ━━━\n${LINT_OUTPUT_AFTER}\n"
        echo "  ❌ Lint errors remain after auto-fix attempt"
      else
        echo "  ✅ Lint errors auto-fixed — re-stage files before committing"
        # Re-stage the fixed files
        echo "$STAGED_FILES" | xargs git add 2>/dev/null
      fi
    else
      echo "  ✅ All staged files pass ESLint"
    fi
  else
    echo "  ⏭️  No staged .ts/.tsx/.js/.jsx files to lint"
  fi
else
  echo "  ⏭️  No ESLint config detected — skipping"
fi

# ── Step 3: CodeRabbit Review (non-blocking) ────────────────────────────────
echo ""
echo "🐰 [3/3] Running CodeRabbit review..."
if command -v coderabbit &> /dev/null; then
  CR_OUTPUT=$(timeout 120 coderabbit --plain --type uncommitted 2>&1)
  CR_EXIT=$?
  if [ $CR_EXIT -eq 124 ]; then
    echo "  ⏭️  CodeRabbit timed out (120s limit) — skipping"
  elif [ $CR_EXIT -ne 0 ]; then
    WARNINGS="${WARNINGS}\n━━━ CodeRabbit Review ━━━\n${CR_OUTPUT}\n"
    echo "  ⚠️  CodeRabbit found issues (non-blocking)"
  else
    if echo "$CR_OUTPUT" | grep -qiE "critical|high.*severity|security.*vulnerability"; then
      WARNINGS="${WARNINGS}\n━━━ CodeRabbit: Critical Issues ━━━\n${CR_OUTPUT}\n"
      echo "  ⚠️  CodeRabbit flagged critical issues (review recommended)"
    else
      echo "  ✅ No critical issues found"
    fi
  fi
else
  echo "  ⏭️  CodeRabbit CLI not installed — skipping"
  echo "     Install: curl -fsSL https://cli.coderabbit.ai/install.sh | sh"
fi

# ── Final Verdict ───────────────────────────────────────────────────────────
echo ""

# Show warnings (non-blocking)
if [ -n "$WARNINGS" ]; then
  echo "⚠️  Warnings (non-blocking):"
  echo -e "$WARNINGS"
fi

# Block on errors
if [ -n "$ERRORS" ]; then
  echo "🚫 COMMIT BLOCKED — Fix the following errors:" >&2
  echo -e "$ERRORS" >&2
  exit 2
fi

echo "✅ All quality checks passed. Proceeding with commit."
exit 0
