-- Repair migration for style validation tables
-- This fixes the incomplete state from the failed 20260222100000_feat_style_validation migration

-- Create missing enums (idempotent)
DO $$ BEGIN
  CREATE TYPE "StyleGuideType" AS ENUM ('CHICAGO', 'APA', 'MLA', 'AP', 'VANCOUVER', 'IEEE', 'NATURE', 'ELSEVIER', 'CUSTOM');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "StyleCategory" AS ENUM ('PUNCTUATION', 'CAPITALIZATION', 'NUMBERS', 'ABBREVIATIONS', 'HYPHENATION', 'SPELLING', 'GRAMMAR', 'TERMINOLOGY', 'FORMATTING', 'CITATIONS', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "StyleSeverity" AS ENUM ('ERROR', 'WARNING', 'SUGGESTION');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ViolationStatus" AS ENUM ('PENDING', 'FIXED', 'IGNORED', 'WONT_FIX', 'AUTO_FIXED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ViolationSource" AS ENUM ('AI', 'BUILT_IN', 'HOUSE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "HouseRuleType" AS ENUM ('TERMINOLOGY', 'PATTERN', 'CAPITALIZATION', 'PUNCTUATION');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Drop and recreate tables to ensure clean state
-- StyleValidationJob
DROP TABLE IF EXISTS "StyleValidationJob" CASCADE;
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

-- StyleViolation
DROP TABLE IF EXISTS "StyleViolation" CASCADE;
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

-- HouseRuleSet
DROP TABLE IF EXISTS "HouseRuleSet" CASCADE;
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

-- HouseStyleRule
DROP TABLE IF EXISTS "HouseStyleRule" CASCADE;
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

-- Create all indexes
CREATE INDEX "StyleValidationJob_tenantId_documentId_idx" ON "StyleValidationJob"("tenantId", "documentId");
CREATE INDEX "StyleValidationJob_status_idx" ON "StyleValidationJob"("status");
CREATE INDEX "StyleValidationJob_createdAt_idx" ON "StyleValidationJob"("createdAt");
CREATE INDEX "StyleViolation_documentId_idx" ON "StyleViolation"("documentId");
CREATE INDEX "StyleViolation_source_idx" ON "StyleViolation"("source");
CREATE INDEX "StyleViolation_jobId_idx" ON "StyleViolation"("jobId");
CREATE INDEX "StyleViolation_styleGuide_idx" ON "StyleViolation"("styleGuide");
CREATE INDEX "StyleViolation_category_idx" ON "StyleViolation"("category");
CREATE INDEX "StyleViolation_severity_idx" ON "StyleViolation"("severity");
CREATE INDEX "StyleViolation_status_idx" ON "StyleViolation"("status");
CREATE UNIQUE INDEX "HouseRuleSet_tenantId_name_key" ON "HouseRuleSet"("tenantId", "name");
CREATE INDEX "HouseRuleSet_tenantId_idx" ON "HouseRuleSet"("tenantId");
CREATE INDEX "HouseRuleSet_isActive_idx" ON "HouseRuleSet"("isActive");
CREATE INDEX "HouseStyleRule_tenantId_idx" ON "HouseStyleRule"("tenantId");
CREATE INDEX "HouseStyleRule_ruleSetId_idx" ON "HouseStyleRule"("ruleSetId");
CREATE INDEX "HouseStyleRule_category_idx" ON "HouseStyleRule"("category");
CREATE INDEX "HouseStyleRule_isActive_idx" ON "HouseStyleRule"("isActive");

-- Add foreign keys
ALTER TABLE "StyleValidationJob" ADD CONSTRAINT "StyleValidationJob_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StyleValidationJob" ADD CONSTRAINT "StyleValidationJob_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "EditorialDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StyleViolation" ADD CONSTRAINT "StyleViolation_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "EditorialDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StyleViolation" ADD CONSTRAINT "StyleViolation_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "StyleValidationJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "HouseRuleSet" ADD CONSTRAINT "HouseRuleSet_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HouseStyleRule" ADD CONSTRAINT "HouseStyleRule_ruleSetId_fkey" FOREIGN KEY ("ruleSetId") REFERENCES "HouseRuleSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HouseStyleRule" ADD CONSTRAINT "HouseStyleRule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
