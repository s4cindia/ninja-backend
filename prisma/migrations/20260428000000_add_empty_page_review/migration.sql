-- CreateEnum: EmptyPageCategory
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EmptyPageCategory') THEN
    CREATE TYPE "EmptyPageCategory" AS ENUM (
      'LEGIT_EMPTY',
      'DETECTION_FAILURE',
      'UNSURE'
    );
  END IF;
END $$;

-- CreateTable: EmptyPageReview
-- Note: SQL-level DEFAULT gen_random_uuid()::text mirrors the pattern used in
-- prior migrations (e.g. 20260413000000_add_calibration_run_issues) so that
-- raw-SQL inserts or Prisma versions that do not auto-fill @default(uuid())
-- still satisfy the NOT NULL constraint.
CREATE TABLE IF NOT EXISTS "EmptyPageReview" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "calibrationRunId" TEXT NOT NULL,
  "pageNumber" INTEGER NOT NULL,
  "category" "EmptyPageCategory" NOT NULL,
  "pageType" TEXT NOT NULL,
  "expectedContent" TEXT,
  "notes" TEXT,
  "annotatorId" TEXT NOT NULL,
  "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "EmptyPageReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "EmptyPageReview_calibrationRunId_pageNumber_key" ON "EmptyPageReview"("calibrationRunId", "pageNumber");
CREATE INDEX IF NOT EXISTS "EmptyPageReview_calibrationRunId_idx" ON "EmptyPageReview"("calibrationRunId");
CREATE INDEX IF NOT EXISTS "EmptyPageReview_annotatorId_idx" ON "EmptyPageReview"("annotatorId");

-- AddForeignKey: EmptyPageReview -> CalibrationRun
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'EmptyPageReview_calibrationRunId_fkey'
  ) THEN
    ALTER TABLE "EmptyPageReview"
      ADD CONSTRAINT "EmptyPageReview_calibrationRunId_fkey"
      FOREIGN KEY ("calibrationRunId") REFERENCES "CalibrationRun"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey: EmptyPageReview -> User
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'EmptyPageReview_annotatorId_fkey'
  ) THEN
    ALTER TABLE "EmptyPageReview"
      ADD CONSTRAINT "EmptyPageReview_annotatorId_fkey"
      FOREIGN KEY ("annotatorId") REFERENCES "User"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
