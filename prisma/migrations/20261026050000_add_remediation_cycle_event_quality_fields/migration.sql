-- Operational Reports Group 3 (fix quality/effectiveness) -- see
-- OPERATIONAL_REPORTS_DESIGN.md. Per-suggestion-type applied/failed
-- breakdown and capped failure detail for an 'apply_fixes'
-- RemediationCycleEvent row -- both derived in
-- ai-analysis.service.ts's applyApprovedSuggestions purely from data it
-- already computes (the approved list + the errors array), without
-- changing any apply logic.
--
-- Nullable, no default: old rows simply have no breakdown data (absent,
-- not empty) -- no backfill, no behavior change to any existing row or
-- query.
--
-- Idempotent (IF NOT EXISTS), matching this repo's established migration
-- convention. Reverse with:
--   ALTER TABLE "RemediationCycleEvent" DROP COLUMN "suggestionTypeBreakdown";
--   ALTER TABLE "RemediationCycleEvent" DROP COLUMN "applyErrorsJson";

ALTER TABLE "RemediationCycleEvent"
  ADD COLUMN IF NOT EXISTS "suggestionTypeBreakdown" JSONB,
  ADD COLUMN IF NOT EXISTS "applyErrorsJson" JSONB;
