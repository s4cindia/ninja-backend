-- Operational Reports Group 2 (cost) -- see OPERATIONAL_REPORTS_DESIGN.md.
-- Per-round AI spend, only ever populated on the 'ai_analysis' action (the
-- one action every round logs regardless of whether apply/reaudit ran, and
-- the only point where AI cost is actually incurred -- see
-- auto-remediation-loop.service.ts's getRoundAiCostUsd).
--
-- Nullable, no default: old rows simply have no cost data (absent, not
-- zero) -- no backfill, no behavior change to any existing row or query.
--
-- Idempotent (IF NOT EXISTS), matching this repo's established migration
-- convention. Reverse with:
--   ALTER TABLE "RemediationCycleEvent" DROP COLUMN "costUsd";

ALTER TABLE "RemediationCycleEvent"
  ADD COLUMN IF NOT EXISTS "costUsd" DOUBLE PRECISION;
