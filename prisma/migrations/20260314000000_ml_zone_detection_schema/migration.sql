-- CreateTable: CorpusDocument
CREATE TABLE IF NOT EXISTS "CorpusDocument" (
    "id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "s3Path" TEXT NOT NULL,
    "publisher" TEXT,
    "contentType" TEXT,
    "pageCount" INTEGER,
    "language" TEXT NOT NULL DEFAULT 'en',
    "isScanned" BOOLEAN NOT NULL DEFAULT false,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CorpusDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable: ZoneBootstrapJob
CREATE TABLE IF NOT EXISTS "ZoneBootstrapJob" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "extractionMode" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ZoneBootstrapJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ZoneBootstrapJob_documentId_idx" ON "ZoneBootstrapJob"("documentId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ZoneBootstrapJob_status_idx" ON "ZoneBootstrapJob"("status");

-- CreateTable: CalibrationRun
CREATE TABLE IF NOT EXISTS "CalibrationRun" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "runDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "doclingZoneCount" INTEGER,
    "pdfxtZoneCount" INTEGER,
    "greenCount" INTEGER,
    "amberCount" INTEGER,
    "redCount" INTEGER,
    "summary" JSONB,
    "mapSnapshot" JSONB,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "type" TEXT NOT NULL DEFAULT 'CALIBRATION',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalibrationRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CalibrationRun_documentId_idx" ON "CalibrationRun"("documentId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CalibrationRun_completedAt_idx" ON "CalibrationRun"("completedAt");

-- AlterTable: Add ML pipeline fields to Zone
ALTER TABLE "Zone" ADD COLUMN IF NOT EXISTS "source" TEXT;
ALTER TABLE "Zone" ADD COLUMN IF NOT EXISTS "reconciliationBucket" TEXT;
ALTER TABLE "Zone" ADD COLUMN IF NOT EXISTS "doclingLabel" TEXT;
ALTER TABLE "Zone" ADD COLUMN IF NOT EXISTS "doclingConfidence" DOUBLE PRECISION;
ALTER TABLE "Zone" ADD COLUMN IF NOT EXISTS "pdfxtLabel" TEXT;
ALTER TABLE "Zone" ADD COLUMN IF NOT EXISTS "operatorVerified" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Zone" ADD COLUMN IF NOT EXISTS "operatorLabel" TEXT;
ALTER TABLE "Zone" ADD COLUMN IF NOT EXISTS "operatorBbox" JSONB;
ALTER TABLE "Zone" ADD COLUMN IF NOT EXISTS "verifiedAt" TIMESTAMP(3);
ALTER TABLE "Zone" ADD COLUMN IF NOT EXISTS "verifiedBy" TEXT;
ALTER TABLE "Zone" ADD COLUMN IF NOT EXISTS "isArtefact" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Zone" ADD COLUMN IF NOT EXISTS "bootstrapJobId" TEXT;
ALTER TABLE "Zone" ADD COLUMN IF NOT EXISTS "calibrationRunId" TEXT;

-- CreateIndex on Zone FK columns
CREATE INDEX IF NOT EXISTS "Zone_bootstrapJobId_idx" ON "Zone"("bootstrapJobId");
CREATE INDEX IF NOT EXISTS "Zone_calibrationRunId_idx" ON "Zone"("calibrationRunId");

-- AddForeignKey: ZoneBootstrapJob → CorpusDocument
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ZoneBootstrapJob_documentId_fkey') THEN
    ALTER TABLE "ZoneBootstrapJob" ADD CONSTRAINT "ZoneBootstrapJob_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "CorpusDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey: CalibrationRun → CorpusDocument
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CalibrationRun_documentId_fkey') THEN
    ALTER TABLE "CalibrationRun" ADD CONSTRAINT "CalibrationRun_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "CorpusDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey: Zone → ZoneBootstrapJob
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Zone_bootstrapJobId_fkey') THEN
    ALTER TABLE "Zone" ADD CONSTRAINT "Zone_bootstrapJobId_fkey" FOREIGN KEY ("bootstrapJobId") REFERENCES "ZoneBootstrapJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey: Zone → CalibrationRun
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Zone_calibrationRunId_fkey') THEN
    ALTER TABLE "Zone" ADD CONSTRAINT "Zone_calibrationRunId_fkey" FOREIGN KEY ("calibrationRunId") REFERENCES "CalibrationRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
