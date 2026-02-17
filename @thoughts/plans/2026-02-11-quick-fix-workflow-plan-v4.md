# Quick-Fix Workflow Implementation Plan - Version 4

**Date:** 2026-02-11
**Plan Version:** 4 of 5 (iterative refinement)
**Previous Version:** `2026-02-11-quick-fix-workflow-plan-v3.md`
**Changes:** Added deployment strategy, monitoring, database migrations, admin tools

---

## Database Migration Strategy

### Migration 001: Create QuickFixSession and QuickFixTask Tables

**File:** `prisma/migrations/YYYYMMDD_create_quick_fix_tables/migration.sql`

```sql
-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'PAUSED', 'COMPLETED', 'CANCELLED', 'STALE');

-- CreateEnum
CREATE TYPE "IssueType" AS ENUM ('ALT_TEXT', 'TABLE_HEADER', 'FORM_LABEL', 'LINK_TEXT', 'HEADING', 'LIST_STRUCTURE');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('PENDING', 'COMPLETED', 'SKIPPED');

-- CreateTable
CREATE TABLE "QuickFixSession" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "totalIssues" INTEGER NOT NULL,
    "completedIssues" INTEGER NOT NULL DEFAULT 0,
    "skippedIssues" INTEGER NOT NULL DEFAULT 0,
    "currentIndex" INTEGER NOT NULL DEFAULT 0,
    "status" "SessionStatus" NOT NULL DEFAULT 'PENDING',
    "filters" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuickFixSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuickFixTask" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "orderIndex" INTEGER NOT NULL,
    "issueCode" TEXT NOT NULL,
    "issueType" "IssueType" NOT NULL,
    "description" TEXT NOT NULL,
    "pageNumber" INTEGER,
    "elementPath" TEXT,
    "context" JSONB,
    "status" "TaskStatus" NOT NULL DEFAULT 'PENDING',
    "fixData" JSONB,
    "fixHistory" JSONB,
    "aiSuggestion" JSONB,
    "submittedAt" TIMESTAMP(3),
    "skippedAt" TIMESTAMP(3),
    "skippedReason" TEXT,

    CONSTRAINT "QuickFixTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QuickFixSession_jobId_idx" ON "QuickFixSession"("jobId");

-- CreateIndex
CREATE INDEX "QuickFixSession_userId_idx" ON "QuickFixSession"("userId");

-- CreateIndex
CREATE INDEX "QuickFixSession_status_idx" ON "QuickFixSession"("status");

-- CreateIndex
CREATE INDEX "QuickFixSession_lastActiveAt_idx" ON "QuickFixSession"("lastActiveAt");

-- CreateIndex
CREATE UNIQUE INDEX "QuickFixSession_jobId_userId_key" ON "QuickFixSession"("jobId", "userId");

-- CreateIndex
CREATE INDEX "QuickFixTask_sessionId_idx" ON "QuickFixTask"("sessionId");

-- CreateIndex
CREATE INDEX "QuickFixTask_sessionId_orderIndex_idx" ON "QuickFixTask"("sessionId", "orderIndex");

-- CreateIndex
CREATE INDEX "QuickFixTask_status_idx" ON "QuickFixTask"("status");

-- CreateIndex
CREATE UNIQUE INDEX "QuickFixTask_sessionId_taskId_key" ON "QuickFixTask"("sessionId", "taskId");

-- AddForeignKey
ALTER TABLE "QuickFixSession" ADD CONSTRAINT "QuickFixSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuickFixSession" ADD CONSTRAINT "QuickFixSession_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuickFixTask" ADD CONSTRAINT "QuickFixTask_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "QuickFixSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

### Migration 002: Create QuickFixTemplate Table

```sql
-- CreateTable
CREATE TABLE "QuickFixTemplate" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "issueType" "IssueType" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "template" JSONB NOT NULL,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuickFixTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QuickFixTemplate_userId_idx" ON "QuickFixTemplate"("userId");

-- CreateIndex
CREATE INDEX "QuickFixTemplate_issueType_idx" ON "QuickFixTemplate"("issueType");

-- CreateIndex
CREATE INDEX "QuickFixTemplate_tenantId_idx" ON "QuickFixTemplate"("tenantId");

