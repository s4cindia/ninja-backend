-- CreateTable
CREATE TABLE IF NOT EXISTS "TrainingRun" (
    "id" TEXT NOT NULL,
    "corpusExportS3Path" TEXT NOT NULL,
    "modelVariant" TEXT NOT NULL DEFAULT 'yolov8m',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "mapResult" JSONB,
    "evaluationResult" JSONB,
    "promotionRecommendation" TEXT,
    "weightsS3Path" TEXT,
    "onnxS3Path" TEXT,
    "corpusSnapshot" JSONB,
    "corpusSize" INTEGER,
    "epochs" INTEGER,
    "durationMs" INTEGER,
    "triggerType" TEXT NOT NULL DEFAULT 'MANUAL',
    "publisherId" TEXT,
    "promotedAt" TIMESTAMP(3),
    "promotedBy" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "TrainingRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TrainingRun_status_idx" ON "TrainingRun"("status");
CREATE INDEX IF NOT EXISTS "TrainingRun_completedAt_idx" ON "TrainingRun"("completedAt");
