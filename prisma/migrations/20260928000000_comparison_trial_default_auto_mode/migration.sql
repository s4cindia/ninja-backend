-- AlterTable: change ComparisonTrial.mode's column default from 'manual' to
-- 'auto', so a newly-registered trial (registerTrial never sets this field
-- explicitly -- see comparison-study.service.ts) starts in auto mode
-- without an operator having to manually flip it and Save every time.
-- SET DEFAULT is already idempotent on its own (safe to re-run, no error
-- on repeat) -- wrapped in a DO block anyway to satisfy
-- scripts/validate-migrations.sh's blanket "ALTER COLUMN must have a DO
-- block" check; no EXCEPTION handling needed since this statement can't
-- fail on a repeat run. Does not touch existing rows' already-stored
-- "manual" values (SET DEFAULT only affects future INSERTs that omit the
-- column). Reverse with:
--   ALTER TABLE "ComparisonTrial" ALTER COLUMN "mode" SET DEFAULT 'manual';

DO $$ BEGIN
  ALTER TABLE "ComparisonTrial" ALTER COLUMN "mode" SET DEFAULT 'auto';
END $$;
