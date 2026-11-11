-- Gives an alt-text suggestion a second, long-form description alongside its
-- existing short `value` string. Only ever populated on a
-- `requiresManualReview` alt-text row where the PDF pipeline's own fixer
-- declined to produce anything (ai-analysis.service.ts's
-- tryGenerateFallbackAltText) -- a drafting aid for the operator to copy
-- into Acrobat Pro, never a value this service applies itself.
--
-- Nullable, no backfill: every existing row (every suggestion type other
-- than alt-text, and every alt-text row that predates this column) simply
-- has no extended description.
--
-- Idempotent (IF NOT EXISTS), matching this repo's established migration
-- convention. Reverse with:
--   ALTER TABLE "AiAnalysis" DROP COLUMN "extendedAlt";

ALTER TABLE "AiAnalysis"
  ADD COLUMN IF NOT EXISTS "extendedAlt" TEXT;
