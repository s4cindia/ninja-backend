-- Per-job Auto Remediation override for alt-text handling, mirroring
-- autoColorContrastMode on the same table. NULL means "inherit the tenant's
-- own aiRemediation.altTextMode setting (or the backend default)" -- no
-- backfill needed, every existing run behaves identically to before this
-- migration. Deliberately NOT added to ComparisonTrial or PdfBatch: this is
-- the operator-facing per-client-job override ("the client supplies their
-- own alt text for this one job"), not something the admin research-trial
-- or batch-processing flows need.
--
-- Idempotent (IF NOT EXISTS), matching this repo's established migration
-- convention. Reverse with:
--   ALTER TABLE "PdfAutoRemediationRun" DROP COLUMN "autoAltTextMode";

ALTER TABLE "PdfAutoRemediationRun"
  ADD COLUMN IF NOT EXISTS "autoAltTextMode" TEXT;
