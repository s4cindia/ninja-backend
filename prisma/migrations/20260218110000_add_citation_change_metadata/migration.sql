-- AlterTable
-- Add metadata column to CitationChange for storing structured data
-- This keeps afterText clean for human-readable text
ALTER TABLE "CitationChange" ADD COLUMN IF NOT EXISTS "metadata" JSONB;
