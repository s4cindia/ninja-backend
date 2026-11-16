-- Full QC: a per-file override gating visibility of the page-by-page
-- structure-tag review mode on a job's Audit Results page. Null means
-- "inherit the tenant's own aiRemediation.fullQCDefault setting" -- see
-- resolveFullQC in auto-remediation-loop.service.ts. Unlike fullAutoMode/
-- autoEscalateOnStall, set only at upload time (not exposed on
-- GET/PATCH /pdf/:jobId/settings for later editing).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Job' AND column_name = 'fullQC'
  ) THEN
    ALTER TABLE "Job" ADD COLUMN "fullQC" BOOLEAN;
  END IF;
END $$;
