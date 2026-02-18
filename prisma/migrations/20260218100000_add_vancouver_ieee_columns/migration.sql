-- Add Vancouver and IEEE format columns to ReferenceListEntry
-- These columns store pre-formatted citation text for each style
-- Safe migration: only adds columns, no data loss

ALTER TABLE "ReferenceListEntry" ADD COLUMN IF NOT EXISTS "formattedVancouver" TEXT;
ALTER TABLE "ReferenceListEntry" ADD COLUMN IF NOT EXISTS "formattedIeee" TEXT;
