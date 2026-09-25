-- AlterTable: add ComparisonTrial.autoStartedAt/autoStoppedAt -- wall-clock
-- start/stop of the current/last auto-mode run, giving a real "time to
-- convergence" figure. Both nullable, no default: null means auto mode has
-- never run (or hasn't stopped yet, for autoStoppedAt). Idempotent ADD
-- COLUMN blocks so this migration is safe to re-run against a
-- hand-baselined database. Reverse with:
--   ALTER TABLE "ComparisonTrial" DROP COLUMN "autoStartedAt";
--   ALTER TABLE "ComparisonTrial" DROP COLUMN "autoStoppedAt";

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ComparisonTrial'
      AND column_name = 'autoStartedAt'
  ) THEN
    ALTER TABLE "ComparisonTrial" ADD COLUMN "autoStartedAt" TIMESTAMP(3);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ComparisonTrial'
      AND column_name = 'autoStoppedAt'
  ) THEN
    ALTER TABLE "ComparisonTrial" ADD COLUMN "autoStoppedAt" TIMESTAMP(3);
  END IF;
END $$;

-- CreateTable: ExternalPacReport -- a real, external PAC-tool report file
-- uploaded by an operator against a trial's final remediated output.
-- Distinct from both of this codebase's other two "PAC report" concepts
-- (pac-report.service.ts's own self-generated Matterhorn-protocol
-- emulation, and ComparisonTrial.ninjaPacResult/pdfxtPacResult, a veraPDF
-- failure-count blob). Summary counts are entered manually by the
-- uploading operator -- nothing parses real PAC export files today.
-- Idempotent (CREATE TABLE/INDEX IF NOT EXISTS + guarded ADD CONSTRAINT).
-- Reverse with: `DROP TABLE "ExternalPacReport";`.

CREATE TABLE IF NOT EXISTS "ExternalPacReport" (
    "id" TEXT NOT NULL,
    "trialId" TEXT NOT NULL,
    "s3Key" TEXT NOT NULL,
    "originalFileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "pass" INTEGER,
    "fail" INTEGER,
    "untested" INTEGER,
    "humanRequired" INTEGER,
    "notApplicable" INTEGER,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExternalPacReport_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ExternalPacReport_trialId_key"
    ON "ExternalPacReport"("trialId");

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'ExternalPacReport'
      AND constraint_name = 'ExternalPacReport_trialId_fkey'
  ) THEN
    ALTER TABLE "ExternalPacReport"
      ADD CONSTRAINT "ExternalPacReport_trialId_fkey"
      FOREIGN KEY ("trialId") REFERENCES "ComparisonTrial"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
