-- FixEditorialTableColumns
-- This migration fixes tables that were created with wrong column definitions

-- Fix CitationChange table - drop and recreate with correct schema
DROP TABLE IF EXISTS "CitationChange" CASCADE;

CREATE TABLE "CitationChange" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "citationId" TEXT,
    "changeType" TEXT NOT NULL,
    "beforeText" TEXT NOT NULL,
    "afterText" TEXT NOT NULL,
    "metadata" JSONB,
    "appliedBy" TEXT NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isReverted" BOOLEAN NOT NULL DEFAULT false,
    "revertedAt" TIMESTAMP(3),

    CONSTRAINT "CitationChange_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CitationChange_documentId_idx" ON "CitationChange"("documentId");
CREATE INDEX "CitationChange_documentId_isReverted_idx" ON "CitationChange"("documentId", "isReverted");

ALTER TABLE "CitationChange" ADD CONSTRAINT "CitationChange_documentId_fkey"
    FOREIGN KEY ("documentId") REFERENCES "EditorialDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Fix ReferenceListEntry table - drop and recreate with correct schema
DROP TABLE IF EXISTS "ReferenceListEntryCitation" CASCADE;
DROP TABLE IF EXISTS "ReferenceListEntry" CASCADE;

CREATE TABLE "ReferenceListEntry" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "sortKey" TEXT NOT NULL,
    "authors" JSONB NOT NULL,
    "year" TEXT,
    "title" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "journalName" TEXT,
    "volume" TEXT,
    "issue" TEXT,
    "pages" TEXT,
    "publisher" TEXT,
    "doi" TEXT,
    "url" TEXT,
    "enrichmentSource" TEXT NOT NULL,
    "enrichmentConfidence" DOUBLE PRECISION NOT NULL,
    "formattedApa" TEXT,
    "formattedMla" TEXT,
    "formattedChicago" TEXT,
    "formattedVancouver" TEXT,
    "formattedIeee" TEXT,
    "isEdited" BOOLEAN NOT NULL DEFAULT false,
    "editedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferenceListEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ReferenceListEntry_documentId_idx" ON "ReferenceListEntry"("documentId");
CREATE INDEX "ReferenceListEntry_documentId_sortKey_idx" ON "ReferenceListEntry"("documentId", "sortKey");

ALTER TABLE "ReferenceListEntry" ADD CONSTRAINT "ReferenceListEntry_documentId_fkey"
    FOREIGN KEY ("documentId") REFERENCES "EditorialDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Recreate ReferenceListEntryCitation junction table
CREATE TABLE "ReferenceListEntryCitation" (
    "id" TEXT NOT NULL,
    "referenceListEntryId" TEXT NOT NULL,
    "citationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferenceListEntryCitation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReferenceListEntryCitation_referenceListEntryId_citationId_key" ON "ReferenceListEntryCitation"("referenceListEntryId", "citationId");
CREATE INDEX "ReferenceListEntryCitation_referenceListEntryId_idx" ON "ReferenceListEntryCitation"("referenceListEntryId");
CREATE INDEX "ReferenceListEntryCitation_citationId_idx" ON "ReferenceListEntryCitation"("citationId");

ALTER TABLE "ReferenceListEntryCitation" ADD CONSTRAINT "ReferenceListEntryCitation_referenceListEntryId_fkey"
    FOREIGN KEY ("referenceListEntryId") REFERENCES "ReferenceListEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ReferenceListEntryCitation" ADD CONSTRAINT "ReferenceListEntryCitation_citationId_fkey"
    FOREIGN KEY ("citationId") REFERENCES "Citation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Fix CitationValidation table - drop and recreate with correct schema
DROP TABLE IF EXISTS "CitationValidation" CASCADE;

CREATE TABLE "CitationValidation" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "citationId" TEXT NOT NULL,
    "ruleCode" TEXT NOT NULL,
    "severity" "ValidationSeverity" NOT NULL DEFAULT 'WARNING',
    "message" TEXT NOT NULL,
    "suggestion" TEXT,
    "autoFixable" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "resolvedText" TEXT,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CitationValidation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CitationValidation_documentId_idx" ON "CitationValidation"("documentId");
CREATE INDEX "CitationValidation_citationId_idx" ON "CitationValidation"("citationId");
CREATE INDEX "CitationValidation_status_idx" ON "CitationValidation"("status");

ALTER TABLE "CitationValidation" ADD CONSTRAINT "CitationValidation_documentId_fkey"
    FOREIGN KEY ("documentId") REFERENCES "EditorialDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CitationValidation" ADD CONSTRAINT "CitationValidation_citationId_fkey"
    FOREIGN KEY ("citationId") REFERENCES "Citation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Fix PlagiarismMatch table if it exists with wrong schema
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'PlagiarismMatch') THEN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'PlagiarismMatch' AND column_name = 'matchType') THEN
            DROP TABLE IF EXISTS "PlagiarismMatch" CASCADE;

            CREATE TABLE "PlagiarismMatch" (
                "id" TEXT NOT NULL,
                "documentId" TEXT NOT NULL,
                "sourceChunkId" TEXT NOT NULL,
                "matchedChunkId" TEXT,
                "externalSource" TEXT,
                "externalUrl" TEXT,
                "externalTitle" TEXT,
                "matchType" "PlagiarismMatchType" NOT NULL,
                "similarityScore" DOUBLE PRECISION NOT NULL,
                "classification" "PlagiarismClassification" NOT NULL,
                "confidence" DOUBLE PRECISION NOT NULL,
                "aiReasoning" TEXT,
                "sourceText" TEXT NOT NULL,
                "matchedText" TEXT NOT NULL,
                "status" "MatchReviewStatus" NOT NULL DEFAULT 'PENDING',
                "reviewedBy" TEXT,
                "reviewedAt" TIMESTAMP(3),
                "reviewNotes" TEXT,
                "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

                CONSTRAINT "PlagiarismMatch_pkey" PRIMARY KEY ("id")
            );

            CREATE INDEX "PlagiarismMatch_documentId_idx" ON "PlagiarismMatch"("documentId");
            CREATE INDEX "PlagiarismMatch_sourceChunkId_idx" ON "PlagiarismMatch"("sourceChunkId");
            CREATE INDEX "PlagiarismMatch_status_idx" ON "PlagiarismMatch"("status");

            ALTER TABLE "PlagiarismMatch" ADD CONSTRAINT "PlagiarismMatch_documentId_fkey"
                FOREIGN KEY ("documentId") REFERENCES "EditorialDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

            ALTER TABLE "PlagiarismMatch" ADD CONSTRAINT "PlagiarismMatch_sourceChunkId_fkey"
                FOREIGN KEY ("sourceChunkId") REFERENCES "EditorialTextChunk"("id") ON DELETE CASCADE ON UPDATE CASCADE;

            ALTER TABLE "PlagiarismMatch" ADD CONSTRAINT "PlagiarismMatch_matchedChunkId_fkey"
                FOREIGN KEY ("matchedChunkId") REFERENCES "EditorialTextChunk"("id") ON DELETE SET NULL ON UPDATE CASCADE;
        END IF;
    END IF;
END $$;
