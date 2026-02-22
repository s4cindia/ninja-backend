-- CreateEnum
CREATE TYPE "StyleGuideType" AS ENUM ('CHICAGO', 'APA', 'MLA', 'AP', 'VANCOUVER', 'IEEE', 'NATURE', 'ELSEVIER', 'CUSTOM');

-- CreateEnum
CREATE TYPE "StyleCategory" AS ENUM ('PUNCTUATION', 'CAPITALIZATION', 'NUMBERS', 'ABBREVIATIONS', 'HYPHENATION', 'SPELLING', 'GRAMMAR', 'TERMINOLOGY', 'FORMATTING', 'CITATIONS', 'OTHER');

-- CreateEnum
CREATE TYPE "StyleSeverity" AS ENUM ('ERROR', 'WARNING', 'SUGGESTION');

-- CreateEnum
CREATE TYPE "ViolationStatus" AS ENUM ('PENDING', 'FIXED', 'IGNORED', 'WONT_FIX', 'AUTO_FIXED');

-- CreateEnum
CREATE TYPE "ViolationSource" AS ENUM ('AI', 'BUILT_IN', 'HOUSE');

-- CreateEnum
CREATE TYPE "HouseRuleType" AS ENUM ('TERMINOLOGY', 'PATTERN', 'CAPITALIZATION', 'PUNCTUATION');

-- CreateTable
CREATE TABLE "StyleValidationJob" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "ruleSetIds" TEXT[],
    "progress" INTEGER NOT NULL DEFAULT 0,
    "totalRules" INTEGER NOT NULL DEFAULT 0,
    "violationsFound" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "StyleValidationJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StyleViolation" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "jobId" TEXT,
    "styleGuide" "StyleGuideType" NOT NULL,
    "ruleId" TEXT,
    "ruleReference" TEXT,
    "category" "StyleCategory" NOT NULL,
    "severity" "StyleSeverity" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "pageNumber" INTEGER,
    "paragraphIndex" INTEGER,
    "startOffset" INTEGER NOT NULL,
    "endOffset" INTEGER NOT NULL,
    "originalText" TEXT NOT NULL,
    "suggestedText" TEXT,
    "status" "ViolationStatus" NOT NULL DEFAULT 'PENDING',
    "source" "ViolationSource" NOT NULL DEFAULT 'BUILT_IN',
    "appliedFix" TEXT,
    "fixedAt" TIMESTAMP(3),
    "fixedBy" TEXT,
    "ignoredReason" TEXT,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StyleViolation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HouseRuleSet" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "baseStyleGuide" "StyleGuideType",
    "source" TEXT NOT NULL DEFAULT 'manual',
    "sourceFile" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "HouseRuleSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HouseStyleRule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "ruleSetId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" "StyleCategory" NOT NULL,
    "ruleType" "HouseRuleType" NOT NULL,
    "pattern" TEXT,
    "preferredTerm" TEXT,
    "avoidTerms" TEXT[],
    "severity" "StyleSeverity" NOT NULL DEFAULT 'WARNING',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "baseStyleGuide" "StyleGuideType",
    "overridesRule" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "HouseStyleRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StyleValidationJob_tenantId_documentId_idx" ON "StyleValidationJob"("tenantId", "documentId");

-- CreateIndex
CREATE INDEX "StyleValidationJob_status_idx" ON "StyleValidationJob"("status");

-- CreateIndex
CREATE INDEX "StyleValidationJob_createdAt_idx" ON "StyleValidationJob"("createdAt");

-- CreateIndex
CREATE INDEX "StyleViolation_documentId_idx" ON "StyleViolation"("documentId");

-- CreateIndex
CREATE INDEX "StyleViolation_source_idx" ON "StyleViolation"("source");

-- CreateIndex
CREATE INDEX "StyleViolation_jobId_idx" ON "StyleViolation"("jobId");

-- CreateIndex
CREATE INDEX "StyleViolation_styleGuide_idx" ON "StyleViolation"("styleGuide");

-- CreateIndex
CREATE INDEX "StyleViolation_category_idx" ON "StyleViolation"("category");

-- CreateIndex
CREATE INDEX "StyleViolation_severity_idx" ON "StyleViolation"("severity");

-- CreateIndex
CREATE INDEX "StyleViolation_status_idx" ON "StyleViolation"("status");

-- CreateIndex
CREATE UNIQUE INDEX "HouseRuleSet_tenantId_name_key" ON "HouseRuleSet"("tenantId", "name");

-- CreateIndex
CREATE INDEX "HouseRuleSet_tenantId_idx" ON "HouseRuleSet"("tenantId");

-- CreateIndex
CREATE INDEX "HouseRuleSet_isActive_idx" ON "HouseRuleSet"("isActive");

-- CreateIndex
CREATE INDEX "HouseStyleRule_tenantId_idx" ON "HouseStyleRule"("tenantId");

-- CreateIndex
CREATE INDEX "HouseStyleRule_ruleSetId_idx" ON "HouseStyleRule"("ruleSetId");

-- CreateIndex
CREATE INDEX "HouseStyleRule_category_idx" ON "HouseStyleRule"("category");

-- CreateIndex
CREATE INDEX "HouseStyleRule_isActive_idx" ON "HouseStyleRule"("isActive");

-- AddForeignKey
ALTER TABLE "StyleValidationJob" ADD CONSTRAINT "StyleValidationJob_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StyleValidationJob" ADD CONSTRAINT "StyleValidationJob_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "EditorialDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StyleViolation" ADD CONSTRAINT "StyleViolation_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "EditorialDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StyleViolation" ADD CONSTRAINT "StyleViolation_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "StyleValidationJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HouseRuleSet" ADD CONSTRAINT "HouseRuleSet_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HouseStyleRule" ADD CONSTRAINT "HouseStyleRule_ruleSetId_fkey" FOREIGN KEY ("ruleSetId") REFERENCES "HouseRuleSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HouseStyleRule" ADD CONSTRAINT "HouseStyleRule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
