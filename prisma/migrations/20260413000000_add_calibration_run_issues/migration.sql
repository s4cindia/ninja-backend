-- AlterTable: Add pagesReviewed and completionNotes to CalibrationRun
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'CalibrationRun' AND column_name = 'pagesReviewed'
  ) THEN
    ALTER TABLE "CalibrationRun" ADD COLUMN "pagesReviewed" INTEGER;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'CalibrationRun' AND column_name = 'completionNotes'
  ) THEN
    ALTER TABLE "CalibrationRun" ADD COLUMN "completionNotes" TEXT;
  END IF;
END $$;

-- CreateEnum: RunIssueCategory
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RunIssueCategory') THEN
    CREATE TYPE "RunIssueCategory" AS ENUM (
      'PAGE_ALIGNMENT_MISMATCH',
      'INSUFFICIENT_JOINT_COVERAGE',
      'LIMITED_ZONE_COVERAGE',
      'UNEQUAL_EXTRACTOR_COVERAGE',
      'SINGLE_EXTRACTOR_ONLY',
      'ZONE_CONTENT_DIVERGENCE',
      'COMPLETED_WITH_REDUCED_SCOPE',
      'OTHER'
    );
  END IF;
END $$;

-- CreateTable: CalibrationRunIssue
CREATE TABLE IF NOT EXISTS "CalibrationRunIssue" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "category" "RunIssueCategory" NOT NULL,
  "pagesAffected" INTEGER,
  "description" TEXT NOT NULL,
  "blocking" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CalibrationRunIssue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CalibrationRunIssue_runId_idx" ON "CalibrationRunIssue"("runId");
CREATE INDEX IF NOT EXISTS "CalibrationRunIssue_category_idx" ON "CalibrationRunIssue"("category");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'CalibrationRunIssue_runId_fkey'
  ) THEN
    ALTER TABLE "CalibrationRunIssue"
      ADD CONSTRAINT "CalibrationRunIssue_runId_fkey"
      FOREIGN KEY ("runId") REFERENCES "CalibrationRun"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
