-- Add AI annotation fields to Zone
ALTER TABLE "Zone" ADD COLUMN IF NOT EXISTS "aiLabel" TEXT;
ALTER TABLE "Zone" ADD COLUMN IF NOT EXISTS "aiConfidence" DOUBLE PRECISION;
ALTER TABLE "Zone" ADD COLUMN IF NOT EXISTS "aiDecision" TEXT;
ALTER TABLE "Zone" ADD COLUMN IF NOT EXISTS "aiReason" TEXT;
ALTER TABLE "Zone" ADD COLUMN IF NOT EXISTS "aiModel" TEXT;
ALTER TABLE "Zone" ADD COLUMN IF NOT EXISTS "aiAnnotatedAt" TIMESTAMP(3);

-- Create AiAnnotationRun table
CREATE TABLE IF NOT EXISTS "AiAnnotationRun" (
    "id" TEXT NOT NULL,
    "calibrationRunId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "totalZones" INTEGER NOT NULL DEFAULT 0,
    "annotatedZones" INTEGER NOT NULL DEFAULT 0,
    "skippedZones" INTEGER NOT NULL DEFAULT 0,
    "confirmedCount" INTEGER NOT NULL DEFAULT 0,
    "correctedCount" INTEGER NOT NULL DEFAULT 0,
    "rejectedCount" INTEGER NOT NULL DEFAULT 0,
    "highConfCount" INTEGER NOT NULL DEFAULT 0,
    "medConfCount" INTEGER NOT NULL DEFAULT 0,
    "lowConfCount" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "estimatedCostUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "durationMs" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AiAnnotationRun_pkey" PRIMARY KEY ("id")
);

-- Add foreign key
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AiAnnotationRun_calibrationRunId_fkey'
  ) THEN
    ALTER TABLE "AiAnnotationRun"
      ADD CONSTRAINT "AiAnnotationRun_calibrationRunId_fkey"
      FOREIGN KEY ("calibrationRunId") REFERENCES "CalibrationRun"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Add index
CREATE INDEX IF NOT EXISTS "AiAnnotationRun_calibrationRunId_idx" ON "AiAnnotationRun"("calibrationRunId");
