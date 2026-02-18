#!/bin/bash
# Validate that NEW migrations are idempotent
# Run before pushing: ./scripts/validate-migrations.sh
#
# Old migrations (before 2026-02-15) are grandfathered in - they've already been applied
# Only new migrations need to be idempotent for CI/CD re-runs

RED='\033[0;31m'
YELLOW='\033[0;33m'
GREEN='\033[0;32m'
NC='\033[0m'

# Migrations before this date are grandfathered (already applied, won't be re-run)
CUTOFF_DATE="20260215"

echo "Checking migrations for non-idempotent patterns..."
echo "(Migrations before $CUTOFF_DATE are grandfathered)"
echo ""

ERRORS=0

for file in prisma/migrations/*/migration.sql; do
    # Skip if no files match
    [ -e "$file" ] || continue

    # Extract migration date from path (format: YYYYMMDDHHMMSS_name)
    dirname=$(dirname "$file")
    migration_name=$(basename "$dirname")
    migration_date=$(echo "$migration_name" | grep -oE '^[0-9]+' | cut -c1-8)

    # Skip old migrations (grandfathered)
    if [[ "$migration_date" < "$CUTOFF_DATE" ]]; then
        continue
    fi

    HAS_ISSUE=0

    # Check for bare ALTER TABLE ADD/ALTER COLUMN without DO block
    # (DROP COLUMN IF EXISTS is idempotent, so we don't flag it)
    if grep -qE "^ALTER TABLE.*ADD COLUMN(?! IF NOT EXISTS)" "$file" && ! grep -q 'DO \$\$' "$file"; then
        echo -e "${RED}ERROR:${NC} $file has bare ALTER TABLE ADD COLUMN without IF NOT EXISTS or DO block"
        HAS_ISSUE=1
    fi

    if grep -qE "^ALTER TABLE.*ALTER COLUMN" "$file" && ! grep -q 'DO \$\$' "$file"; then
        echo -e "${RED}ERROR:${NC} $file has bare ALTER TABLE ALTER COLUMN without DO block"
        HAS_ISSUE=1
    fi

    # Check for CREATE TABLE without IF NOT EXISTS
    if grep -qE "^CREATE TABLE(?! IF NOT EXISTS)" "$file"; then
        echo -e "${RED}ERROR:${NC} $file has CREATE TABLE without IF NOT EXISTS"
        HAS_ISSUE=1
    fi

    # Check for CREATE INDEX without IF NOT EXISTS
    if grep -qE "^CREATE INDEX(?! IF NOT EXISTS)" "$file" && ! grep -qE "^CREATE UNIQUE INDEX(?! IF NOT EXISTS)" "$file"; then
        echo -e "${RED}ERROR:${NC} $file has CREATE INDEX without IF NOT EXISTS"
        HAS_ISSUE=1
    fi

    if grep -qE "^CREATE UNIQUE INDEX(?! IF NOT EXISTS)" "$file"; then
        echo -e "${RED}ERROR:${NC} $file has CREATE UNIQUE INDEX without IF NOT EXISTS"
        HAS_ISSUE=1
    fi

    # Check for bare DROP without IF EXISTS (outside DO blocks)
    if grep -qE "^DROP (TABLE|INDEX) " "$file" && ! grep -qE "^DROP (TABLE|INDEX) IF EXISTS" "$file"; then
        echo -e "${RED}ERROR:${NC} $file has DROP without IF EXISTS"
        HAS_ISSUE=1
    fi

    # Check for ALTER TYPE ADD VALUE - must be in DO block with pg_enum check
    # The proper pattern has both "DO $$" AND "pg_enum" check
    if grep -qE "ALTER TYPE.*ADD VALUE" "$file"; then
        if ! grep -q 'DO \$\$' "$file" || ! grep -q "pg_enum" "$file"; then
            echo -e "${RED}ERROR:${NC} $file has ALTER TYPE ADD VALUE without idempotent pg_enum check"
            HAS_ISSUE=1
        fi
    fi

    # Check for ADD CONSTRAINT without DO block exception handling
    if grep -qE "^ALTER TABLE.*ADD CONSTRAINT" "$file" && ! grep -q 'DO \$\$' "$file"; then
        echo -e "${RED}ERROR:${NC} $file has bare ADD CONSTRAINT without DO block (use EXCEPTION handling)"
        HAS_ISSUE=1
    fi

    if [ $HAS_ISSUE -eq 1 ]; then
        ERRORS=$((ERRORS + 1))
    fi
done

echo ""
if [ $ERRORS -eq 0 ]; then
    echo -e "${GREEN}✓ All new migrations are idempotent!${NC}"
    exit 0
else
    echo -e "${RED}✗ Found $ERRORS migration(s) with non-idempotent patterns${NC}"
    echo ""
    echo "How to fix:"
    echo "  - Wrap ALTER TABLE in: DO \$\$ BEGIN ... EXCEPTION WHEN ... END \$\$;"
    echo "  - Use CREATE TABLE IF NOT EXISTS"
    echo "  - Use CREATE INDEX IF NOT EXISTS"
    echo "  - Use DROP ... IF EXISTS"
    echo "  - For ALTER TYPE ADD VALUE, check pg_enum first in DO block"
    echo "  - For ADD CONSTRAINT, wrap in DO block with EXCEPTION handling"
    exit 1
fi
