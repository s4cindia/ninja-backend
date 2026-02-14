#!/bin/bash
# ============================================================================
# Session Context Loader
# ============================================================================
# Runs when a Claude Code session starts or resumes.
# Injects useful project context into Claude's awareness:
#   - Current Git branch and recent commits
#   - Modified/staged files
#   - Active TODO/FIXME items
#
# stdout from SessionStart hooks is added to Claude's context.
# ============================================================================

echo "=== Project Context ==="

# ── Git Status ──────────────────────────────────────────────────────────────
if git rev-parse --is-inside-work-tree &>/dev/null; then
  BRANCH=$(git branch --show-current 2>/dev/null)
  echo "Branch: $BRANCH"
  
  # Recent commits (last 5)
  echo ""
  echo "Recent commits:"
  git log --oneline -5 2>/dev/null | sed 's/^/  /'
  
  # Modified files
  MODIFIED=$(git status --short 2>/dev/null)
  if [ -n "$MODIFIED" ]; then
    echo ""
    echo "Working tree changes:"
    echo "$MODIFIED" | sed 's/^/  /'
  fi
  
  # Staged files
  STAGED=$(git diff --cached --name-only 2>/dev/null)
  if [ -n "$STAGED" ]; then
    echo ""
    echo "Staged for commit:"
    echo "$STAGED" | sed 's/^/  /'
  fi
fi

# ── Active TODOs in recently modified files ─────────────────────────────────
RECENT_FILES=$(git diff --name-only HEAD~3 2>/dev/null | grep -E '\.(ts|tsx|js|jsx)$' | head -10)
if [ -n "$RECENT_FILES" ]; then
  TODOS=$(echo "$RECENT_FILES" | xargs grep -n -E "(TODO|FIXME|HACK|XXX)" 2>/dev/null | head -10)
  if [ -n "$TODOS" ]; then
    echo ""
    echo "Active TODOs in recently changed files:"
    echo "$TODOS" | sed 's/^/  /'
  fi
fi

# ── Node/Package Info ───────────────────────────────────────────────────────
if [ -f "package.json" ]; then
  echo ""
  echo "Available npm scripts:"
  node -e "
    const pkg = require('./package.json');
    const scripts = pkg.scripts || {};
    const relevant = ['dev', 'build', 'start', 'test', 'lint', 'type-check', 'typecheck', 'format'];
    const found = Object.keys(scripts).filter(s => relevant.some(r => s.includes(r)));
    found.forEach(s => console.log('  npm run ' + s + ' → ' + scripts[s]));
  " 2>/dev/null
fi

echo ""
echo "=== End Context ==="
