-- AlterTable: add Status Tracker fields to CorpusDocument.
-- Idempotent ADD COLUMN blocks so the migration can be safely re-applied
-- (e.g. against a database that was hand-baselined). Reverse with
-- `ALTER TABLE "CorpusDocument" DROP COLUMN ...` for each column below.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'CorpusDocument' AND column_name = 'statusNote'
  ) THEN
    ALTER TABLE "CorpusDocument" ADD COLUMN "statusNote" TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'CorpusDocument' AND column_name = 'statusOverride'
  ) THEN
    ALTER TABLE "CorpusDocument" ADD COLUMN "statusOverride" TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'CorpusDocument' AND column_name = 'statusUpdatedAt'
  ) THEN
    ALTER TABLE "CorpusDocument" ADD COLUMN "statusUpdatedAt" TIMESTAMP(3);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'CorpusDocument' AND column_name = 'statusUpdatedBy'
  ) THEN
    ALTER TABLE "CorpusDocument" ADD COLUMN "statusUpdatedBy" TEXT;
  END IF;
END $$;
