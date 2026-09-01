-- AlterTable: add ComparisonTrial.autoColorContrastMode -- nullable, no
-- default. Null means "not explicitly overridden for this trial's auto-mode
-- run", so the effective config inherits the tenant's own
-- aiRemediation.colorContrastMode setting (a real, operator-configurable
-- value -- tenant-config.controller.ts) exactly as auto mode did before this
-- column existed. A non-null default would unconditionally override that
-- tenant setting for every trial, even ones nobody explicitly configured.
-- Idempotent ADD COLUMN block so this migration is safe to re-run against a
-- hand-baselined database. Reverse with:
--   ALTER TABLE "ComparisonTrial" DROP COLUMN "autoColorContrastMode";

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ComparisonTrial'
      AND column_name = 'autoColorContrastMode'
  ) THEN
    ALTER TABLE "ComparisonTrial" ADD COLUMN "autoColorContrastMode" TEXT;
  END IF;
END $$;
