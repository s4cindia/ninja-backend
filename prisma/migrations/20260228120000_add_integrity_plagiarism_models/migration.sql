-- CreateEnum
CREATE TYPE "IntegrityCheckType" AS ENUM ('FIGURE_REF', 'TABLE_REF', 'EQUATION_REF', 'BOX_REF', 'CITATION_REF', 'SECTION_NUMBERING', 'FIGURE_NUMBERING', 'TABLE_NUMBERING', 'EQUATION_NUMBERING', 'UNIT_CONSISTENCY', 'ABBREVIATION', 'CROSS_REF', 'DUPLICATE_CONTENT', 'HEADING_HIERARCHY', 'ALT_TEXT', 'TABLE_STRUCTURE', 'FOOTNOTE_REF', 'TOC_CONSISTENCY', 'ISBN_FORMAT', 'DOI_FORMAT', 'TERMINOLOGY');

-- CreateTable
CREATE TABLE "IntegrityCheckJob" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "checkTypes" "IntegrityCheckType"[],
    "progress" INTEGER NOT NULL DEFAULT 0,
    "totalChecks" INTEGER NOT NULL DEFAULT 0,
    "issuesFound" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrityCheckJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrityIssue" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "checkType" "IntegrityCheckType" NOT NULL,
    "severity" "StyleSeverity" NOT NULL DEFAULT 'WARNING',
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "startOffset" INTEGER,
    "endOffset" INTEGER,
    "originalText" TEXT,
    "expectedValue" TEXT,
    "actualValue" TEXT,
    "suggestedFix" TEXT,
    "context" TEXT,
    "status" "ViolationStatus" NOT NULL DEFAULT 'PENDING',
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrityIssue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IntegrityCheckJob_tenantId_idx" ON "IntegrityCheckJob"("tenantId");

-- CreateIndex
CREATE INDEX "IntegrityCheckJob_documentId_idx" ON "IntegrityCheckJob"("documentId");

-- CreateIndex
CREATE INDEX "IntegrityCheckJob_status_idx" ON "IntegrityCheckJob"("status");

-- CreateIndex
CREATE INDEX "IntegrityIssue_documentId_idx" ON "IntegrityIssue"("documentId");

-- CreateIndex
CREATE INDEX "IntegrityIssue_jobId_idx" ON "IntegrityIssue"("jobId");

-- CreateIndex
CREATE INDEX "IntegrityIssue_checkType_idx" ON "IntegrityIssue"("checkType");

-- CreateIndex
CREATE INDEX "IntegrityIssue_status_idx" ON "IntegrityIssue"("status");

-- AddForeignKey
ALTER TABLE "IntegrityCheckJob" ADD CONSTRAINT "IntegrityCheckJob_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrityCheckJob" ADD CONSTRAINT "IntegrityCheckJob_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "EditorialDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrityIssue" ADD CONSTRAINT "IntegrityIssue_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "EditorialDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrityIssue" ADD CONSTRAINT "IntegrityIssue_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "IntegrityCheckJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
