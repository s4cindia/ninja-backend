-- AlterTable
ALTER TABLE "AcrCriterionReview" ADD COLUMN     "isNotApplicable" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "naReason" TEXT,
ADD COLUMN     "naSuggestionData" JSONB,
ADD COLUMN     "verificationMethod" TEXT,
ADD COLUMN     "verificationNotes" TEXT,
ADD COLUMN     "verificationStatus" TEXT;

-- AlterTable
ALTER TABLE "AcrJob" ADD COLUMN     "applicableCriteria" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedBy" TEXT,
ADD COLUMN     "conformanceLevel" TEXT,
ADD COLUMN     "documentType" TEXT,
ADD COLUMN     "executiveSummary" TEXT,
ADD COLUMN     "failedCriteria" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "naCriteria" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "passedCriteria" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "totalCriteria" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "CriterionChangeLog" (
    "id" TEXT NOT NULL,
    "criterionReviewId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "criterionId" TEXT NOT NULL,
    "changedBy" TEXT NOT NULL,
    "changeType" TEXT NOT NULL,
    "previousValue" JSONB,
    "newValue" JSONB,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CriterionChangeLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CriterionChangeLog_criterionReviewId_idx" ON "CriterionChangeLog"("criterionReviewId");

-- CreateIndex
CREATE INDEX "CriterionChangeLog_jobId_idx" ON "CriterionChangeLog"("jobId");

-- CreateIndex
CREATE INDEX "CriterionChangeLog_criterionId_idx" ON "CriterionChangeLog"("criterionId");

-- CreateIndex
CREATE INDEX "CriterionChangeLog_createdAt_idx" ON "CriterionChangeLog"("createdAt");

-- AddForeignKey
ALTER TABLE "CriterionChangeLog" ADD CONSTRAINT "CriterionChangeLog_criterionReviewId_fkey" FOREIGN KEY ("criterionReviewId") REFERENCES "AcrCriterionReview"("id") ON DELETE CASCADE ON UPDATE CASCADE;
