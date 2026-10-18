-- Optional per-batch Auto Mode overrides, set once at POST
-- /pdf-batches/:batchId/start and applied uniformly to every item's own
-- PdfAutoRemediationRun (each item still gets its own independent
-- budget/round count -- NOT a shared pool across the batch). All three
-- columns are nullable with no default: NULL means "use the system
-- default" (10 rounds, $2.00, inherited contrast mode), exactly like an
-- unset field on PdfAutoRemediationRun today -- no backfill needed, every
-- existing batch behaves identically to before this migration.
--
-- Idempotent (IF NOT EXISTS), matching this repo's established migration
-- convention. Reverse with:
--   ALTER TABLE "PdfBatch" DROP COLUMN "autoMaxRounds", DROP COLUMN "autoCostLimitUsd", DROP COLUMN "autoColorContrastMode";

ALTER TABLE "PdfBatch"
  ADD COLUMN IF NOT EXISTS "autoMaxRounds" INTEGER,
  ADD COLUMN IF NOT EXISTS "autoCostLimitUsd" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "autoColorContrastMode" TEXT;