-- AddForeignKey
ALTER TABLE "QuickFixTemplate" ADD CONSTRAINT "QuickFixTemplate_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
```

### Migration Rollback Strategy

**Rollback script for Migration 001:**
```sql
-- Drop foreign keys
ALTER TABLE "QuickFixTask" DROP CONSTRAINT "QuickFixTask_sessionId_fkey";
ALTER TABLE "QuickFixSession" DROP CONSTRAINT "QuickFixSession_jobId_fkey";
ALTER TABLE "QuickFixSession" DROP CONSTRAINT "QuickFixSession_userId_fkey";

-- Drop tables
DROP TABLE "QuickFixTask";
DROP TABLE "QuickFixSession";

-- Drop enums
DROP TYPE "TaskStatus";
DROP TYPE "IssueType";
DROP TYPE "SessionStatus";
```

---

## Deployment Strategy

### Environment Configuration

**Development:**
```env
NODE_ENV=development
DATABASE_URL=postgresql://localhost:5432/ninja_dev
REDIS_URL=redis://localhost:6379
FRONTEND_URL=http://localhost:5173
AI_SERVICE_ENABLED=true
GEMINI_API_KEY=<dev_key>
LOG_LEVEL=debug
```

**Staging:**
```env
NODE_ENV=staging
DATABASE_URL=<staging_db_url>
REDIS_URL=<staging_redis_url>
FRONTEND_URL=https://staging.ninja-a11y.com
AI_SERVICE_ENABLED=true
GEMINI_API_KEY=<staging_key>
LOG_LEVEL=info
SENTRY_DSN=<sentry_dsn>
```

**Production:**
```env
NODE_ENV=production
DATABASE_URL=<production_db_url>
REDIS_URL=<production_redis_url>
FRONTEND_URL=https://app.ninja-a11y.com
AI_SERVICE_ENABLED=true
GEMINI_API_KEY=<production_key>
LOG_LEVEL=warn
SENTRY_DSN=<sentry_dsn>
ERROR_TRACKING_ENABLED=true
```

### Docker Configuration

**Backend Dockerfile:**
```dockerfile
FROM node:18-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/

# Install dependencies
RUN npm ci --only=production

# Copy source
COPY . .

# Build TypeScript
RUN npm run build

# Generate Prisma client
RUN npx prisma generate

# ---

FROM node:18-alpine

WORKDIR /app

# Copy from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package*.json ./

# Increase Node.js memory limit for large PDFs
ENV NODE_OPTIONS="--max-old-space-size=8192"

EXPOSE 5000

CMD ["npm", "start"]
```

**Docker Compose (Development):**
```yaml
version: '3.8'

services:
  postgres:
    image: postgres:15-alpine
    environment:
      POSTGRES_USER: ninja
      POSTGRES_PASSWORD: ninja_dev
      POSTGRES_DB: ninja_dev
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data

  backend:
    build: .
    ports:
      - "5000:5000"
    environment:
      - DATABASE_URL=postgresql://ninja:ninja_dev@postgres:5432/ninja_dev
      - REDIS_URL=redis://redis:6379
    depends_on:
      - postgres
      - redis
    volumes:
      - ./uploads:/app/uploads

volumes:
  postgres_data:
  redis_data:
```

### CI/CD Pipeline (GitHub Actions)

**`.github/workflows/deploy.yml`:**
```yaml
name: Deploy Quick-Fix Workflow

on:
  push:
    branches:
      - main
    paths:
      - 'src/services/quick-fix/**'
      - 'src/controllers/quick-fix/**'
      - 'prisma/migrations/**'

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'

      - name: Install dependencies
        run: npm ci

      - name: Run linter
        run: npm run lint

      - name: Run unit tests
        run: npm run test:unit

      - name: Run integration tests
        run: npm run test:integration

  migrate:
    runs-on: ubuntu-latest
    needs: test
    steps:
      - uses: actions/checkout@v3

      - name: Run database migrations
        run: |
          npx prisma migrate deploy
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}

  deploy:
    runs-on: ubuntu-latest
    needs: migrate
    steps:
      - uses: actions/checkout@v3

      - name: Build Docker image
        run: docker build -t ninja-backend:${{ github.sha }} .

      - name: Push to registry
        run: |
          docker tag ninja-backend:${{ github.sha }} ${{ secrets.DOCKER_REGISTRY }}/ninja-backend:latest
          docker push ${{ secrets.DOCKER_REGISTRY }}/ninja-backend:latest

      - name: Deploy to production
        run: |
          # Deploy using your deployment tool (Kubernetes, ECS, etc.)
          kubectl set image deployment/ninja-backend ninja-backend=${{ secrets.DOCKER_REGISTRY }}/ninja-backend:latest
