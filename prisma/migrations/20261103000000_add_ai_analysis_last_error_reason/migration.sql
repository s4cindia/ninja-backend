-- Gives each AiAnalysis row's most recent apply-failure reason a durable
-- home, independent of the 50-entry-capped applyErrorsJson blob written per
-- remediation-cycle-event (ai-analysis.service.ts). That cap exists so a
-- round with thousands of failures doesn't blow up the history row, but it
-- also means a job with more than 50 failures in its worst round can never
-- see its OWN full failure set, only the first 50 of whichever round
-- happened to have the most. Recording the reason directly on the row lets
-- the Apply Failure Report aggregate a job's complete set of failures by
-- (suggestionType, reason), regardless of which round produced them.
--
-- Nullable, no backfill: every existing row (never failed, or failed before
-- this column existed) simply has no recorded reason yet, and self-heals the
-- next time recordApplyFailure runs for it.
--
-- Idempotent (IF NOT EXISTS), matching this repo's established migration
-- convention. Reverse with:
--   ALTER TABLE "AiAnalysis" DROP COLUMN "lastErrorReason";

ALTER TABLE "AiAnalysis"
  ADD COLUMN IF NOT EXISTS "lastErrorReason" TEXT;
