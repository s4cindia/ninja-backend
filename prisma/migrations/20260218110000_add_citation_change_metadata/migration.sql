-- AlterTable
-- Add metadata column to CitationChange for storing structured data
-- This keeps afterText clean for human-readable text
-- Only run if CitationChange table exists (Editorial Services may not be deployed)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'CitationChange') THEN
        ALTER TABLE "CitationChange" ADD COLUMN IF NOT EXISTS "metadata" JSONB;
        RAISE NOTICE 'Added metadata column to CitationChange';
    ELSE
        RAISE NOTICE 'CitationChange table does not exist, skipping';
    END IF;
END$$;
