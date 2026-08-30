-- AlterTable: add "auto mode" columns to ComparisonTrial (manual/auto toggle,
-- round-count and cumulative Gemini $ cost ceilings, and run status/reason)
-- so a trial can be driven end-to-end by the backend's auto-remediation loop
-- instead of an operator triggering every round by hand. Idempotent ADD
-- COLUMN blocks so this migration is safe to re-run against a
-- hand-baselined database. Reverse with:
--   ALTER TABLE "ComparisonTrial" DROP COLUMN "mode";
--   ALTER TABLE "ComparisonTrial" DROP COLUMN "autoMaxRounds";
--   ALTER TABLE "ComparisonTrial" DROP COLUMN "autoCostLimitUsd";
--   ALTER TABLE "ComparisonTrial" DROP COLUMN "autoRoundsCompleted";
--   ALTER TABLE "ComparisonTrial" DROP COLUMN "autoCostSpentUsd";
--   ALTER TABLE "ComparisonTrial" DROP COLUMN "autoStatus";
--   ALTER TABLE "ComparisonTrial" DROP COLUMN "autoStopReason";
--   ALTER TABLE "ComparisonTrial" DROP COLUMN "autoStopRequested";

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ComparisonTrial'
      AND column_name = 'mode'
  ) THEN
    ALTER TABLE "ComparisonTrial" ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'manual';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ComparisonTrial'
      AND column_name = 'autoMaxRounds'
  ) THEN
    ALTER TABLE "ComparisonTrial" ADD COLUMN "autoMaxRounds" INTEGER NOT NULL DEFAULT 10;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ComparisonTrial'
      AND column_name = 'autoCostLimitUsd'
  ) THEN
    ALTER TABLE "ComparisonTrial" ADD COLUMN "autoCostLimitUsd" DOUBLE PRECISION NOT NULL DEFAULT 2.0;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ComparisonTrial'
      AND column_name = 'autoRoundsCompleted'
  ) THEN
    ALTER TABLE "ComparisonTrial" ADD COLUMN "autoRoundsCompleted" INTEGER NOT NULL DEFAULT 0;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ComparisonTrial'
      AND column_name = 'autoCostSpentUsd'
  ) THEN
    ALTER TABLE "ComparisonTrial" ADD COLUMN "autoCostSpentUsd" DOUBLE PRECISION NOT NULL DEFAULT 0;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ComparisonTrial'
      AND column_name = 'autoStatus'
  ) THEN
    ALTER TABLE "ComparisonTrial" ADD COLUMN "autoStatus" TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ComparisonTrial'
      AND column_name = 'autoStopReason'
  ) THEN
    ALTER TABLE "ComparisonTrial" ADD COLUMN "autoStopReason" TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ComparisonTrial'
      AND column_name = 'autoStopRequested'
  ) THEN
    ALTER TABLE "ComparisonTrial" ADD COLUMN "autoStopRequested" BOOLEAN NOT NULL DEFAULT false;
  END IF;
END $$;

-- AlterTable: add AiAnalysis.approvedBy so an auto-approved suggestion is
-- distinguishable from an operator-approved one (surfaced in the UI/history).
-- Reverse with: ALTER TABLE "AiAnalysis" DROP COLUMN "approvedBy";

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'AiAnalysis'
      AND column_name = 'approvedBy'
  ) THEN
    ALTER TABLE "AiAnalysis" ADD COLUMN "approvedBy" TEXT;
  END IF;
END $$;
