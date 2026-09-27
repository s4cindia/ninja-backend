-- CreateTable: PdfBatch, PdfBatchItem, PdfAutoRemediationRun,
-- PdfConcurrencyBudget, PdfConcurrencyLease -- PDF batch processing
-- (batch-processing plan, Phase 1 foundation). Deliberately separate from
-- Batch/BatchFile (EPUB-shaped throughout) -- see schema.prisma's own
-- section comment for why. Idempotent (CREATE TABLE/INDEX IF NOT EXISTS,
-- CREATE TYPE guarded with duplicate_object, guarded ADD CONSTRAINT) so
-- this is safe to re-apply against a hand-baselined database. Reverse with:
--   DROP TABLE "PdfConcurrencyLease";
--   DROP TABLE "PdfConcurrencyBudget";
--   DROP TABLE "PdfAutoRemediationRun";
--   DROP TABLE "PdfBatchItem";
--   DROP TABLE "PdfBatch";
--   DROP TYPE "PdfBatchItemStatus";
--   DROP TYPE "PdfBatchStatus";

-- CreateEnum: PdfBatchStatus
DO $$ BEGIN
    CREATE TYPE "PdfBatchStatus" AS ENUM ('DRAFT', 'QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum: PdfBatchItemStatus
DO $$ BEGIN
    CREATE TYPE "PdfBatchItemStatus" AS ENUM ('UPLOADED', 'QUEUED_FOR_BUDGET', 'AUDITING', 'AUDITED', 'HELD_FOR_BUDGET', 'REMEDIATING', 'REMEDIATED', 'FAILED', 'SKIPPED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "PdfBatch" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "PdfBatchStatus" NOT NULL DEFAULT 'DRAFT',
    "totalFiles" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "PdfBatch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PdfBatchItem" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "fileSize" BIGINT NOT NULL,
    "mimeType" TEXT NOT NULL DEFAULT 'application/pdf',
    "storagePath" TEXT NOT NULL,
    "sourceFileId" TEXT NOT NULL,
    "status" "PdfBatchItemStatus" NOT NULL DEFAULT 'UPLOADED',
    "sizeWeightUnits" INTEGER NOT NULL,
    "pageCount" INTEGER,
    "effectiveWeightUnits" INTEGER,
    "activeLeaseId" TEXT,
    "auditJobId" TEXT,
    "auditScore" INTEGER,
    "issuesFound" INTEGER,
    "issuesAutoFixed" INTEGER,
    "issuesGuidanceOnly" INTEGER,
    "remediatedFilePath" TEXT,
    "error" TEXT,
    "errorDetails" JSONB,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "auditStartedAt" TIMESTAMP(3),
    "auditCompletedAt" TIMESTAMP(3),
    "remediationStartedAt" TIMESTAMP(3),
    "remediationCompletedAt" TIMESTAMP(3),

    CONSTRAINT "PdfBatchItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PdfAutoRemediationRun" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "batchItemId" TEXT,
    "autoMaxRounds" INTEGER NOT NULL DEFAULT 10,
    "autoCostLimitUsd" DOUBLE PRECISION NOT NULL DEFAULT 2.0,
    "autoRoundsCompleted" INTEGER NOT NULL DEFAULT 0,
    "autoCostSpentUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "autoStatus" TEXT,
    "autoStopReason" TEXT,
    "autoStartedAt" TIMESTAMP(3),
    "autoStoppedAt" TIMESTAMP(3),
    "autoStopRequested" BOOLEAN NOT NULL DEFAULT false,
    "autoColorContrastMode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PdfAutoRemediationRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PdfConcurrencyBudget" (
    "tenantId" TEXT NOT NULL,
    "totalUnits" INTEGER NOT NULL DEFAULT 10,
    "unitsInUse" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PdfConcurrencyBudget_pkey" PRIMARY KEY ("tenantId")
);

CREATE TABLE IF NOT EXISTS "PdfConcurrencyLease" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "batchItemId" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "weightUnits" INTEGER NOT NULL,
    "acquiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "heartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),

    CONSTRAINT "PdfConcurrencyLease_pkey" PRIMARY KEY ("id")
);

-- Indexes.
CREATE INDEX IF NOT EXISTS "PdfBatch_tenantId_status_idx" ON "PdfBatch"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "PdfBatch_createdAt_idx" ON "PdfBatch"("createdAt");

CREATE INDEX IF NOT EXISTS "PdfBatchItem_batchId_idx" ON "PdfBatchItem"("batchId");
CREATE INDEX IF NOT EXISTS "PdfBatchItem_status_idx" ON "PdfBatchItem"("status");
CREATE INDEX IF NOT EXISTS "PdfBatchItem_batchId_status_idx" ON "PdfBatchItem"("batchId", "status");

CREATE UNIQUE INDEX IF NOT EXISTS "PdfAutoRemediationRun_jobId_key" ON "PdfAutoRemediationRun"("jobId");

CREATE INDEX IF NOT EXISTS "PdfConcurrencyLease_batchItemId_idx" ON "PdfConcurrencyLease"("batchItemId");
CREATE INDEX IF NOT EXISTS "PdfConcurrencyLease_tenantId_releasedAt_idx" ON "PdfConcurrencyLease"("tenantId", "releasedAt");

-- Foreign keys (guarded so re-apply doesn't error). Scoped on
-- table_schema = current_schema() so an identically-named constraint in
-- another schema can't cause the ADD to be skipped.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'PdfBatch'
      AND constraint_name = 'PdfBatch_tenantId_fkey'
  ) THEN
    ALTER TABLE "PdfBatch"
      ADD CONSTRAINT "PdfBatch_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'PdfBatch'
      AND constraint_name = 'PdfBatch_userId_fkey'
  ) THEN
    ALTER TABLE "PdfBatch"
      ADD CONSTRAINT "PdfBatch_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'PdfBatchItem'
      AND constraint_name = 'PdfBatchItem_batchId_fkey'
  ) THEN
    ALTER TABLE "PdfBatchItem"
      ADD CONSTRAINT "PdfBatchItem_batchId_fkey"
      FOREIGN KEY ("batchId") REFERENCES "PdfBatch"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'PdfAutoRemediationRun'
      AND constraint_name = 'PdfAutoRemediationRun_jobId_fkey'
  ) THEN
    ALTER TABLE "PdfAutoRemediationRun"
      ADD CONSTRAINT "PdfAutoRemediationRun_jobId_fkey"
      FOREIGN KEY ("jobId") REFERENCES "Job"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
