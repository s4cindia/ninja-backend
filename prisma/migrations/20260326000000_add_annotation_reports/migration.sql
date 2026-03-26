-- AlterTable: Add correctionReason and decision to Zone
ALTER TABLE "Zone" ADD COLUMN IF NOT EXISTS "correctionReason" TEXT;
ALTER TABLE "Zone" ADD COLUMN IF NOT EXISTS "decision" TEXT;

-- CreateIndex: Zone(calibrationRunId, decision)
CREATE INDEX IF NOT EXISTS "Zone_calibrationRunId_decision_idx" ON "Zone"("calibrationRunId", "decision");

-- CreateTable: AnnotationSession
CREATE TABLE IF NOT EXISTS "AnnotationSession" (
    "id" TEXT NOT NULL,
    "calibrationRunId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "pageNumber" INTEGER,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "activeMs" INTEGER NOT NULL DEFAULT 0,
    "idleMs" INTEGER NOT NULL DEFAULT 0,
    "zonesReviewed" INTEGER NOT NULL DEFAULT 0,
    "zonesConfirmed" INTEGER NOT NULL DEFAULT 0,
    "zonesCorrected" INTEGER NOT NULL DEFAULT 0,
    "zonesRejected" INTEGER NOT NULL DEFAULT 0,
    "sessionLog" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnnotationSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndexes: AnnotationSession
CREATE INDEX IF NOT EXISTS "AnnotationSession_calibrationRunId_idx" ON "AnnotationSession"("calibrationRunId");
CREATE INDEX IF NOT EXISTS "AnnotationSession_operatorId_idx" ON "AnnotationSession"("operatorId");
CREATE INDEX IF NOT EXISTS "AnnotationSession_calibrationRunId_operatorId_idx" ON "AnnotationSession"("calibrationRunId", "operatorId");

-- AddForeignKey: AnnotationSession -> CalibrationRun
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'AnnotationSession_calibrationRunId_fkey'
  ) THEN
    ALTER TABLE "AnnotationSession" ADD CONSTRAINT "AnnotationSession_calibrationRunId_fkey"
      FOREIGN KEY ("calibrationRunId") REFERENCES "CalibrationRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- Backfill: Populate decision for existing verified zones
UPDATE "Zone" SET "decision" = 'REJECTED'
WHERE "operatorVerified" = true AND "isArtefact" = true AND "decision" IS NULL;

UPDATE "Zone" SET "decision" = 'CORRECTED'
WHERE "operatorVerified" = true AND "isArtefact" = false
  AND "operatorLabel" IS NOT NULL AND "operatorLabel" != "type"
  AND "decision" IS NULL;

UPDATE "Zone" SET "decision" = 'CONFIRMED'
WHERE "operatorVerified" = true AND "isArtefact" = false AND "decision" IS NULL;