```

---

## Monitoring and Observability

### Logging Strategy

**Structured Logging with Winston:**
```typescript
import winston from 'winston';

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'quick-fix-workflow' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    }),
    new winston.transports.File({
      filename: 'logs/quick-fix-error.log',
      level: 'error',
    }),
    new winston.transports.File({
      filename: 'logs/quick-fix-combined.log',
    }),
  ],
});

// Log session events
logger.info('Quick-fix session started', {
  sessionId,
  jobId,
  userId,
  totalIssues,
});

logger.info('Issue fixed', {
  sessionId,
  taskId,
  issueType,
  timeToFix: Date.now() - startTime,
});

logger.error('Failed to apply fixes', {
  sessionId,
  error: error.message,
  stack: error.stack,
});
```

### Metrics Collection (Prometheus)

**Backend metrics endpoint:**
```typescript
import promClient from 'prom-client';

const register = new promClient.Registry();

// Default metrics
promClient.collectDefaultMetrics({ register });

// Custom metrics
const sessionCounter = new promClient.Counter({
  name: 'quick_fix_sessions_total',
  help: 'Total number of quick-fix sessions created',
  labelNames: ['status'],
});

const issueFixCounter = new promClient.Counter({
  name: 'quick_fix_issues_fixed_total',
  help: 'Total number of issues fixed',
  labelNames: ['issueType'],
});

const sessionDurationHistogram = new promClient.Histogram({
  name: 'quick_fix_session_duration_seconds',
  help: 'Duration of quick-fix sessions',
  buckets: [60, 300, 600, 1800, 3600], // 1m, 5m, 10m, 30m, 1h
});

const aiSuggestionDurationHistogram = new promClient.Histogram({
  name: 'quick_fix_ai_suggestion_duration_seconds',
  help: 'Duration of AI suggestion generation',
  buckets: [0.5, 1, 2, 5, 10],
});

register.registerMetric(sessionCounter);
register.registerMetric(issueFixCounter);
register.registerMetric(sessionDurationHistogram);
register.registerMetric(aiSuggestionDurationHistogram);

// Metrics endpoint
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});
```

### Error Tracking (Sentry)

```typescript
import * as Sentry from '@sentry/node';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
  tracesSampleRate: 0.1,
  beforeSend(event, hint) {
    // Don't send sensitive data
    if (event.request) {
      delete event.request.cookies;
      delete event.request.headers?.authorization;
    }
    return event;
  },
});

// Capture errors with context
Sentry.captureException(error, {
  tags: {
    feature: 'quick-fix-workflow',
    sessionId,
  },
  extra: {
    jobId,
    userId,
    issueType,
  },
});
```

### Dashboard (Grafana)

**Quick-Fix Workflow Dashboard:**
- Sessions created (counter)
- Active sessions (gauge)
- Issues fixed by type (pie chart)
- Session completion rate (%)
- Average time per issue (histogram)
- AI suggestion success rate (%)
- Error rate (counter)
- API response times (histogram)

---

## Admin Tools

### Session Management CLI

**File:** `src/cli/quick-fix-admin.ts`

```typescript
import { Command } from 'commander';
import { PrismaClient } from '@prisma/client';

const program = new Command();
const prisma = new PrismaClient();

program
  .name('quick-fix-admin')
  .description('Quick-Fix Workflow Administration Tool')
  .version('1.0.0');

