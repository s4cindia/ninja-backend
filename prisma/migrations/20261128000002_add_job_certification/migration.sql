-- EPUB-from-certified-PDF, Phase 0 (B3a): JobCertification.
--
-- One row per certification of a PDF job's remediated file; at most one
-- ACTIVE (revokedAt IS NULL) row per job, enforced below by a partial
-- unique index (not expressible in schema.prisma, so it lives only here --
-- it closes the race where two concurrent certify requests both pass the
-- application check). History is kept by revoking, never deleting.
--
-- Idempotent (CREATE ... IF NOT EXISTS, guarded ADD CONSTRAINT), matching
-- this repo's hand-baselined-database convention.
-- Reverse with: DROP TABLE "JobCertification";

CREATE TABLE IF NOT EXISTS "JobCertification" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "pdfSha256" TEXT NOT NULL,
    "remediatedFileRef" TEXT NOT NULL,
    "certifiedById" TEXT NOT NULL,
    "certifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "allAcrobatChecksRun" BOOLEAN NOT NULL,
    "altTextReviewedEveryFigure" BOOLEAN NOT NULL,
    "readingOrderSpotChecked" BOOLEAN NOT NULL,
    "bookmarksAndTitleChecked" BOOLEAN NOT NULL,
    "acrobatNotes" TEXT,
    "acrobatReportId" TEXT NOT NULL,
    "acrobatReportS3Key" TEXT NOT NULL,
    "acrobatReportUpdatedAt" TIMESTAMP(3) NOT NULL,
    "acrobatFailed" INTEGER NOT NULL,
    "acrobatWaivers" JSONB NOT NULL,
    "pacReportId" TEXT NOT NULL,
    "pacReportS3Key" TEXT NOT NULL,
    "pacReportUpdatedAt" TIMESTAMP(3) NOT NULL,
    "pacFail" INTEGER NOT NULL,
    "pacPdfUaErrorsAttested" INTEGER NOT NULL,
    "pacWaivers" JSONB NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "revokedReason" TEXT,

    CONSTRAINT "JobCertification_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "JobCertification_jobId_idx"
    ON "JobCertification"("jobId");

CREATE INDEX IF NOT EXISTS "JobCertification_jobId_revokedAt_idx"
    ON "JobCertification"("jobId", "revokedAt");

-- At most one active certification per job.
CREATE UNIQUE INDEX IF NOT EXISTS "JobCertification_one_active_per_job"
    ON "JobCertification"("jobId") WHERE "revokedAt" IS NULL;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'JobCertification'
      AND constraint_name = 'JobCertification_jobId_fkey'
  ) THEN
    ALTER TABLE "JobCertification"
      ADD CONSTRAINT "JobCertification_jobId_fkey"
      FOREIGN KEY ("jobId") REFERENCES "Job"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
