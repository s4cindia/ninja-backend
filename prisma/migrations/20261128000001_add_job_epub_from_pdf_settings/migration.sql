-- EPUB-from-certified-PDF, Phase 0 (B1): per-job request flag + EPUB ISBN.
--
-- Job.produceAccessibleEpub: null = inherit the tenant's
-- aiRemediation.epubFromPdfDefault (same three-state shape as Job.fullQC).
-- Job.epubIsbn: publisher-supplied ISBN-13 of the EPUB edition, normalised
-- to 13 digits; null until supplied.
--
-- Idempotent (guarded column adds), matching this repo's hand-baselined-
-- database convention.
-- Reverse with:
--   ALTER TABLE "Job" DROP COLUMN "produceAccessibleEpub", DROP COLUMN "epubIsbn";

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'Job'
      AND column_name = 'produceAccessibleEpub'
  ) THEN
    ALTER TABLE "Job" ADD COLUMN "produceAccessibleEpub" BOOLEAN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'Job'
      AND column_name = 'epubIsbn'
  ) THEN
    ALTER TABLE "Job" ADD COLUMN "epubIsbn" TEXT;
  END IF;
END $$;
