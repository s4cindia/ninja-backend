#!/bin/bash
# .claude/hooks/session-start.sh (OPTIONAL — opt-in only)
# Lightweight cached version: one-line status, runs at most once per hour.
#
# To enable:  touch .claude/.enable-status
# To disable: rm .claude/.enable-status

# Skip entirely if not opted in
[ -f ".claude/.enable-status" ] || exit 0

# Skip if ran within the last hour (cache by repo path hash)
REPO_HASH=$(git rev-parse --show-toplevel 2>/dev/null | cksum | cut -d' ' -f1)
CACHE="/tmp/claude-ninja-${REPO_HASH:-unknown}"
if [ -f "$CACHE" ]; then
    CACHE_AGE=$(($(date +%s) - $(stat -c%Y "$CACHE" 2>/dev/null || stat -f%m "$CACHE" 2>/dev/null || echo 0)))
    [ "$CACHE_AGE" -lt 3600 ] && exit 0
fi

# One-line status only
REPO=$(basename "$(git remote get-url origin 2>/dev/null)" .git 2>/dev/null || echo "unknown")
BRANCH=$(git branch --show-current 2>/dev/null || echo "detached")
DIRTY=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
DIRTY_MSG=""
[ "$DIRTY" -gt 0 ] && DIRTY_MSG=" | 📝 ${DIRTY} uncommitted"

echo "🥷 $REPO | 📍 $BRANCH${DIRTY_MSG} | Full status: npm run status"
touch "$CACHE"
