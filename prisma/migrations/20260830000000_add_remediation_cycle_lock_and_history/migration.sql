-- AlterTable: add remediation-cycle lock columns to Job, closing the race
-- window where two overlapping "apply fixes -> re-audit -> re-run AI
-- analysis" cycles on the same job could interleave their job.output writes
-- with no ordering guarantee (whichever write landed last silently won,
-- regardless of which cycle represented more real progress). Idempotent ADD
-- COLUMN blocks so this migration is safe to re-run against a
-- hand-baselined database. Reverse with:
--   ALTER TABLE "Job" DROP COLUMN "remediationCycleLockedAt";
--   ALTER TABLE "Job" DROP COLUMN "remediationCycleLockedBy";
--   ALTER TABLE "Job" DROP COLUMN "remediationCycleSource";
--   ALTER TABLE "Job" DROP COLUMN "remediationCycleCounter";

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'Job'
      AND column_name = 'remediationCycleLockedAt'
  ) THEN
    ALTER TABLE "Job" ADD COLUMN "remediationCycleLockedAt" TIMESTAMP(3);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'Job'
      AND column_name = 'remediationCycleLockedBy'
  ) THEN
    ALTER TABLE "Job" ADD COLUMN "remediationCycleLockedBy" TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'Job'
      AND column_name = 'remediationCycleSource'
  ) THEN
    ALTER TABLE "Job" ADD COLUMN "remediationCycleSource" TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'Job'
      AND column_name = 'remediationCycleCounter'
  ) THEN
    ALTER TABLE "Job" ADD COLUMN "remediationCycleCounter" INTEGER NOT NULL DEFAULT 0;
  END IF;
END $$;

-- CreateTable: RemediationCycleEvent -- append-only history log of every
-- completed/failed apply-fixes, re-audit, or AI-analysis action, grouped by
-- cycleNumber into the "Run 1 / Run 2 / ..." view. Idempotent (CREATE TABLE
-- / INDEX IF NOT EXISTS + guarded ADD CONSTRAINT), matching the
-- RemediationSession migration's pattern. Reverse with
-- `DROP TABLE "RemediationCycleEvent";`.

CREATE TABLE IF NOT EXISTS "RemediationCycleEvent" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "cycleNumber" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "appliedCount" INTEGER,
    "failedCount" INTEGER,
    "resolvedCount" INTEGER,
    "remainingCount" INTEGER,
    "regressionCount" INTEGER,
    "resolutionRate" DOUBLE PRECISION,
    "errorMessage" TEXT,
    "triggeredBy" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RemediationCycleEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "RemediationCycleEvent_jobId_cycleNumber_idx"
    ON "RemediationCycleEvent"("jobId", "cycleNumber");

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'RemediationCycleEvent'
      AND constraint_name = 'RemediationCycleEvent_jobId_fkey'
  ) THEN
    ALTER TABLE "RemediationCycleEvent"
      ADD CONSTRAINT "RemediationCycleEvent_jobId_fkey"
      FOREIGN KEY ("jobId") REFERENCES "Job"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
