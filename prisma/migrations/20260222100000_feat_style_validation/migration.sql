-- CreateEnum (idempotent)
DO $$ BEGIN
  CREATE TYPE "StyleGuideType" AS ENUM ('CHICAGO', 'APA', 'MLA', 'AP', 'VANCOUVER', 'IEEE', 'NATURE', 'ELSEVIER', 'CUSTOM');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum (idempotent)
DO $$ BEGIN
  CREATE TYPE "StyleCategory" AS ENUM ('PUNCTUATION', 'CAPITALIZATION', 'NUMBERS', 'ABBREVIATIONS', 'HYPHENATION', 'SPELLING', 'GRAMMAR', 'TERMINOLOGY', 'FORMATTING', 'CITATIONS', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum (idempotent)
DO $$ BEGIN
  CREATE TYPE "StyleSeverity" AS ENUM ('ERROR', 'WARNING', 'SUGGESTION');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum (idempotent)
DO $$ BEGIN
  CREATE TYPE "ViolationStatus" AS ENUM ('PENDING', 'FIXED', 'IGNORED', 'WONT_FIX', 'AUTO_FIXED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum (idempotent)
DO $$ BEGIN
  CREATE TYPE "ViolationSource" AS ENUM ('AI', 'BUILT_IN', 'HOUSE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum (idempotent)
DO $$ BEGIN
  CREATE TYPE "HouseRuleType" AS ENUM ('TERMINOLOGY', 'PATTERN', 'CAPITALIZATION', 'PUNCTUATION');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateTable (idempotent)
CREATE TABLE IF NOT EXISTS "StyleValidationJob" (
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

-- CreateTable (idempotent)
CREATE TABLE IF NOT EXISTS "StyleViolation" (
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

-- CreateTable (idempotent)
CREATE TABLE IF NOT EXISTS "HouseRuleSet" (
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

-- CreateTable (idempotent)
CREATE TABLE IF NOT EXISTS "HouseStyleRule" (
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

-- CreateIndex (idempotent)
CREATE INDEX IF NOT EXISTS "StyleValidationJob_tenantId_documentId_idx" ON "StyleValidationJob"("tenantId", "documentId");

-- CreateIndex (idempotent)
CREATE INDEX IF NOT EXISTS "StyleValidationJob_status_idx" ON "StyleValidationJob"("status");

-- CreateIndex (idempotent)
CREATE INDEX IF NOT EXISTS "StyleValidationJob_createdAt_idx" ON "StyleValidationJob"("createdAt");

-- CreateIndex (idempotent)
CREATE INDEX IF NOT EXISTS "StyleViolation_documentId_idx" ON "StyleViolation"("documentId");

-- CreateIndex (idempotent)
CREATE INDEX IF NOT EXISTS "StyleViolation_source_idx" ON "StyleViolation"("source");

-- CreateIndex (idempotent)
CREATE INDEX IF NOT EXISTS "StyleViolation_jobId_idx" ON "StyleViolation"("jobId");

-- CreateIndex (idempotent)
CREATE INDEX IF NOT EXISTS "StyleViolation_styleGuide_idx" ON "StyleViolation"("styleGuide");

-- CreateIndex (idempotent)
CREATE INDEX IF NOT EXISTS "StyleViolation_category_idx" ON "StyleViolation"("category");

-- CreateIndex (idempotent)
CREATE INDEX IF NOT EXISTS "StyleViolation_severity_idx" ON "StyleViolation"("severity");

-- CreateIndex (idempotent)
CREATE INDEX IF NOT EXISTS "StyleViolation_status_idx" ON "StyleViolation"("status");

-- CreateIndex (idempotent)
CREATE UNIQUE INDEX IF NOT EXISTS "HouseRuleSet_tenantId_name_key" ON "HouseRuleSet"("tenantId", "name");

-- CreateIndex (idempotent)
CREATE INDEX IF NOT EXISTS "HouseRuleSet_tenantId_idx" ON "HouseRuleSet"("tenantId");

-- CreateIndex (idempotent)
CREATE INDEX IF NOT EXISTS "HouseRuleSet_isActive_idx" ON "HouseRuleSet"("isActive");

-- CreateIndex (idempotent)
CREATE INDEX IF NOT EXISTS "HouseStyleRule_tenantId_idx" ON "HouseStyleRule"("tenantId");

-- CreateIndex (idempotent)
CREATE INDEX IF NOT EXISTS "HouseStyleRule_ruleSetId_idx" ON "HouseStyleRule"("ruleSetId");

-- CreateIndex (idempotent)
CREATE INDEX IF NOT EXISTS "HouseStyleRule_category_idx" ON "HouseStyleRule"("category");

-- CreateIndex (idempotent)
CREATE INDEX IF NOT EXISTS "HouseStyleRule_isActive_idx" ON "HouseStyleRule"("isActive");

-- AddForeignKey (idempotent)
DO $$ BEGIN
  ALTER TABLE "StyleValidationJob" ADD CONSTRAINT "StyleValidationJob_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey (idempotent)
DO $$ BEGIN
  ALTER TABLE "StyleValidationJob" ADD CONSTRAINT "StyleValidationJob_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "EditorialDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey (idempotent)
DO $$ BEGIN
  ALTER TABLE "StyleViolation" ADD CONSTRAINT "StyleViolation_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "EditorialDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey (idempotent)
DO $$ BEGIN
  ALTER TABLE "StyleViolation" ADD CONSTRAINT "StyleViolation_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "StyleValidationJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey (idempotent)
DO $$ BEGIN
  ALTER TABLE "HouseRuleSet" ADD CONSTRAINT "HouseRuleSet_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey (idempotent)
DO $$ BEGIN
  ALTER TABLE "HouseStyleRule" ADD CONSTRAINT "HouseStyleRule_ruleSetId_fkey" FOREIGN KEY ("ruleSetId") REFERENCES "HouseRuleSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey (idempotent)
DO $$ BEGIN
  ALTER TABLE "HouseStyleRule" ADD CONSTRAINT "HouseStyleRule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