// List sessions
program
  .command('list')
  .description('List all sessions')
  .option('-s, --status <status>', 'Filter by status')
  .option('-u, --user <userId>', 'Filter by user ID')
  .option('-l, --limit <number>', 'Limit results', '20')
  .action(async (options) => {
    const sessions = await prisma.quickFixSession.findMany({
      where: {
        status: options.status,
        userId: options.user,
      },
      take: parseInt(options.limit),
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { email: true } },
        job: { select: { type: true } },
      },
    });

    console.table(
      sessions.map((s) => ({
        id: s.id,
        user: s.user.email,
        status: s.status,
        progress: `${s.completedIssues}/${s.totalIssues}`,
        created: s.createdAt.toISOString(),
      }))
    );
  });

// Show session details
program
  .command('show <sessionId>')
  .description('Show session details')
  .action(async (sessionId) => {
    const session = await prisma.quickFixSession.findUnique({
      where: { id: sessionId },
      include: {
        tasks: true,
        user: true,
      },
    });

    if (!session) {
      console.error('Session not found');
      return;
    }

    console.log('Session Details:');
    console.log(JSON.stringify(session, null, 2));
  });

// Delete stale sessions
program
  .command('cleanup')
  .description('Delete stale sessions')
  .option('-d, --dry-run', 'Show what would be deleted')
  .action(async (options) => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const query = {
      where: {
        OR: [
          { status: 'COMPLETED', completedAt: { lt: thirtyDaysAgo } },
          { status: 'STALE', updatedAt: { lt: thirtyDaysAgo } },
        ],
      },
    };

    if (options.dryRun) {
      const count = await prisma.quickFixSession.count(query);
      console.log(`Would delete ${count} sessions`);
    } else {
      const result = await prisma.quickFixSession.deleteMany(query);
      console.log(`Deleted ${result.count} sessions`);
    }
  });

// Reset session
program
  .command('reset <sessionId>')
  .description('Reset session to start')
  .action(async (sessionId) => {
    await prisma.$transaction([
      prisma.quickFixTask.updateMany({
        where: { sessionId },
        data: { status: 'PENDING', fixData: null, submittedAt: null },
      }),
      prisma.quickFixSession.update({
        where: { id: sessionId },
        data: {
          status: 'PENDING',
          completedIssues: 0,
          skippedIssues: 0,
          currentIndex: 0,
        },
      }),
    ]);

    console.log('Session reset successfully');
  });

program.parse();
```

**Usage:**
```bash
# List all in-progress sessions
npm run quick-fix-admin list --status IN_PROGRESS

# Show session details
npm run quick-fix-admin show session_abc123

# Cleanup stale sessions (dry run)
npm run quick-fix-admin cleanup --dry-run

# Cleanup stale sessions (execute)
npm run quick-fix-admin cleanup

# Reset session
npm run quick-fix-admin reset session_abc123
```

---

## Backup and Recovery

### Database Backup Strategy

**Daily automated backups:**
```bash
#!/bin/bash
# backup.sh

TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_DIR="/backups/quick-fix"
DATABASE_URL="postgresql://user:pass@localhost:5432/ninja"

mkdir -p $BACKUP_DIR

# Backup QuickFixSession and QuickFixTask tables
pg_dump $DATABASE_URL \
  --table=QuickFixSession \
  --table=QuickFixTask \
  --table=QuickFixTemplate \
  --file=$BACKUP_DIR/quick_fix_$TIMESTAMP.sql

# Compress
gzip $BACKUP_DIR/quick_fix_$TIMESTAMP.sql

# Upload to S3
aws s3 cp $BACKUP_DIR/quick_fix_$TIMESTAMP.sql.gz s3://ninja-backups/quick-fix/

# Delete local backups older than 7 days
find $BACKUP_DIR -name "*.sql.gz" -mtime +7 -delete

echo "Backup completed: quick_fix_$TIMESTAMP.sql.gz"
```

### Disaster Recovery Plan

**RPO (Recovery Point Objective):** 1 hour
**RTO (Recovery Time Objective):** 4 hours

**Recovery Steps:**
1. Restore database from latest backup
2. Restore Redis state (if available)
3. Restart application servers
4. Verify session data integrity
5. Notify users of restored sessions

---

## Performance Optimization

### Database Query Optimization

**Use query optimization analyzer:**
```sql
-- Check slow queries
EXPLAIN ANALYZE
SELECT * FROM "QuickFixSession"
WHERE "userId" = 'user_123'
  AND "status" IN ('IN_PROGRESS', 'PAUSED')
