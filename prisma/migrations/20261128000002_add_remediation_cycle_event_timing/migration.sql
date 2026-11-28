-- Apply-fixes timing diagnostics, 2026-11-28.
--
-- Real production incident: T2 (Math_Weir_PDF.pdf, 377 pages) was killed
-- by the ECS health check mid cycle1_apply_fixes while a SECOND worker
-- reached Redis fine in the same window (CloudWatch-confirmed) -- that
-- worker's own event loop was blocked, not Redis being down. Two strong
-- candidates: the per-suggestion-type dispatch loop (no yield point
-- between synchronous fixer calls) and pdfModifierService.savePDF(doc)
-- (pdf-lib's own save() is almost entirely synchronous, and savePDF's
-- round-trip verification can run it twice). These two columns capture
-- per-round timing for both, to identify which actually dominates.
--
-- Idempotent (guarded column adds), matching this repo's
-- hand-baselined-database convention.
-- Reverse with:
--   ALTER TABLE "RemediationCycleEvent" DROP COLUMN "timingBySuggestionTypeMs", DROP COLUMN "saveMs";

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'RemediationCycleEvent'
      AND column_name = 'timingBySuggestionTypeMs'
  ) THEN
    ALTER TABLE "RemediationCycleEvent" ADD COLUMN "timingBySuggestionTypeMs" JSONB;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'RemediationCycleEvent'
      AND column_name = 'saveMs'
  ) THEN
    ALTER TABLE "RemediationCycleEvent" ADD COLUMN "saveMs" INTEGER;
  END IF;
END $$;
