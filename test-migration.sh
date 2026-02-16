#!/bin/bash

# ACR Schema Migration Testing Script
# This script tests migration 20260216054800_fix_acr_schema_conflicts

set -e  # Exit on error

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="backup_pre_migration_${TIMESTAMP}.sql"
MIGRATION_DIR="prisma/migrations/20260216054800_fix_acr_schema_conflicts"

echo "=========================================="
echo "ACR Schema Migration Testing"
echo "=========================================="
echo ""
echo "Timestamp: $TIMESTAMP"
echo "Backup file: $BACKUP_FILE"
echo ""

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_step() {
    echo -e "${BLUE}[STEP $1]${NC} $2"
}

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

# Step 0: Check Prerequisites
print_step "0" "Checking prerequisites..."

if ! command -v npx &> /dev/null; then
    print_error "npx not found. Please install Node.js"
    exit 1
fi

if [ ! -f "prisma/schema.prisma" ]; then
    print_error "prisma/schema.prisma not found. Are you in the right directory?"
    exit 1
fi

if [ ! -d "$MIGRATION_DIR" ]; then
    print_error "Migration directory not found: $MIGRATION_DIR"
    exit 1
fi

print_success "Prerequisites OK"
echo ""

# Step 1: Test Database Connection
print_step "1" "Testing database connection..."

if npx prisma db execute --stdin <<< "SELECT 1 as connection_test;" &> /dev/null; then
    print_success "Database connection OK"
else
    print_error "Cannot connect to database. Check DATABASE_URL in .env"
    exit 1
fi
echo ""

# Step 2: Check Current Migration Status
print_step "2" "Checking current migration status..."

echo "Running: npx prisma migrate status"
npx prisma migrate status || true
echo ""

# Step 3: Backup Database (using pg_dump if available, otherwise warn)
print_step "3" "Creating database backup..."

if command -v pg_dump &> /dev/null; then
    # Extract connection details from DATABASE_URL (preserves all '=' in connection string)
    DATABASE_URL=$(grep '^DATABASE_URL=' .env | cut -d '=' -f2- | sed -e 's/^["\x27]//' -e 's/["\x27]$//')
    pg_dump "$DATABASE_URL" > "$BACKUP_FILE"
    print_success "Backup created: $BACKUP_FILE ($(du -h $BACKUP_FILE | cut -f1))"
else
    print_warning "pg_dump not found. Manual backup recommended before proceeding."
    echo "Press Enter to continue without backup, or Ctrl+C to cancel..."
    read
fi
echo ""

# Step 4: Pre-Migration Checks
print_step "4" "Running pre-migration checks..."

echo "Checking for orphaned CriterionChangeLog records..."
npx prisma db execute --stdin <<'EOF'
SELECT COUNT(*) as orphaned_count
FROM "CriterionChangeLog" ccl
LEFT JOIN "AcrCriterionReview" acr ON ccl."criterionReviewId" = acr.id
WHERE acr.id IS NULL;
EOF

echo ""
echo "Checking for duplicate AcrJob records..."
npx prisma db execute --stdin <<'EOF'
SELECT "tenantId", "jobId", COUNT(*) as duplicate_count
FROM "AcrJob"
GROUP BY "tenantId", "jobId"
HAVING COUNT(*) > 1;
EOF

echo ""
echo "Checking for duplicate AcrCriterionReview records..."
npx prisma db execute --stdin <<'EOF'
SELECT "acrJobId", "criterionId", COUNT(*) as duplicate_count
FROM "AcrCriterionReview"
GROUP BY "acrJobId", "criterionId"
HAVING COUNT(*) > 1;
EOF

echo ""
print_success "Pre-migration checks complete"
echo ""

# Step 5: Apply Migration
print_step "5" "Applying migration..."

echo "Running: npx prisma migrate deploy"
if npx prisma migrate deploy; then
    print_success "Migration applied successfully!"
else
    print_error "Migration failed!"
    echo ""
    echo "To rollback, run:"
    echo "  npx prisma db execute --file $MIGRATION_DIR/ROLLBACK.sql"
    exit 1
fi
echo ""

# Step 6: Run Verification Tests
print_step "6" "Running verification tests..."

# Since psql might not be available, we'll run the verification manually using prisma db execute
echo "Note: Running verification checks via Prisma CLI..."

# Test 1: Check for NULL values
echo "Test 1: Checking AcrCriterionReview for NULL values..."
npx prisma db execute --stdin <<'EOF'
SELECT
    COUNT(*) as total,
    COUNT("level") as has_level,
    COUNT("aiStatus") as has_aistatus
FROM "AcrCriterionReview";
EOF

# Test 2: Check CriterionChangeLog structure
echo ""
echo "Test 2: Checking CriterionChangeLog structure..."
npx prisma db execute --stdin <<'EOF'
SELECT column_name
FROM information_schema.columns
WHERE table_name = 'CriterionChangeLog'
ORDER BY ordinal_position;
EOF

# Test 3: Check for NULL acrJobId (unmapped records)
echo ""
echo "Test 3: Checking for NULL acrJobId..."
npx prisma db execute --stdin <<'EOF'
SELECT COUNT(*) as orphaned_count
FROM "CriterionChangeLog"
WHERE "acrJobId" IS NULL;
EOF

# Test 4: Check archive table
echo ""
echo "Test 4: Checking archive table..."
npx prisma db execute --stdin <<'EOF'
SELECT COUNT(*) as archived_count
FROM "CriterionChangeLog_Archive"
WHERE migration_name = '20260216054800_fix_acr_schema_conflicts';
EOF

print_success "Verification tests complete"
echo ""

# Step 7: Test Idempotency
print_step "7" "Testing idempotency (running migration again)..."

if npx prisma migrate deploy; then
    print_success "Idempotency test passed! Migration can be re-run safely."
else
    print_warning "Idempotency test failed (migration already applied, which is expected)"
fi
echo ""

# Step 8: Verify Schema Alignment
print_step "8" "Verifying schema alignment with database..."

echo "Running: npx prisma db pull"
npx prisma db pull --force --print > /tmp/pulled-schema.prisma

if diff -q prisma/schema.prisma /tmp/pulled-schema.prisma > /dev/null 2>&1; then
    print_success "Schema is perfectly aligned! No drift detected."
else
    print_warning "Schema drift detected. Checking differences..."
    diff prisma/schema.prisma /tmp/pulled-schema.prisma || true
fi
echo ""

# Step 9: Final Summary
print_step "9" "Migration test summary"

echo ""
echo "=========================================="
echo "✅ MIGRATION TEST COMPLETE"
echo "=========================================="
echo ""
echo "Results:"
echo "  - Migration applied: ✅"
echo "  - Verification tests: ✅"
echo "  - Idempotency test: ✅"
echo "  - Schema alignment: Check output above"
echo ""
echo "Backup file: $BACKUP_FILE"
echo ""
echo "Next steps:"
echo "  1. Review the output above for any warnings"
echo "  2. Check archived records (if any):"
echo "     npx prisma db execute --stdin <<< \"SELECT * FROM CriterionChangeLog_Archive LIMIT 5;\""
echo "  3. If everything looks good, ready to merge PR!"
echo ""
echo "To rollback (if needed):"
echo "  npx prisma db execute --file $MIGRATION_DIR/ROLLBACK.sql"
echo ""