ORDER BY "lastActiveAt" DESC;

-- Add covering index if needed
CREATE INDEX "QuickFixSession_userId_status_lastActiveAt_idx"
  ON "QuickFixSession"("userId", "status", "lastActiveAt" DESC);
```

**Connection pooling:**
```typescript
// Prisma connection pool configuration
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")

  // Connection pool settings
  connection_limit = 20
  pool_timeout = 10
  connect_timeout = 10
}
```

### Redis Caching Strategy

**Cache frequently accessed data:**
```typescript
// Cache session summary
const cacheKey = `quick-fix:session:${sessionId}:summary`;

// Get from cache
let summary = await redis.get(cacheKey);

if (!summary) {
  // Fetch from database
  summary = await prisma.quickFixSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      totalIssues: true,
      completedIssues: true,
      skippedIssues: true,
      status: true,
    },
  });

  // Store in cache (expires in 5 minutes)
  await redis.setex(cacheKey, 300, JSON.stringify(summary));
}

return JSON.parse(summary);
```

**Invalidate cache on updates:**
```typescript
// After submitting fix
await prisma.quickFixTask.update({ ... });

// Invalidate cache
await redis.del(`quick-fix:session:${sessionId}:summary`);
```

---

## User Documentation

### User Guide Outline

**1. Getting Started**
- What is Quick-Fix Workflow?
- When to use it?
- Prerequisites

**2. Starting a Session**
- From Remediation Plan page
- Resuming a paused session

**3. Fixing Issues**
- Navigation controls
- Issue types and forms
- Using AI suggestions
- Saving templates

**4. Advanced Features**
- Bulk apply
- Filtering issues
- Keyboard shortcuts

**5. Applying Fixes**
- Review before applying
- Download remediated PDF

**6. Troubleshooting**
- Common errors
- Session recovery
- Contact support

### Developer Documentation

**API Reference:**
- Endpoint documentation (OpenAPI/Swagger)
- Request/response examples
- Error codes
- Rate limits

**Integration Guide:**
- Embedding quick-fix in other apps
- Webhooks for completion events
- Custom issue types

---

## Security Hardening

### OWASP Top 10 Mitigations

**1. Injection:**
- Use Prisma (prevents SQL injection)
- Validate all inputs with Zod
- Sanitize user-provided text before rendering

**2. Broken Authentication:**
- Enforce JWT expiration (15 minutes)
- Require re-authentication for sensitive operations
- Implement session timeout

**3. Sensitive Data Exposure:**
- Don't log fixData (may contain sensitive text)
- Encrypt database backups
- Use HTTPS only

**4. XXE (XML External Entities):**
- Not applicable (no XML processing)

**5. Broken Access Control:**
- Verify session ownership (userId === req.user.id)
- Verify tenant isolation (tenantId === req.user.tenantId)
- Check task belongs to session before updates

**6. Security Misconfiguration:**
- Remove default credentials
- Disable directory listing
- Hide stack traces in production

**7. XSS (Cross-Site Scripting):**
- Sanitize alt text before rendering
- Use React (auto-escapes by default)
- Set Content-Security-Policy headers

**8. Insecure Deserialization:**
- Validate JSON schema before parsing
- Don't use eval() or Function()

**9. Using Components with Known Vulnerabilities:**
- Run `npm audit` regularly
- Use Dependabot for automatic updates

**10. Insufficient Logging & Monitoring:**
- Log all session actions
- Monitor for suspicious patterns
- Set up alerts for error spikes

---

## Changes from V3

### Added Sections
- Database migration scripts
- Docker configuration
- CI/CD pipeline
- Monitoring and observability
- Admin CLI tools
- Backup and recovery plan
- Performance optimization strategies
- User and developer documentation
- Security hardening checklist

---

## Next Steps for V5 (Final)

1. Consolidate all 4 versions
2. Create implementation checklist
3. Risk assessment and mitigation
4. Resource allocation (team, time, budget)
5. Success criteria and KPIs

---

**Plan Version 4 Complete**
**Next:** Create V5 (final consolidated plan) and prepare for Validate phase
