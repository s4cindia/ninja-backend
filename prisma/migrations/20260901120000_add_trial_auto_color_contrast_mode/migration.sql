-- AlterTable: add ComparisonTrial.autoColorContrastMode -- auto mode never
-- passed a colorContrastMode override to analyzeJob, so it always fell back
-- to the backend default ('guidance-only') even when an operator wanted
-- contrast fixes auto-applied during an auto-mode run. This column lets the
-- trial carry that override, read fresh each round like autoMaxRounds/
-- autoCostLimitUsd. Idempotent ADD COLUMN block so this migration is safe to
-- re-run against a hand-baselined database. Reverse with:
--   ALTER TABLE "ComparisonTrial" DROP COLUMN "autoColorContrastMode";

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ComparisonTrial'
      AND column_name = 'autoColorContrastMode'
  ) THEN
    ALTER TABLE "ComparisonTrial" ADD COLUMN "autoColorContrastMode" TEXT NOT NULL DEFAULT 'guidance-only';
  END IF;
END $$;
