-- Schema Optimization Migration
-- Addresses CodeRabbit Issue 7: Schema Design Concerns
--
-- Changes:
-- 1. Add EditorialDocumentContent table for large text content (reduces main table updates)
-- 2. Add ReferenceListEntryCitation junction table (proper FK constraints for citationIds)
-- 3. Add compound indexes for common query patterns

-- CreateTable: EditorialDocumentContent
-- Separates fullText/fullHtml from EditorialDocument to reduce row lock contention
CREATE TABLE "EditorialDocumentContent" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "fullText" TEXT,
    "fullHtml" TEXT,
    "wordCount" INTEGER NOT NULL DEFAULT 0,
    "pageCount" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EditorialDocumentContent_pkey" PRIMARY KEY ("id")
);

-- CreateTable: ReferenceListEntryCitation
-- Junction table replacing String[] citationIds for referential integrity
CREATE TABLE "ReferenceListEntryCitation" (
    "id" TEXT NOT NULL,
    "referenceListEntryId" TEXT NOT NULL,
    "citationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferenceListEntryCitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: EditorialDocumentContent unique constraint
CREATE UNIQUE INDEX "EditorialDocumentContent_documentId_key" ON "EditorialDocumentContent"("documentId");

-- CreateIndex: EditorialDocumentContent documentId index
CREATE INDEX "EditorialDocumentContent_documentId_idx" ON "EditorialDocumentContent"("documentId");

-- CreateIndex: ReferenceListEntryCitation unique constraint
CREATE UNIQUE INDEX "ReferenceListEntryCitation_referenceListEntryId_citationId_key" ON "ReferenceListEntryCitation"("referenceListEntryId", "citationId");

-- CreateIndex: ReferenceListEntryCitation FK indexes
CREATE INDEX "ReferenceListEntryCitation_referenceListEntryId_idx" ON "ReferenceListEntryCitation"("referenceListEntryId");
CREATE INDEX "ReferenceListEntryCitation_citationId_idx" ON "ReferenceListEntryCitation"("citationId");

-- AddForeignKey: EditorialDocumentContent -> EditorialDocument
ALTER TABLE "EditorialDocumentContent" ADD CONSTRAINT "EditorialDocumentContent_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "EditorialDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: ReferenceListEntryCitation -> ReferenceListEntry
ALTER TABLE "ReferenceListEntryCitation" ADD CONSTRAINT "ReferenceListEntryCitation_referenceListEntryId_fkey" FOREIGN KEY ("referenceListEntryId") REFERENCES "ReferenceListEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: ReferenceListEntryCitation -> Citation
ALTER TABLE "ReferenceListEntryCitation" ADD CONSTRAINT "ReferenceListEntryCitation_citationId_fkey" FOREIGN KEY ("citationId") REFERENCES "Citation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Compound Indexes for common query patterns:

-- EditorialDocument: tenant + status (common filter)
CREATE INDEX "EditorialDocument_tenantId_status_idx" ON "EditorialDocument"("tenantId", "status");

-- Citation: document + type (common filter for citation type queries)
CREATE INDEX "Citation_documentId_citationType_idx" ON "Citation"("documentId", "citationType");

-- CitationChange: document + isReverted (common filter for active changes)
CREATE INDEX "CitationChange_documentId_isReverted_idx" ON "CitationChange"("documentId", "isReverted");

-- ReferenceListEntry: document + sortKey (sorted reference list queries)
CREATE INDEX "ReferenceListEntry_documentId_sortKey_idx" ON "ReferenceListEntry"("documentId", "sortKey");

-- BatchFile: batch + status (status-filtered batch file queries)
CREATE INDEX "BatchFile_batchId_status_idx" ON "BatchFile"("batchId", "status");

-- Data Migration Note:
-- After this migration, existing code will continue to work with the deprecated
-- fullText/fullHtml columns in EditorialDocument and citationIds array in ReferenceListEntry.
--
-- To migrate existing data to the new tables, run the following after deployment:
--
-- 1. Migrate content to EditorialDocumentContent:
--    INSERT INTO "EditorialDocumentContent" ("id", "documentId", "fullText", "fullHtml", "wordCount", "pageCount", "createdAt", "updatedAt")
--    SELECT gen_random_uuid(), id, "fullText", "fullHtml", "wordCount", "pageCount", "createdAt", "updatedAt"
--    FROM "EditorialDocument"
--    WHERE "fullText" IS NOT NULL OR "fullHtml" IS NOT NULL;
--
-- 2. Migrate citationIds to ReferenceListEntryCitation:
--    INSERT INTO "ReferenceListEntryCitation" ("id", "referenceListEntryId", "citationId", "createdAt")
--    SELECT gen_random_uuid(), r.id, unnest(r."citationIds"), r."createdAt"
--    FROM "ReferenceListEntry" r
--    WHERE array_length(r."citationIds", 1) > 0;
