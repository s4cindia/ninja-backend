#!/bin/bash
# .claude/bin/ninja-status.sh
# On-demand context detection for Ninja Platform backend
# Usage: npm run status  OR  git ninja-status  OR  bash .claude/bin/ninja-status.sh
set -euo pipefail

echo "🥷 Ninja Backend Status"
echo "────────────────────────"

# 1. Repository and branch info
REPO=$(basename "$(git remote get-url origin 2>/dev/null)" .git 2>/dev/null || echo "unknown")
BRANCH=$(git branch --show-current 2>/dev/null || true)
if [ -z "$BRANCH" ]; then
    BRANCH="detached"
fi
echo "📦 Repo: $REPO"
echo "📍 Branch: $BRANCH"
echo "   Last: $(git log -1 --oneline 2>/dev/null || echo 'no commits')"

# 2. Check infrastructure
if command -v docker >/dev/null 2>&1 && docker ps 2>/dev/null | grep -q postgres; then
    echo "✅ PostgreSQL: Running"
else
    echo "❌ PostgreSQL: Not running → docker-compose up -d"
fi

if command -v docker >/dev/null 2>&1 && docker ps 2>/dev/null | grep -q redis; then
    echo "✅ Redis: Running"
else
    echo "⚠️  Redis: Not running → docker-compose up -d"
fi

# 3. Check for pending Prisma migrations (only if prisma is available)
if [ -d "prisma/migrations" ] && command -v npx >/dev/null 2>&1; then
    PENDING=$(npx prisma migrate status 2>&1 | grep -c "not yet applied" || true)
    PENDING=$(echo "$PENDING" | tail -n1)
    PENDING=${PENDING:-0}
    if [ "$PENDING" != "0" ]; then
        echo "⚠️  Prisma: $PENDING pending migration(s) → npx prisma migrate dev"
    fi
fi

# 4. Detect work context from changed files
#    Cascade: uncommitted → staged → last commit → modified files
#    Only fall back if previous command produced no output (not just on failure)
#    Use || true to prevent set -e from exiting on git command failures
echo ""
changed=$(git diff --name-only HEAD 2>/dev/null || true)
if [ -z "$changed" ]; then
    changed=$(git diff --cached --name-only 2>/dev/null || true)
fi
if [ -z "$changed" ]; then
    changed=$(git diff --name-only HEAD~1 2>/dev/null || true)
fi
if [ -z "$changed" ]; then
    changed=$(git ls-files -m 2>/dev/null || true)
fi

if [ -z "$changed" ]; then
    echo "💡 No recent changes detected. Docs: docs/INDEX.md"
else
    # Match context and only reference docs that actually exist
    if echo "$changed" | grep -q "prisma/\|migrations/"; then
        echo "💡 Database work detected"
        [ -f "docs/DATABASE.md" ] && echo "   📄 docs/DATABASE.md"
        echo "   ⚠️  Review migration SQL before deploying!"
    elif echo "$changed" | grep -q "services/pdf/\|pdf"; then
        echo "💡 PDF audit context"
        [ -d "src/services/epub/" ] && echo "   📄 Reference: src/services/epub/ (pattern to follow)"
    elif echo "$changed" | grep -q "services/epub/\|epub"; then
        echo "💡 EPUB workflow context"
        [ -d "src/services/accessibility/" ] && echo "   📄 src/services/accessibility/ (validation engine)"
    elif echo "$changed" | grep -q "services/acr/\|acr\|vpat"; then
        echo "💡 ACR/VPAT generation context"
        [ -f "docs/DATABASE.md" ] && echo "   📄 docs/DATABASE.md (VPAT models)"
    elif echo "$changed" | grep -q "services/ai/\|gemini"; then
        echo "💡 AI integration context"
        [ -f "src/config/gemini.ts" ] && echo "   📄 src/config/gemini.ts"
    elif echo "$changed" | grep -q "test\|spec\|\.test\."; then
        echo "💡 Testing context"
        [ -f "docs/TESTING.md" ] && echo "   📄 docs/TESTING.md"
    elif echo "$changed" | grep -q ".github/\|deploy\|Dockerfile\|docker"; then
        echo "💡 CI/CD & deployment context"
        [ -f "docs/AWS-INFRA.md" ] && echo "   📄 docs/AWS-INFRA.md"
    elif echo "$changed" | grep -q "routes/\|controllers/\|middleware/"; then
        echo "💡 API development context"
        [ -f "docs/API-PATTERNS.md" ] && echo "   📄 docs/API-PATTERNS.md"
    fi
fi

# 5. Sprint branch detection (POSIX-compliant, no grep -P)
if echo "$BRANCH" | grep -q "^feature/sprint-"; then
    SPRINT=$(echo "$BRANCH" | grep -o 'sprint-[0-9][0-9]*' || echo "")
    if [ -n "$SPRINT" ]; then
        echo "🏃 Active sprint branch: $SPRINT"
    fi
fi

# 6. Uncommitted changes count
DIRTY=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
if [ "$DIRTY" -gt 0 ]; then
    echo "📝 Uncommitted changes: $DIRTY file(s)"
fi

echo "────────────────────────"
