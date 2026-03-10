-- CreateTable
CREATE TABLE IF NOT EXISTS "AiAnalysis" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "suggestionType" TEXT NOT NULL,
    "value" TEXT,
    "guidance" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL,
    "rationale" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "applyMode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AiAnalysis_jobId_issueId_key'
  ) THEN
    ALTER TABLE "AiAnalysis" ADD CONSTRAINT "AiAnalysis_jobId_issueId_key" UNIQUE ("jobId", "issueId");
  END IF;
END $$;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AiAnalysis_jobId_idx" ON "AiAnalysis"("jobId");
