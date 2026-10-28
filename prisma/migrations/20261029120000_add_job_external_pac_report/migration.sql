-- CreateTable: JobExternalPacReport -- job-native counterpart to
-- ExternalPacReport (see that model's own doc comment). Same real,
-- external PAC-tool report upload capability, but for a regular PDF
-- Accessibility job that has no linked ComparisonTrial. Kept as a separate
-- table (not ExternalPacReport.trialId made optional-plus-jobId) so this
-- feature's blast radius stays isolated from Comparison Study's existing
-- data/code. Idempotent (CREATE TABLE/INDEX IF NOT EXISTS + guarded ADD
-- CONSTRAINT), matching this repo's hand-baselined-database convention.
-- Reverse with: `DROP TABLE "JobExternalPacReport";`.

CREATE TABLE IF NOT EXISTS "JobExternalPacReport" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "s3Key" TEXT NOT NULL,
    "originalFileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "pass" INTEGER,
    "fail" INTEGER,
    "untested" INTEGER,
    "humanRequired" INTEGER,
    "notApplicable" INTEGER,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobExternalPacReport_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "JobExternalPacReport_jobId_key"
    ON "JobExternalPacReport"("jobId");

CREATE INDEX IF NOT EXISTS "JobExternalPacReport_jobId_idx"
    ON "JobExternalPacReport"("jobId");

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'JobExternalPacReport'
      AND constraint_name = 'JobExternalPacReport_jobId_fkey'
  ) THEN
    ALTER TABLE "JobExternalPacReport"
      ADD CONSTRAINT "JobExternalPacReport_jobId_fkey"
      FOREIGN KEY ("jobId") REFERENCES "Job"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
