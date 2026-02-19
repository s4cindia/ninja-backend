-- AddEditorialServicesTables
-- This migration adds the Editorial Services tables required for citation management
-- All operations are idempotent with IF NOT EXISTS

-- CreateEnum: EditorialDocStatus
DO $$ BEGIN
    CREATE TYPE "EditorialDocStatus" AS ENUM ('UPLOADED', 'QUEUED', 'PARSING', 'PARSED', 'ANALYZING', 'COMPLETED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum: CitationType
DO $$ BEGIN
    CREATE TYPE "CitationType" AS ENUM ('PARENTHETICAL', 'NARRATIVE', 'FOOTNOTE', 'ENDNOTE', 'NUMERIC', 'REFERENCE', 'UNKNOWN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum: SectionContext
DO $$ BEGIN
    CREATE TYPE "SectionContext" AS ENUM ('BODY', 'REFERENCES', 'FOOTNOTES', 'ENDNOTES', 'ABSTRACT', 'UNKNOWN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum: CitationStyle
DO $$ BEGIN
    CREATE TYPE "CitationStyle" AS ENUM ('APA', 'MLA', 'CHICAGO', 'VANCOUVER', 'HARVARD', 'IEEE', 'UNKNOWN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum: SourceType
DO $$ BEGIN
    CREATE TYPE "SourceType" AS ENUM ('JOURNAL_ARTICLE', 'BOOK', 'BOOK_CHAPTER', 'CONFERENCE_PAPER', 'WEBSITE', 'THESIS', 'REPORT', 'NEWSPAPER', 'MAGAZINE', 'PATENT', 'LEGAL', 'PERSONAL_COMMUNICATION', 'UNKNOWN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum: ValidationSeverity
DO $$ BEGIN
    CREATE TYPE "ValidationSeverity" AS ENUM ('ERROR', 'WARNING', 'INFO');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum: ChangeType
DO $$ BEGIN
    CREATE TYPE "ChangeType" AS ENUM ('FORMAT_CORRECTION', 'ORDER_CHANGE', 'STYLE_CONVERSION', 'MANUAL_EDIT', 'REVERT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateTable: EditorialDocument
CREATE TABLE IF NOT EXISTS "EditorialDocument" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "storagePath" TEXT NOT NULL,
    "storageType" "StorageType" NOT NULL DEFAULT 'S3',
    "wordCount" INTEGER NOT NULL DEFAULT 0,
    "pageCount" INTEGER,
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "title" TEXT,
    "authors" TEXT[],
    "language" TEXT,
    "status" "EditorialDocStatus" NOT NULL DEFAULT 'UPLOADED',
    "parsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "referenceListStatus" TEXT,
    "referenceListStyle" TEXT,
    "referenceListGeneratedAt" TIMESTAMP(3),

    CONSTRAINT "EditorialDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable: EditorialDocumentContent
CREATE TABLE IF NOT EXISTS "EditorialDocumentContent" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "fullText" TEXT,
    "fullHtml" TEXT,
    "wordCount" INTEGER NOT NULL DEFAULT 0,
    "pageCount" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EditorialDocumentContent_pkey" PRIMARY KEY ("id")
);

-- CreateTable: EditorialTextChunk
CREATE TABLE IF NOT EXISTS "EditorialTextChunk" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "wordCount" INTEGER NOT NULL,
    "startOffset" INTEGER NOT NULL,
    "endOffset" INTEGER NOT NULL,
    "pageNumber" INTEGER,
    "paragraphIndex" INTEGER,
    "chapterTitle" TEXT,
    "embedding" DOUBLE PRECISION[] DEFAULT ARRAY[]::DOUBLE PRECISION[],
    "embeddingModel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EditorialTextChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable: Citation
CREATE TABLE IF NOT EXISTS "Citation" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "rawText" TEXT NOT NULL,
    "citationType" "CitationType" NOT NULL,
    "detectedStyle" "CitationStyle",
    "sectionContext" "SectionContext" NOT NULL DEFAULT 'UNKNOWN',
    "pageNumber" INTEGER,
    "paragraphIndex" INTEGER,
    "startOffset" INTEGER NOT NULL,
    "endOffset" INTEGER NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "isValid" BOOLEAN,
    "validationErrors" TEXT[],
    "referenceId" TEXT,
    "primaryComponentId" TEXT,
    "validationStatus" TEXT,
    "lastValidatedAt" TIMESTAMP(3),
    "lastValidatedStyle" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Citation_pkey" PRIMARY KEY ("id")
);

-- CreateTable: CitationComponent
CREATE TABLE IF NOT EXISTS "CitationComponent" (
    "id" TEXT NOT NULL,
    "citationId" TEXT NOT NULL,
    "authors" TEXT[],
    "year" TEXT,
    "title" TEXT,
    "source" TEXT,
    "volume" TEXT,
    "issue" TEXT,
    "pages" TEXT,
    "doi" TEXT,
    "url" TEXT,
    "accessDate" TEXT,
    "publisher" TEXT,
    "edition" TEXT,
    "sourceType" "SourceType",
    "fieldConfidence" JSONB,
    "doiVerified" BOOLEAN,
    "urlValid" BOOLEAN,
    "urlCheckedAt" TIMESTAMP(3),
    "parseVariant" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CitationComponent_pkey" PRIMARY KEY ("id")
);

-- CreateTable: Reference
CREATE TABLE IF NOT EXISTS "Reference" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "rawText" TEXT NOT NULL,
    "formattedText" TEXT,
    "refNumber" INTEGER,
    "authors" TEXT[],
    "year" TEXT,
    "title" TEXT,
    "source" TEXT,
    "doi" TEXT,
    "url" TEXT,
    "sourceType" "SourceType",
    "isComplete" BOOLEAN NOT NULL DEFAULT false,
    "missingFields" TEXT[],
    "formatErrors" TEXT[],
    "crossrefData" JSONB,
    "pubmedData" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Reference_pkey" PRIMARY KEY ("id")
);

-- CreateTable: CitationStyleGuide
CREATE TABLE IF NOT EXISTS "CitationStyleGuide" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT,
    "inTextRules" JSONB NOT NULL,
    "referenceRules" JSONB NOT NULL,
    "sortOrder" TEXT NOT NULL DEFAULT 'alphabetical',
    "hangingIndent" BOOLEAN NOT NULL DEFAULT true,
    "doubleSpacing" BOOLEAN NOT NULL DEFAULT true,
    "isSystem" BOOLEAN NOT NULL DEFAULT true,
    "tenantId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CitationStyleGuide_pkey" PRIMARY KEY ("id")
);

-- CreateTable: CitationValidation
CREATE TABLE IF NOT EXISTS "CitationValidation" (
    "id" TEXT NOT NULL,
    "citationId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "styleCode" TEXT NOT NULL,
    "isValid" BOOLEAN NOT NULL DEFAULT false,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "warningCount" INTEGER NOT NULL DEFAULT 0,
    "infoCount" INTEGER NOT NULL DEFAULT 0,
    "issues" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CitationValidation_pkey" PRIMARY KEY ("id")
);

-- CreateTable: CitationChange
CREATE TABLE IF NOT EXISTS "CitationChange" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "citationId" TEXT,
    "referenceId" TEXT,
    "changeType" "ChangeType" NOT NULL,
    "beforeValue" JSONB NOT NULL,
    "afterValue" JSONB NOT NULL,
    "description" TEXT,
    "appliedBy" TEXT,
    "isReverted" BOOLEAN NOT NULL DEFAULT false,
    "revertedAt" TIMESTAMP(3),
    "revertedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "batchId" TEXT,
    "reason" TEXT,
    "sourceField" TEXT,
    "targetField" TEXT,

    CONSTRAINT "CitationChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable: ReferenceListEntry
CREATE TABLE IF NOT EXISTS "ReferenceListEntry" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "sortKey" TEXT NOT NULL,
    "formattedText" TEXT NOT NULL,
    "referenceStyle" TEXT NOT NULL,
    "sourceReferenceId" TEXT,
    "citationIds" TEXT[],
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferenceListEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable: ReferenceListEntryCitation
CREATE TABLE IF NOT EXISTS "ReferenceListEntryCitation" (
    "id" TEXT NOT NULL,
    "referenceListEntryId" TEXT NOT NULL,
    "citationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferenceListEntryCitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable: StyleViolation
CREATE TABLE IF NOT EXISTS "StyleViolation" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "ruleCode" TEXT NOT NULL,
    "severity" "ValidationSeverity" NOT NULL DEFAULT 'WARNING',
    "message" TEXT NOT NULL,
    "location" TEXT,
    "suggestion" TEXT,
    "isResolved" BOOLEAN NOT NULL DEFAULT false,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StyleViolation_pkey" PRIMARY KEY ("id")
);

-- CreateTable: PlagiarismMatch
CREATE TABLE IF NOT EXISTS "PlagiarismMatch" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "sourceChunkId" TEXT NOT NULL,
    "matchedChunkId" TEXT,
    "externalSource" TEXT,
    "matchPercentage" DOUBLE PRECISION NOT NULL,
    "matchedText" TEXT NOT NULL,
    "matchType" TEXT NOT NULL,
    "isExcluded" BOOLEAN NOT NULL DEFAULT false,
    "excludedBy" TEXT,
    "excludedAt" TIMESTAMP(3),
    "excludeReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlagiarismMatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable: EditorialReport
CREATE TABLE IF NOT EXISTS "EditorialReport" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "reportType" TEXT NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'json',
    "data" JSONB NOT NULL,
    "summary" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EditorialReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndexes (idempotent)
CREATE UNIQUE INDEX IF NOT EXISTS "EditorialDocument_jobId_key" ON "EditorialDocument"("jobId");
CREATE INDEX IF NOT EXISTS "EditorialDocument_tenantId_idx" ON "EditorialDocument"("tenantId");
CREATE INDEX IF NOT EXISTS "EditorialDocument_jobId_idx" ON "EditorialDocument"("jobId");
CREATE INDEX IF NOT EXISTS "EditorialDocument_status_idx" ON "EditorialDocument"("status");
CREATE INDEX IF NOT EXISTS "EditorialDocument_tenantId_status_idx" ON "EditorialDocument"("tenantId", "status");

CREATE UNIQUE INDEX IF NOT EXISTS "EditorialDocumentContent_documentId_key" ON "EditorialDocumentContent"("documentId");
CREATE INDEX IF NOT EXISTS "EditorialDocumentContent_documentId_idx" ON "EditorialDocumentContent"("documentId");

CREATE UNIQUE INDEX IF NOT EXISTS "EditorialTextChunk_documentId_chunkIndex_key" ON "EditorialTextChunk"("documentId", "chunkIndex");
CREATE INDEX IF NOT EXISTS "EditorialTextChunk_documentId_idx" ON "EditorialTextChunk"("documentId");

CREATE UNIQUE INDEX IF NOT EXISTS "Citation_primaryComponentId_key" ON "Citation"("primaryComponentId");
CREATE INDEX IF NOT EXISTS "Citation_documentId_idx" ON "Citation"("documentId");
CREATE INDEX IF NOT EXISTS "Citation_citationType_idx" ON "Citation"("citationType");
CREATE INDEX IF NOT EXISTS "Citation_referenceId_idx" ON "Citation"("referenceId");
CREATE INDEX IF NOT EXISTS "Citation_validationStatus_idx" ON "Citation"("validationStatus");
CREATE INDEX IF NOT EXISTS "Citation_documentId_citationType_idx" ON "Citation"("documentId", "citationType");

CREATE INDEX IF NOT EXISTS "CitationComponent_citationId_idx" ON "CitationComponent"("citationId");
CREATE INDEX IF NOT EXISTS "CitationComponent_doi_idx" ON "CitationComponent"("doi");

CREATE INDEX IF NOT EXISTS "Reference_documentId_idx" ON "Reference"("documentId");
CREATE INDEX IF NOT EXISTS "Reference_doi_idx" ON "Reference"("doi");

CREATE UNIQUE INDEX IF NOT EXISTS "CitationStyleGuide_code_key" ON "CitationStyleGuide"("code");
CREATE INDEX IF NOT EXISTS "CitationStyleGuide_tenantId_idx" ON "CitationStyleGuide"("tenantId");

CREATE UNIQUE INDEX IF NOT EXISTS "CitationValidation_citationId_styleCode_key" ON "CitationValidation"("citationId", "styleCode");
CREATE INDEX IF NOT EXISTS "CitationValidation_documentId_idx" ON "CitationValidation"("documentId");
CREATE INDEX IF NOT EXISTS "CitationValidation_citationId_idx" ON "CitationValidation"("citationId");

CREATE INDEX IF NOT EXISTS "CitationChange_documentId_idx" ON "CitationChange"("documentId");
CREATE INDEX IF NOT EXISTS "CitationChange_citationId_idx" ON "CitationChange"("citationId");
CREATE INDEX IF NOT EXISTS "CitationChange_documentId_isReverted_idx" ON "CitationChange"("documentId", "isReverted");

CREATE INDEX IF NOT EXISTS "ReferenceListEntry_documentId_idx" ON "ReferenceListEntry"("documentId");
CREATE INDEX IF NOT EXISTS "ReferenceListEntry_documentId_sortKey_idx" ON "ReferenceListEntry"("documentId", "sortKey");

CREATE UNIQUE INDEX IF NOT EXISTS "ReferenceListEntryCitation_referenceListEntryId_citationId_key" ON "ReferenceListEntryCitation"("referenceListEntryId", "citationId");
CREATE INDEX IF NOT EXISTS "ReferenceListEntryCitation_referenceListEntryId_idx" ON "ReferenceListEntryCitation"("referenceListEntryId");
CREATE INDEX IF NOT EXISTS "ReferenceListEntryCitation_citationId_idx" ON "ReferenceListEntryCitation"("citationId");

CREATE INDEX IF NOT EXISTS "StyleViolation_documentId_idx" ON "StyleViolation"("documentId");
CREATE INDEX IF NOT EXISTS "StyleViolation_isResolved_idx" ON "StyleViolation"("isResolved");

CREATE INDEX IF NOT EXISTS "PlagiarismMatch_documentId_idx" ON "PlagiarismMatch"("documentId");
CREATE INDEX IF NOT EXISTS "PlagiarismMatch_sourceChunkId_idx" ON "PlagiarismMatch"("sourceChunkId");

CREATE INDEX IF NOT EXISTS "EditorialReport_documentId_idx" ON "EditorialReport"("documentId");
CREATE INDEX IF NOT EXISTS "EditorialReport_reportType_idx" ON "EditorialReport"("reportType");

-- AddForeignKeys (idempotent with DO blocks)
DO $$ BEGIN
    ALTER TABLE "EditorialDocument" ADD CONSTRAINT "EditorialDocument_tenantId_fkey"
        FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "EditorialDocument" ADD CONSTRAINT "EditorialDocument_jobId_fkey"
        FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "EditorialDocumentContent" ADD CONSTRAINT "EditorialDocumentContent_documentId_fkey"
        FOREIGN KEY ("documentId") REFERENCES "EditorialDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "EditorialTextChunk" ADD CONSTRAINT "EditorialTextChunk_documentId_fkey"
        FOREIGN KEY ("documentId") REFERENCES "EditorialDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "Citation" ADD CONSTRAINT "Citation_documentId_fkey"
        FOREIGN KEY ("documentId") REFERENCES "EditorialDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "Citation" ADD CONSTRAINT "Citation_referenceId_fkey"
        FOREIGN KEY ("referenceId") REFERENCES "Reference"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "Citation" ADD CONSTRAINT "Citation_primaryComponentId_fkey"
        FOREIGN KEY ("primaryComponentId") REFERENCES "CitationComponent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "CitationComponent" ADD CONSTRAINT "CitationComponent_citationId_fkey"
        FOREIGN KEY ("citationId") REFERENCES "Citation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "Reference" ADD CONSTRAINT "Reference_documentId_fkey"
        FOREIGN KEY ("documentId") REFERENCES "EditorialDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "CitationValidation" ADD CONSTRAINT "CitationValidation_citationId_fkey"
        FOREIGN KEY ("citationId") REFERENCES "Citation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "CitationValidation" ADD CONSTRAINT "CitationValidation_documentId_fkey"
        FOREIGN KEY ("documentId") REFERENCES "EditorialDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "CitationChange" ADD CONSTRAINT "CitationChange_documentId_fkey"
        FOREIGN KEY ("documentId") REFERENCES "EditorialDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "ReferenceListEntry" ADD CONSTRAINT "ReferenceListEntry_documentId_fkey"
        FOREIGN KEY ("documentId") REFERENCES "EditorialDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "ReferenceListEntryCitation" ADD CONSTRAINT "ReferenceListEntryCitation_referenceListEntryId_fkey"
        FOREIGN KEY ("referenceListEntryId") REFERENCES "ReferenceListEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "ReferenceListEntryCitation" ADD CONSTRAINT "ReferenceListEntryCitation_citationId_fkey"
        FOREIGN KEY ("citationId") REFERENCES "Citation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "StyleViolation" ADD CONSTRAINT "StyleViolation_documentId_fkey"
        FOREIGN KEY ("documentId") REFERENCES "EditorialDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "PlagiarismMatch" ADD CONSTRAINT "PlagiarismMatch_documentId_fkey"
        FOREIGN KEY ("documentId") REFERENCES "EditorialDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "PlagiarismMatch" ADD CONSTRAINT "PlagiarismMatch_sourceChunkId_fkey"
        FOREIGN KEY ("sourceChunkId") REFERENCES "EditorialTextChunk"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "PlagiarismMatch" ADD CONSTRAINT "PlagiarismMatch_matchedChunkId_fkey"
        FOREIGN KEY ("matchedChunkId") REFERENCES "EditorialTextChunk"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "EditorialReport" ADD CONSTRAINT "EditorialReport_documentId_fkey"
        FOREIGN KEY ("documentId") REFERENCES "EditorialDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Add CITATION_DETECTION job type if not exists
DO $$ BEGIN
    ALTER TYPE "JobType" ADD VALUE 'CITATION_DETECTION';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
