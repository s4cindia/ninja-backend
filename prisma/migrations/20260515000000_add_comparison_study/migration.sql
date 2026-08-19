-- CreateTable: ComparisonTrial, RemediationSession — pdfxt-vs-Ninja
-- validation study. ComparisonTrial has no FK to CorpusDocument by
-- design: these documents must stay structurally outside the training
-- pipeline. RemediationSession is a structural twin of AnnotationSession,
-- keyed on jobId instead of calibrationRunId.
-- Idempotent (CREATE TABLE / INDEX IF NOT EXISTS + guarded ADD CONSTRAINT)
-- so the migration is safe to re-apply against a hand-baselined database.
-- Reverse with `DROP TABLE "RemediationSession"; DROP TABLE "ComparisonTrial";`.

CREATE TABLE IF NOT EXISTS "ComparisonTrial" (
    "id" TEXT NOT NULL,
    "sourceFileName" TEXT NOT NULL,
    "sourceS3Path" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,

    "ninjaJobId" TEXT,
    "ninjaActiveMs" INTEGER,
    "ninjaGpuCostUsd" DOUBLE PRECISION,
    "ninjaPacResult" JSONB,

    "pdfxtS3Path" TEXT,
    "pdfxtTimeMs" INTEGER,
    "pdfxtPageCount" INTEGER,
    "pdfxtCostUsd" DOUBLE PRECISION,
    "pdfxtPacResult" JSONB,

    "status" TEXT NOT NULL DEFAULT 'registered',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComparisonTrial_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "RemediationSession" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "activeMs" INTEGER NOT NULL DEFAULT 0,
    "idleMs" INTEGER NOT NULL DEFAULT 0,

    "issuesApplied" INTEGER NOT NULL DEFAULT 0,
    "suggestionsAccepted" INTEGER NOT NULL DEFAULT 0,
    "suggestionsRejected" INTEGER NOT NULL DEFAULT 0,
    "bulkApplyUsed" BOOLEAN NOT NULL DEFAULT false,

    "sessionLog" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RemediationSession_pkey" PRIMARY KEY ("id")
);

-- Indexes.
CREATE UNIQUE INDEX IF NOT EXISTS "ComparisonTrial_ninjaJobId_key"
    ON "ComparisonTrial"("ninjaJobId");
CREATE INDEX IF NOT EXISTS "ComparisonTrial_operatorId_idx"
    ON "ComparisonTrial"("operatorId");
CREATE INDEX IF NOT EXISTS "ComparisonTrial_status_idx"
    ON "ComparisonTrial"("status");
CREATE INDEX IF NOT EXISTS "ComparisonTrial_contentType_idx"
    ON "ComparisonTrial"("contentType");

CREATE INDEX IF NOT EXISTS "RemediationSession_jobId_idx"
    ON "RemediationSession"("jobId");
CREATE INDEX IF NOT EXISTS "RemediationSession_operatorId_idx"
    ON "RemediationSession"("operatorId");

-- Foreign keys (guarded so re-apply doesn't error). Scoped on
-- table_schema = current_schema() so an identically-named constraint
-- in another schema can't cause the ADD to be skipped.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'ComparisonTrial'
      AND constraint_name = 'ComparisonTrial_ninjaJobId_fkey'
  ) THEN
    ALTER TABLE "ComparisonTrial"
      ADD CONSTRAINT "ComparisonTrial_ninjaJobId_fkey"
      FOREIGN KEY ("ninjaJobId") REFERENCES "Job"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'RemediationSession'
      AND constraint_name = 'RemediationSession_jobId_fkey'
  ) THEN
    ALTER TABLE "RemediationSession"
      ADD CONSTRAINT "RemediationSession_jobId_fkey"
      FOREIGN KEY ("jobId") REFERENCES "Job"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
