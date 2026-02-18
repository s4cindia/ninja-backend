-- Migration: Remove Deprecated Fields
-- Description: Remove deprecated fullText/fullHtml from EditorialDocument and citationIds from ReferenceListEntry
-- These fields have been migrated to EditorialDocumentContent and ReferenceListEntryCitation tables

-- Step 1: Migrate any remaining data from deprecated fields to new tables
-- This ensures no data loss during the transition

-- Migrate EditorialDocument content to EditorialDocumentContent (if not already migrated)
INSERT INTO "EditorialDocumentContent" ("id", "documentId", "fullText", "fullHtml", "wordCount", "pageCount", "createdAt", "updatedAt")
SELECT gen_random_uuid(), id, "fullText", "fullHtml", "wordCount", "pageCount", "createdAt", "updatedAt"
FROM "EditorialDocument"
WHERE ("fullText" IS NOT NULL OR "fullHtml" IS NOT NULL)
  AND id NOT IN (SELECT "documentId" FROM "EditorialDocumentContent");

-- Migrate citationIds to ReferenceListEntryCitation (if not already migrated)
INSERT INTO "ReferenceListEntryCitation" ("id", "referenceListEntryId", "citationId", "createdAt")
SELECT gen_random_uuid(), r.id, unnest(r."citationIds"), r."createdAt"
FROM "ReferenceListEntry" r
WHERE array_length(r."citationIds", 1) > 0
  AND NOT EXISTS (
    SELECT 1 FROM "ReferenceListEntryCitation" rlec
    WHERE rlec."referenceListEntryId" = r.id
  );

-- Step 2: Drop deprecated columns from EditorialDocument
ALTER TABLE "EditorialDocument" DROP COLUMN IF EXISTS "fullText";
ALTER TABLE "EditorialDocument" DROP COLUMN IF EXISTS "fullHtml";

-- Step 3: Drop deprecated column from ReferenceListEntry
ALTER TABLE "ReferenceListEntry" DROP COLUMN IF EXISTS "citationIds";
