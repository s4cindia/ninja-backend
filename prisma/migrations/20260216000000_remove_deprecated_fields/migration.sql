-- Migration: Remove Deprecated Fields (IDEMPOTENT VERSION)
-- Description: Remove deprecated fullText/fullHtml from EditorialDocument and citationIds from ReferenceListEntry
-- These fields have been migrated to EditorialDocumentContent and ReferenceListEntryCitation tables

-- Step 1: Migrate any remaining data from deprecated fields to new tables
-- This ensures no data loss during the transition
-- Note: Only runs if the target tables exist (from previous migration)

DO $$
BEGIN
    -- Migrate EditorialDocument content to EditorialDocumentContent (if table exists and has data to migrate)
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'EditorialDocumentContent') THEN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'EditorialDocument' AND column_name = 'fullText') THEN
            INSERT INTO "EditorialDocumentContent" ("id", "documentId", "fullText", "fullHtml", "wordCount", "pageCount", "createdAt", "updatedAt")
            SELECT gen_random_uuid(), id, "fullText", "fullHtml", "wordCount", "pageCount", "createdAt", "updatedAt"
            FROM "EditorialDocument"
            WHERE ("fullText" IS NOT NULL OR "fullHtml" IS NOT NULL)
              AND id NOT IN (SELECT "documentId" FROM "EditorialDocumentContent");
        END IF;
    END IF;
END $$;

DO $$
BEGIN
    -- Migrate citationIds to ReferenceListEntryCitation (if table exists and has data to migrate)
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'ReferenceListEntryCitation') THEN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ReferenceListEntry' AND column_name = 'citationIds') THEN
            INSERT INTO "ReferenceListEntryCitation" ("id", "referenceListEntryId", "citationId", "createdAt")
            SELECT gen_random_uuid(), r.id, unnest(r."citationIds"), r."createdAt"
            FROM "ReferenceListEntry" r
            WHERE r."citationIds" IS NOT NULL
              AND array_length(r."citationIds", 1) > 0
              AND NOT EXISTS (
                SELECT 1 FROM "ReferenceListEntryCitation" rlec
                WHERE rlec."referenceListEntryId" = r.id
              );
        END IF;
    END IF;
END $$;

-- Step 2: Drop deprecated columns from EditorialDocument (IF EXISTS)
ALTER TABLE "EditorialDocument" DROP COLUMN IF EXISTS "fullText";
ALTER TABLE "EditorialDocument" DROP COLUMN IF EXISTS "fullHtml";

-- Step 3: Drop deprecated column from ReferenceListEntry (IF EXISTS)
ALTER TABLE "ReferenceListEntry" DROP COLUMN IF EXISTS "citationIds";
