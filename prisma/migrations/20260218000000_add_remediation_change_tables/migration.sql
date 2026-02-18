-- CreateEnum
CREATE TYPE "ChangeStatus" AS ENUM ('APPLIED', 'REJECTED', 'REVERTED', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "RemediationChange" (
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

-- CreateTable
CREATE TABLE "ComparisonReport" (
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

-- CreateIndex
CREATE UNIQUE INDEX "RemediationChange_jobId_changeNumber_key" ON "RemediationChange"("jobId", "changeNumber");

-- CreateIndex
CREATE INDEX "RemediationChange_jobId_idx" ON "RemediationChange"("jobId");

-- CreateIndex
CREATE INDEX "RemediationChange_status_idx" ON "RemediationChange"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ComparisonReport_jobId_key" ON "ComparisonReport"("jobId");

-- CreateIndex
CREATE INDEX "ComparisonReport_jobId_idx" ON "ComparisonReport"("jobId");

-- AddForeignKey
ALTER TABLE "RemediationChange" ADD CONSTRAINT "RemediationChange_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComparisonReport" ADD CONSTRAINT "ComparisonReport_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
