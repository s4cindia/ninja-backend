-- CreateEnum (idempotent - check if exists first)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ChangeStatus') THEN
        CREATE TYPE "ChangeStatus" AS ENUM ('APPLIED', 'REJECTED', 'REVERTED', 'FAILED', 'SKIPPED');
    END IF;
END$$;

-- CreateTable (idempotent)
CREATE TABLE IF NOT EXISTS "RemediationChange" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "taskId" TEXT,
    "changeNumber" INTEGER NOT NULL,
    "issueId" TEXT,
    "ruleId" TEXT,
    "filePath" TEXT NOT NULL,
    "elementXPath" TEXT,
    "lineNumber" INTEGER,
    "changeType" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "beforeContent" TEXT,
    "afterContent" TEXT,
    "contextBefore" TEXT,
    "contextAfter" TEXT,
    "severity" TEXT,
    "wcagCriteria" TEXT,
    "wcagLevel" TEXT,
    "status" "ChangeStatus" NOT NULL DEFAULT 'APPLIED',
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedBy" TEXT,

    CONSTRAINT "RemediationChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable (idempotent)
CREATE TABLE IF NOT EXISTS "ComparisonReport" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "totalChanges" INTEGER NOT NULL,
    "appliedCount" INTEGER NOT NULL,
    "rejectedCount" INTEGER NOT NULL,
    "skippedCount" INTEGER NOT NULL,
    "failedCount" INTEGER NOT NULL,
    "reportData" JSONB,
    "pdfUrl" TEXT,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "generatedBy" TEXT,

    CONSTRAINT "ComparisonReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (idempotent)
CREATE UNIQUE INDEX IF NOT EXISTS "RemediationChange_jobId_changeNumber_key" ON "RemediationChange"("jobId", "changeNumber");

-- CreateIndex (idempotent)
CREATE INDEX IF NOT EXISTS "RemediationChange_jobId_idx" ON "RemediationChange"("jobId");

-- CreateIndex (idempotent)
CREATE INDEX IF NOT EXISTS "RemediationChange_status_idx" ON "RemediationChange"("status");

-- CreateIndex (idempotent)
CREATE UNIQUE INDEX IF NOT EXISTS "ComparisonReport_jobId_key" ON "ComparisonReport"("jobId");

-- CreateIndex (idempotent)
CREATE INDEX IF NOT EXISTS "ComparisonReport_jobId_idx" ON "ComparisonReport"("jobId");

-- AddForeignKey (idempotent)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RemediationChange_jobId_fkey') THEN
        ALTER TABLE "RemediationChange" ADD CONSTRAINT "RemediationChange_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END$$;

-- AddForeignKey (idempotent)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ComparisonReport_jobId_fkey') THEN
        ALTER TABLE "ComparisonReport" ADD CONSTRAINT "ComparisonReport_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END$$;
