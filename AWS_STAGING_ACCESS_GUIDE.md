# AWS Staging Database Access Guide

## 🎯 Goal
Run `STAGING_VERIFICATION.sql` on your AWS staging database after deploying PR #184.

---

## 📋 Prerequisites

- [x] AWS Administrator access (you have this)
- [x] AWS CLI configured (check with `aws sts get-caller-identity`)
- [ ] Database connection details from staging

---

## 🔍 Step 1: Locate Your RDS Database

### Option A: Using AWS Console

1. **Go to AWS Console** → [RDS Dashboard](https://console.aws.amazon.com/rds)
2. **Click "Databases"** in left sidebar
3. **Find your staging database** (look for names like `ninja-staging`, `staging-db`, etc.)
4. **Click the database name**
5. **Note down:**
   - Endpoint (e.g., `ninja-staging.abc123.us-east-1.rds.amazonaws.com`)
   - Port (usually `5432` for PostgreSQL)
   - Database name (e.g., `ninja`)
   - Master username (e.g., `postgres`)

### Option B: Using AWS CLI

```bash
# List all RDS instances
aws rds describe-db-instances --query 'DBInstances[*].[DBInstanceIdentifier,Engine,Endpoint.Address,Endpoint.Port]' --output table

# Get specific instance details (replace with your DB identifier)
aws rds describe-db-instances --db-instance-identifier <your-staging-db-name> --query 'DBInstances[0].{Endpoint:Endpoint.Address,Port:Endpoint.Port,DBName:DBName,MasterUsername:MasterUsername}' --output json
```

---

## 🔑 Step 2: Get Database Password

### Option A: From AWS Secrets Manager (Recommended)

```bash
# List secrets
aws secretsmanager list-secrets --query 'SecretList[*].[Name,Description]' --output table

# Get secret value (replace with your secret name)
aws secretsmanager get-secret-value --secret-id <your-secret-name> --query SecretString --output text | jq -r '.password'
```

Common secret name patterns:
- `staging/database/credentials`
- `rds/staging/postgres`
- `ninja-staging-db-password`

### Option B: From Parameter Store

```bash
# List parameters
aws ssm get-parameters-by-path --path "/staging" --recursive --query 'Parameters[*].[Name,Value]' --output table

# Get specific parameter
aws ssm get-parameter --name "/staging/database/password" --with-decryption --query 'Parameter.Value' --output text
```

### Option C: From .env file in deployed application

If your backend is deployed to EC2/ECS/EKS:

**For ECS:**
```bash
# Get task definition
aws ecs describe-task-definition --task-definition <your-task-name> --query 'taskDefinition.containerDefinitions[0].environment' --output table
```

**For EC2:**
```bash
# SSH to instance and check .env file
ssh ec2-user@<instance-ip>
cat /path/to/your/app/.env | grep DATABASE_URL
```

---

## 🌐 Step 3: Check Network Access

### Check Security Group

```bash
# Get DB security group
aws rds describe-db-instances --db-instance-identifier <your-db-name> --query 'DBInstances[0].VpcSecurityGroups[0].VpcSecurityGroupId' --output text

# Check inbound rules (replace with your SG ID)
aws ec2 describe-security-groups --group-ids <security-group-id> --query 'SecurityGroups[0].IpPermissions' --output json
```

**Look for:**
- Rule allowing port `5432` (PostgreSQL)
- Source: Your IP or `0.0.0.0/0` (if publicly accessible)

### Is DB Publicly Accessible?

```bash
aws rds describe-db-instances --db-instance-identifier <your-db-name> --query 'DBInstances[0].PubliclyAccessible' --output text
```

**If `true`:** You can connect directly from your laptop
**If `false`:** You need a bastion host or VPN (see Step 4)

---

## 🔌 Step 4: Connect to Database

### Method 1: Using Prisma CLI (Easiest, No psql Required)

This is the **recommended method** since you already have Prisma installed.

```bash
# 1. Create a temporary DATABASE_URL for staging
export STAGING_DATABASE_URL="postgresql://username:password@endpoint:5432/dbname"

# Example:
export STAGING_DATABASE_URL="postgresql://postgres:YourPassword123@ninja-staging.abc123.us-east-1.rds.amazonaws.com:5432/ninja"

# 2. Test connection
npx prisma db execute --stdin --url "$STAGING_DATABASE_URL" <<< "SELECT current_database(), version();"

# 3. Run verification script
npx prisma db execute --file STAGING_VERIFICATION.sql --url "$STAGING_DATABASE_URL"
```

**Advantages:**
- ✅ No need to install psql
- ✅ Already familiar with Prisma
- ✅ Safe (uses --url parameter, doesn't modify local .env)

**Note:** Prisma db execute doesn't support `\echo` commands, so use the alternative queries below.

### Method 2: Using psql (If Available)

```bash
# Connect to staging database
psql "postgresql://username:password@endpoint:5432/dbname"

# Or using separate parameters
psql -h <endpoint> -p 5432 -U <username> -d <dbname>

# Run verification script
psql -h <endpoint> -p 5432 -U <username> -d <dbname> -f STAGING_VERIFICATION.sql
```

### Method 3: Using AWS Systems Manager Session Manager (If DB is Private)

If RDS is in a private subnet, use SSM to connect via a bastion:

```bash
# 1. Start session to bastion host (if you have one)
aws ssm start-session --target <bastion-instance-id>

# 2. Install psql on bastion (if not already installed)
sudo yum install -y postgresql15  # Amazon Linux 2
# OR
sudo apt-get install -y postgresql-client  # Ubuntu

# 3. Connect to RDS from bastion
psql -h <rds-endpoint> -p 5432 -U <username> -d <dbname>

# 4. Run verification script
\i /path/to/STAGING_VERIFICATION.sql
```

### Method 4: Using Database Client (GUI)

Install a database client:
- **DBeaver** (free): https://dbeaver.io/
- **pgAdmin** (free): https://www.pgadmin.org/
- **TablePlus** (paid): https://tableplus.com/

**Connection details:**
- Host: `<rds-endpoint>`
- Port: `5432`
- Database: `<dbname>`
- Username: `<username>`
- Password: `<password>`

Then copy-paste queries from `STAGING_VERIFICATION.sql` (skip `\echo` lines).

---

## ⚡ Step 5: Run Verification Queries

### Quick Health Check (5 queries, 30 seconds)

Since Prisma doesn't support `\echo`, use these standalone queries:

```bash
# Create quick check script
cat > quick_staging_check.sql <<'EOF'
-- 1. Check migration applied
SELECT
    CASE WHEN EXISTS (
        SELECT 1 FROM "_prisma_migrations"
        WHERE migration_name = '20260216054800_fix_acr_schema_conflicts'
        AND finished_at IS NOT NULL
    ) THEN '✅ Migration applied'
    ELSE '❌ Migration NOT applied'
    END as migration_status;

-- 2. Check no NULL acrJobIds
SELECT
    COUNT(*) as null_count,
    CASE WHEN COUNT(*) = 0 THEN '✅ No NULLs' ELSE '❌ Found NULLs' END as status
FROM "CriterionChangeLog"
WHERE "acrJobId" IS NULL;

-- 3. Check archive table
SELECT
    COUNT(*) as archived_count,
    CASE WHEN COUNT(*) >= 0 THEN '✅ Archive table working' ELSE '❌ Archive error' END as status
FROM "CriterionChangeLog_Archive"
WHERE migration_name = '20260216054800_fix_acr_schema_conflicts';

-- 4. Check unique constraints
SELECT
    COUNT(*) as constraint_count,
    CASE WHEN COUNT(*) = 2 THEN '✅ Constraints OK' ELSE '❌ Missing constraints' END as status
FROM pg_constraint
WHERE conname IN ('AcrCriterionReview_acrJobId_criterionId_key', 'AcrJob_tenantId_jobId_key');

-- 5. Overall health
SELECT
    '🎉 QUICK CHECK PASSED - Migration looks healthy!' as final_status;
EOF

# Run quick check
npx prisma db execute --file quick_staging_check.sql --url "$STAGING_DATABASE_URL"
```

### Full Verification (19 queries, 2 minutes)

**Option A: Using Prisma (no \echo support)**

Create a version without `\echo` commands:

```bash
# Strip \echo lines from STAGING_VERIFICATION.sql
grep -v '^\\echo' STAGING_VERIFICATION.sql > STAGING_VERIFICATION_NOECHO.sql

# Run it
npx prisma db execute --file STAGING_VERIFICATION_NOECHO.sql --url "$STAGING_DATABASE_URL"
```

**Option B: Using psql (full output with labels)**

```bash
psql "$STAGING_DATABASE_URL" -f STAGING_VERIFICATION.sql
```

---

## 🚨 Troubleshooting

### Error: "Connection timed out"

**Cause:** Security group doesn't allow your IP

**Fix:**
```bash
# Add your IP to security group (replace values)
MY_IP=$(curl -s https://checkip.amazonaws.com)
aws ec2 authorize-security-group-ingress \
    --group-id <security-group-id> \
    --protocol tcp \
    --port 5432 \
    --cidr $MY_IP/32
```

**Or use AWS Console:**
1. RDS → Databases → Your DB
2. Click security group link
3. Inbound rules → Edit
4. Add rule: Type=PostgreSQL, Source=My IP

### Error: "password authentication failed"

**Cause:** Wrong password

**Fix:**
- Double-check password from Secrets Manager
- Try URL encoding special characters in password
- Reset password via AWS Console if needed

### Error: "FATAL: database does not exist"

**Cause:** Wrong database name

**Fix:**
```bash
# Connect without database name and list databases
psql -h <endpoint> -U <username> -d postgres -c "\l"
```

### Error: "SSL connection required"

**Cause:** RDS requires SSL

**Fix:**
```bash
# Add ?sslmode=require to connection string
export STAGING_DATABASE_URL="postgresql://user:pass@host:5432/db?sslmode=require"
```

---

## 📝 Step-by-Step: Complete Workflow

### After Merging PR #184

```bash
# ============================================
# STEP 1: Wait for deployment to complete
# ============================================

# Check deployment status (GitHub Actions / your CI/CD)
gh pr view 184 --json mergedAt,state
# Look for deployment logs in your CI/CD system

# ============================================
# STEP 2: Get database credentials
# ============================================

# Get endpoint
aws rds describe-db-instances --db-instance-identifier <your-db> --query 'DBInstances[0].Endpoint.Address' --output text

# Get password from Secrets Manager
aws secretsmanager get-secret-value --secret-id <secret-name> --query SecretString --output text | jq -r '.password'

# ============================================
# STEP 3: Set connection string
# ============================================

export STAGING_DATABASE_URL="postgresql://postgres:YourPassword@endpoint:5432/ninja?sslmode=require"

# Test connection
npx prisma db execute --stdin --url "$STAGING_DATABASE_URL" <<< "SELECT current_database();"

# ============================================
# STEP 4: Check migration status
# ============================================

npx prisma db execute --stdin --url "$STAGING_DATABASE_URL" <<'EOF'
SELECT migration_name, finished_at
FROM "_prisma_migrations"
ORDER BY started_at DESC
LIMIT 5;
EOF

# Look for: 20260216054800_fix_acr_schema_conflicts

# ============================================
# STEP 5: Run quick health check
# ============================================

npx prisma db execute --file quick_staging_check.sql --url "$STAGING_DATABASE_URL"

# ============================================
# STEP 6: If quick check passes, run full verification
# ============================================

# Create version without \echo
grep -v '^\\echo' STAGING_VERIFICATION.sql > STAGING_VERIFICATION_NOECHO.sql

# Run full verification
npx prisma db execute --file STAGING_VERIFICATION_NOECHO.sql --url "$STAGING_DATABASE_URL"

# ============================================
# STEP 7: Test application functionality
# ============================================

# Navigate to staging app URL and test:
# 1. Create a new ACR job
# 2. Verify it completes successfully
# 3. Check CriterionChangeLog has new entries
# 4. Verify no errors in application logs

# ============================================
# STEP 8: Monitor for 30 minutes
# ============================================

# Check CloudWatch Logs for errors
aws logs tail /aws/rds/instance/<your-db>/postgresql --follow

# Or application logs
aws logs tail <your-app-log-group> --follow --filter-pattern "ERROR"
```

---

## ✅ Success Criteria

After running verification, you should see:

- ✅ Migration applied successfully
- ✅ All 7 health checks PASS
- ✅ 0 NULL `acrJobId` values
- ✅ Archive table exists (may have 0 records if no orphaned data)
- ✅ All unique constraints created
- ✅ No duplicate records
- ✅ ACR workflow works in UI

---

## 📞 Quick Reference

### Connection String Format
```
postgresql://USERNAME:PASSWORD@ENDPOINT:5432/DATABASE?sslmode=require
```

### Common AWS CLI Commands
```bash
# List RDS instances
aws rds describe-db-instances --query 'DBInstances[*].[DBInstanceIdentifier,Endpoint.Address]' --output table

# Get secret
aws secretsmanager get-secret-value --secret-id <name> --query SecretString --output text

# Check security group
aws ec2 describe-security-groups --group-ids <sg-id>
```

### Prisma Quick Test
```bash
npx prisma db execute --stdin --url "$STAGING_DATABASE_URL" <<< "SELECT 1;"
```

---

## 🎯 Next Steps After Verification

**If all checks pass:**
1. ✅ Mark staging deployment as successful
2. ✅ Monitor for 24 hours
3. ✅ When ready, can repeat for production (when you have prod env)

**If any checks fail:**
1. ❌ Document the failed check
2. ❌ Check application logs for errors
3. ❌ Consider running ROLLBACK.sql if critical
4. ❌ Report findings and investigate

---

**Need Help?**
- Can't find RDS endpoint? → Check CloudFormation/Terraform outputs
- Can't connect? → Check security groups and VPC settings
- Queries failing? → Check if migration actually deployed
