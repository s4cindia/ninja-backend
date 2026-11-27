-- EPUB-from-certified-PDF, Phase 0 (B2): certification evidence.
--
-- 1. JobExternalPacReport gains updatedAt (confirm is an upsert, so
--    createdAt never moved on a re-upload) and remediatedSha256 (hash of
--    the remediated PDF the report was confirmed against). Existing rows
--    get updatedAt = createdAt, backfilled only in the same step that adds
--    the column so a re-run never overwrites a later upload's timestamp.
-- 2. New JobExternalAcrobatReport: uploaded Acrobat Pro accessibility
--    report + parsed (or operator-entered) counts.
--
-- Idempotent (guarded column adds, CREATE ... IF NOT EXISTS, guarded
-- ADD CONSTRAINT), matching this repo's hand-baselined-database convention.
-- Reverse with:
--   DROP TABLE "JobExternalAcrobatReport";
--   ALTER TABLE "JobExternalPacReport" DROP COLUMN "updatedAt", DROP COLUMN "remediatedSha256";

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'JobExternalPacReport'
      AND column_name = 'updatedAt'
  ) THEN
    ALTER TABLE "JobExternalPacReport"
      ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
    UPDATE "JobExternalPacReport" SET "updatedAt" = "createdAt";
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'JobExternalPacReport'
      AND column_name = 'remediatedSha256'
  ) THEN
    ALTER TABLE "JobExternalPacReport" ADD COLUMN "remediatedSha256" TEXT;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "JobExternalAcrobatReport" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "s3Key" TEXT NOT NULL,
    "originalFileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "passed" INTEGER,
    "failed" INTEGER,
    "needsManualCheck" INTEGER,
    "skipped" INTEGER,
    "passedManually" INTEGER,
    "failedManually" INTEGER,
    "countsSource" TEXT NOT NULL,
    "failedRules" JSONB,
    "parseWarnings" JSONB,
    "remediatedSha256" TEXT,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobExternalAcrobatReport_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "JobExternalAcrobatReport_jobId_key"
    ON "JobExternalAcrobatReport"("jobId");

CREATE INDEX IF NOT EXISTS "JobExternalAcrobatReport_jobId_idx"
    ON "JobExternalAcrobatReport"("jobId");

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'JobExternalAcrobatReport'
      AND constraint_name = 'JobExternalAcrobatReport_jobId_fkey'
  ) THEN
    ALTER TABLE "JobExternalAcrobatReport"
      ADD CONSTRAINT "JobExternalAcrobatReport_jobId_fkey"
      FOREIGN KEY ("jobId") REFERENCES "Job"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
