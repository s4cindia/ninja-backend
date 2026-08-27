-- AlterTable: add issueFingerprint to AiAnalysis.
-- Idempotent ADD COLUMN block so the migration can be safely re-applied
-- (e.g. against a database that was hand-baselined). Reverse with
-- `ALTER TABLE "AiAnalysis" DROP COLUMN "issueFingerprint";`.
-- Existence check scopes on table_schema = current_schema() so an unrelated
-- table/column in another schema cannot accidentally cause the ALTER to skip.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'AiAnalysis'
      AND column_name = 'issueFingerprint'
  ) THEN
    ALTER TABLE "AiAnalysis" ADD COLUMN "issueFingerprint" TEXT;
  END IF;
END $$;
