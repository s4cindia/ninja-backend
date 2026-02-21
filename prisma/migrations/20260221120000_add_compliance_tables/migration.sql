-- AddComplianceTables
-- This migration adds the Compliance Checker tables

-- CreateTable: ComplianceTemplate
CREATE TABLE IF NOT EXISTS "ComplianceTemplate" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "tenantId" TEXT,
    "name" TEXT NOT NULL,
    "publisher" TEXT,
    "type" TEXT NOT NULL,
    "description" TEXT,
    "rules" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "ComplianceTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable: ComplianceCheck
CREATE TABLE IF NOT EXISTS "ComplianceCheck" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "documentId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "results" JSONB,
    "score" DOUBLE PRECISION,
    "passedRules" INTEGER NOT NULL DEFAULT 0,
    "failedRules" INTEGER NOT NULL DEFAULT 0,
    "warnings" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "ComplianceCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndexes: ComplianceTemplate
CREATE INDEX IF NOT EXISTS "ComplianceTemplate_tenantId_idx" ON "ComplianceTemplate"("tenantId");
CREATE INDEX IF NOT EXISTS "ComplianceTemplate_type_idx" ON "ComplianceTemplate"("type");
CREATE INDEX IF NOT EXISTS "ComplianceTemplate_isActive_idx" ON "ComplianceTemplate"("isActive");
CREATE INDEX IF NOT EXISTS "ComplianceTemplate_publisher_idx" ON "ComplianceTemplate"("publisher");

-- CreateIndexes: ComplianceCheck
CREATE INDEX IF NOT EXISTS "ComplianceCheck_documentId_idx" ON "ComplianceCheck"("documentId");
CREATE INDEX IF NOT EXISTS "ComplianceCheck_templateId_idx" ON "ComplianceCheck"("templateId");
CREATE INDEX IF NOT EXISTS "ComplianceCheck_status_idx" ON "ComplianceCheck"("status");
CREATE INDEX IF NOT EXISTS "ComplianceCheck_documentId_templateId_idx" ON "ComplianceCheck"("documentId", "templateId");

-- AddForeignKey: ComplianceCheck.templateId -> ComplianceTemplate.id
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ComplianceCheck_templateId_fkey'
    ) THEN
        ALTER TABLE "ComplianceCheck"
        ADD CONSTRAINT "ComplianceCheck_templateId_fkey"
        FOREIGN KEY ("templateId") REFERENCES "ComplianceTemplate"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;
