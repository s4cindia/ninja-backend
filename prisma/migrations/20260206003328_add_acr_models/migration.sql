-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "batchSourceJobIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "isBatchAcr" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "AcrJob" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "edition" TEXT NOT NULL DEFAULT 'VPAT2.5-INT',
    "documentTitle" TEXT,
    "status" TEXT NOT NULL DEFAULT 'in_progress',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AcrJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AcrCriterionReview" (
    "id" TEXT NOT NULL,
    "acrJobId" TEXT NOT NULL,
    "criterionId" TEXT NOT NULL,
    "criterionNumber" TEXT NOT NULL,
    "criterionName" TEXT NOT NULL,
    "level" TEXT,
    "confidence" INTEGER NOT NULL DEFAULT 0,
    "aiStatus" TEXT,
    "evidence" JSONB,
    "conformanceLevel" TEXT,
    "reviewerNotes" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AcrCriterionReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AcrJob_jobId_idx" ON "AcrJob"("jobId");

-- CreateIndex
CREATE INDEX "AcrJob_tenantId_idx" ON "AcrJob"("tenantId");

-- CreateIndex
CREATE INDEX "AcrJob_userId_idx" ON "AcrJob"("userId");

-- CreateIndex
CREATE INDEX "AcrJob_status_idx" ON "AcrJob"("status");

-- CreateIndex
CREATE INDEX "AcrCriterionReview_acrJobId_idx" ON "AcrCriterionReview"("acrJobId");

-- CreateIndex
CREATE INDEX "AcrCriterionReview_criterionId_idx" ON "AcrCriterionReview"("criterionId");

-- CreateIndex
CREATE INDEX "AcrCriterionReview_acrJobId_criterionId_idx" ON "AcrCriterionReview"("acrJobId", "criterionId");

-- AddForeignKey
ALTER TABLE "AcrCriterionReview" ADD CONSTRAINT "AcrCriterionReview_acrJobId_fkey" FOREIGN KEY ("acrJobId") REFERENCES "AcrJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
