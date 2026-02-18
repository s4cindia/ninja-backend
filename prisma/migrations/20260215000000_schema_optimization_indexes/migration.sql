-- Schema Optimization Migration (FULLY CONDITIONAL VERSION)
-- Addresses CodeRabbit Issue 7: Schema Design Concerns
-- This migration only runs if the Editorial Services tables exist in the database.
-- If tables don't exist (e.g., staging environment), this migration is a no-op.

-- All operations are wrapped in conditional blocks to handle environments
-- where Editorial Services tables haven't been deployed yet.

DO $$
BEGIN
    -- Only create EditorialDocumentContent if EditorialDocument exists
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'EditorialDocument') THEN
        -- CreateTable: EditorialDocumentContent
        IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'EditorialDocumentContent') THEN
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

            CREATE UNIQUE INDEX "EditorialDocumentContent_documentId_key" ON "EditorialDocumentContent"("documentId");
            CREATE INDEX "EditorialDocumentContent_documentId_idx" ON "EditorialDocumentContent"("documentId");

            ALTER TABLE "EditorialDocumentContent" ADD CONSTRAINT "EditorialDocumentContent_documentId_fkey"
                FOREIGN KEY ("documentId") REFERENCES "EditorialDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
        END IF;

        -- Create index on EditorialDocument if it doesn't exist
        IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'EditorialDocument_tenantId_status_idx') THEN
            CREATE INDEX "EditorialDocument_tenantId_status_idx" ON "EditorialDocument"("tenantId", "status");
        END IF;
    END IF;
END $$;

DO $$
BEGIN
    -- Only create ReferenceListEntryCitation if ReferenceListEntry and Citation exist
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'ReferenceListEntry')
       AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'Citation') THEN

        IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'ReferenceListEntryCitation') THEN
            CREATE TABLE "ReferenceListEntryCitation" (
                "id" TEXT NOT NULL,
                "referenceListEntryId" TEXT NOT NULL,
                "citationId" TEXT NOT NULL,
                "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT "ReferenceListEntryCitation_pkey" PRIMARY KEY ("id")
            );

            CREATE UNIQUE INDEX "ReferenceListEntryCitation_referenceListEntryId_citationId_key"
                ON "ReferenceListEntryCitation"("referenceListEntryId", "citationId");
            CREATE INDEX "ReferenceListEntryCitation_referenceListEntryId_idx" ON "ReferenceListEntryCitation"("referenceListEntryId");
            CREATE INDEX "ReferenceListEntryCitation_citationId_idx" ON "ReferenceListEntryCitation"("citationId");

            ALTER TABLE "ReferenceListEntryCitation" ADD CONSTRAINT "ReferenceListEntryCitation_referenceListEntryId_fkey"
                FOREIGN KEY ("referenceListEntryId") REFERENCES "ReferenceListEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
            ALTER TABLE "ReferenceListEntryCitation" ADD CONSTRAINT "ReferenceListEntryCitation_citationId_fkey"
                FOREIGN KEY ("citationId") REFERENCES "Citation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
        END IF;

        -- Create index on ReferenceListEntry if it doesn't exist
        IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'ReferenceListEntry_documentId_sortKey_idx') THEN
            CREATE INDEX "ReferenceListEntry_documentId_sortKey_idx" ON "ReferenceListEntry"("documentId", "sortKey");
        END IF;
    END IF;
END $$;

-- Conditional indexes on Citation table
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'Citation') THEN
        IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'Citation_documentId_citationType_idx') THEN
            CREATE INDEX "Citation_documentId_citationType_idx" ON "Citation"("documentId", "citationType");
        END IF;
    END IF;
END $$;

-- Conditional indexes on CitationChange table
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'CitationChange') THEN
        IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'CitationChange_documentId_isReverted_idx') THEN
            CREATE INDEX "CitationChange_documentId_isReverted_idx" ON "CitationChange"("documentId", "isReverted");
        END IF;
    END IF;
END $$;

-- Conditional indexes on BatchFile table
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'BatchFile') THEN
        IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'BatchFile_batchId_status_idx') THEN
            CREATE INDEX "BatchFile_batchId_status_idx" ON "BatchFile"("batchId", "status");
        END IF;
    END IF;
END $$;

-- Data migration: Only runs if source and target tables both exist
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'EditorialDocument')
       AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'EditorialDocumentContent')
       AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'EditorialDocument' AND column_name = 'fullText') THEN

        INSERT INTO "EditorialDocumentContent" ("id", "documentId", "fullText", "fullHtml", "wordCount", "pageCount", "createdAt", "updatedAt")
        SELECT gen_random_uuid(), ed.id, ed."fullText", ed."fullHtml", COALESCE(ed."wordCount", 0), ed."pageCount", ed."createdAt", ed."updatedAt"
        FROM "EditorialDocument" ed
        WHERE (ed."fullText" IS NOT NULL OR ed."fullHtml" IS NOT NULL)
          AND NOT EXISTS (SELECT 1 FROM "EditorialDocumentContent" edc WHERE edc."documentId" = ed.id);
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'ReferenceListEntry')
       AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'ReferenceListEntryCitation')
       AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ReferenceListEntry' AND column_name = 'citationIds') THEN

        INSERT INTO "ReferenceListEntryCitation" ("id", "referenceListEntryId", "citationId", "createdAt")
        SELECT gen_random_uuid(), r.id, citation_id, r."createdAt"
        FROM "ReferenceListEntry" r
        CROSS JOIN LATERAL unnest(r."citationIds") AS citation_id
        WHERE r."citationIds" IS NOT NULL
          AND array_length(r."citationIds", 1) > 0
          AND NOT EXISTS (SELECT 1 FROM "ReferenceListEntryCitation" rlec WHERE rlec."referenceListEntryId" = r.id AND rlec."citationId" = citation_id);
    END IF;
END $$;
