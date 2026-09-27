-- AlterTable: change ComparisonTrial.mode's column default from 'manual' to
-- 'auto', so a newly-registered trial (registerTrial never sets this field
-- explicitly -- see comparison-study.service.ts) starts in auto mode
-- without an operator having to manually flip it and Save every time.
-- ALTER COLUMN ... SET DEFAULT is naturally idempotent (safe to re-run),
-- unlike ADD COLUMN -- no existence guard needed. Does not touch existing
-- rows' already-stored "manual" values (SET DEFAULT only affects future
-- INSERTs that omit the column). Reverse with:
--   ALTER TABLE "ComparisonTrial" ALTER COLUMN "mode" SET DEFAULT 'manual';

ALTER TABLE "ComparisonTrial" ALTER COLUMN "mode" SET DEFAULT 'auto';
