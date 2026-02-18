#!/bin/bash
# Validate that migrations are idempotent
# Run before pushing: ./scripts/validate-migrations.sh

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

echo "Checking migrations for non-idempotent patterns..."

ERRORS=0

for file in prisma/migrations/*/migration.sql; do
    # Skip if no files match
    [ -e "$file" ] || continue

    # Check for bare ALTER TABLE without DO $$ block or IF EXISTS
    if grep -qE "^ALTER TABLE" "$file" && ! grep -q "DO \$\$" "$file"; then
        echo -e "${RED}WARNING:${NC} $file has bare ALTER TABLE without DO block"
        ERRORS=$((ERRORS + 1))
    fi

    # Check for CREATE TABLE without IF NOT EXISTS
    if grep -qE "^CREATE TABLE" "$file" && ! grep -q "IF NOT EXISTS" "$file"; then
        echo -e "${RED}WARNING:${NC} $file has CREATE TABLE without IF NOT EXISTS"
        ERRORS=$((ERRORS + 1))
    fi

    # Check for CREATE INDEX without IF NOT EXISTS
    if grep -qE "^CREATE INDEX" "$file" && ! grep -q "IF NOT EXISTS" "$file"; then
        echo -e "${RED}WARNING:${NC} $file has CREATE INDEX without IF NOT EXISTS"
        ERRORS=$((ERRORS + 1))
    fi
done

if [ $ERRORS -eq 0 ]; then
    echo -e "${GREEN}All migrations look idempotent!${NC}"
    exit 0
else
    echo -e "${RED}Found $ERRORS potential issues. Please review.${NC}"
    exit 1
fi
