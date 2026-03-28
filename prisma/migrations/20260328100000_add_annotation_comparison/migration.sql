-- Create AnnotationComparison table
CREATE TABLE IF NOT EXISTS "AnnotationComparison" (
    "id" TEXT NOT NULL,
    "calibrationRunId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "totalZones" INTEGER NOT NULL DEFAULT 0,
    "comparableZones" INTEGER NOT NULL DEFAULT 0,
    "agreementCount" INTEGER NOT NULL DEFAULT 0,
    "disagreementCount" INTEGER NOT NULL DEFAULT 0,
    "agreementRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cohensKappa" DOUBLE PRECISION,
    "perTypeAccuracy" JSONB,
    "perBucketAccuracy" JSONB,
    "confidenceCalibration" JSONB,
    "commonMistakes" JSONB,
    "zoneDetails" JSONB,
    "durationMs" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AnnotationComparison_pkey" PRIMARY KEY ("id")
);

-- Add foreign key
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AnnotationComparison_calibrationRunId_fkey'
  ) THEN
    ALTER TABLE "AnnotationComparison"
      ADD CONSTRAINT "AnnotationComparison_calibrationRunId_fkey"
      FOREIGN KEY ("calibrationRunId") REFERENCES "CalibrationRun"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Add index
CREATE INDEX IF NOT EXISTS "AnnotationComparison_calibrationRunId_idx" ON "AnnotationComparison"("calibrationRunId");
