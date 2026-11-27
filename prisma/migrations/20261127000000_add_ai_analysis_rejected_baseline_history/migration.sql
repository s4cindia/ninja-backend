-- Gives each AiAnalysis row a durable, APPENDED history of every
-- draftComplexImageBaseline candidate hasGroundedWordOverlap rejected for
-- that issue, one entry per round it recurred in. Without this, the
-- rejection is only ever visible as a server log line with no durable
-- record of the actual rejected text -- a human reviewing the guard's
-- false-reject rate had nothing to look at past the current round.
--
-- Nullable, no backfill: every existing row (every suggestion type other
-- than alt-text, and every alt-text row that never hit the guard) simply
-- has no rejection history.
--
-- Idempotent (IF NOT EXISTS), matching this repo's established migration
-- convention. Reverse with:
--   ALTER TABLE "AiAnalysis" DROP COLUMN "rejectedBaselineHistory";

ALTER TABLE "AiAnalysis"
  ADD COLUMN IF NOT EXISTS "rejectedBaselineHistory" JSONB;
