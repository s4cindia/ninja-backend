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

-- ============================================
-- DATA MIGRATION (Automated)
-- ============================================
-- Migrates existing data from deprecated columns to new normalized tables.
-- These statements are idempotent and safe to re-run.

-- 1. Migrate content from EditorialDocument to EditorialDocumentContent
-- Only migrates documents that have content and haven't been migrated yet
INSERT INTO "EditorialDocumentContent" ("id", "documentId", "fullText", "fullHtml", "wordCount", "pageCount", "createdAt", "updatedAt")
SELECT
    gen_random_uuid(),
    ed.id,
    ed."fullText",
    ed."fullHtml",
    COALESCE(ed."wordCount", 0),
    ed."pageCount",
    ed."createdAt",
    ed."updatedAt"
FROM "EditorialDocument" ed
WHERE (ed."fullText" IS NOT NULL OR ed."fullHtml" IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1 FROM "EditorialDocumentContent" edc
    WHERE edc."documentId" = ed.id
  );

-- 2. Migrate citationIds from ReferenceListEntry to ReferenceListEntryCitation junction table
-- Only migrates entries that have citationIds and haven't been migrated yet
-- Uses unnest to expand the array into individual rows
INSERT INTO "ReferenceListEntryCitation" ("id", "referenceListEntryId", "citationId", "createdAt")
SELECT
    gen_random_uuid(),
    r.id,
    citation_id,
    r."createdAt"
FROM "ReferenceListEntry" r
CROSS JOIN LATERAL unnest(r."citationIds") AS citation_id
WHERE r."citationIds" IS NOT NULL
  AND array_length(r."citationIds", 1) > 0
  AND NOT EXISTS (
    SELECT 1 FROM "ReferenceListEntryCitation" rlec
    WHERE rlec."referenceListEntryId" = r.id
      AND rlec."citationId" = citation_id
  );

-- Note: The deprecated columns (fullText, fullHtml in EditorialDocument and
-- citationIds in ReferenceListEntry) are preserved for backward compatibility.
-- A separate cleanup migration should be run after verifying all data has been
-- migrated and application code has been updated to use the new tables.
