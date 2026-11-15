-- Auto-escalate-on-stall: when an Auto Mode run would otherwise stop
-- 'stalled', optionally escalate guidance-only color-contrast/link-text
-- modes to apply-to-pdf for one more pass first. See resolveEscalateOnStall
-- and PdfAutoRemediationRun.autoStallEscalated in
-- auto-remediation-loop.service.ts.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Job' AND column_name = 'autoEscalateOnStall'
  ) THEN
    ALTER TABLE "Job" ADD COLUMN "autoEscalateOnStall" BOOLEAN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'PdfAutoRemediationRun' AND column_name = 'autoLinkTextMode'
  ) THEN
    ALTER TABLE "PdfAutoRemediationRun" ADD COLUMN "autoLinkTextMode" TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'PdfAutoRemediationRun' AND column_name = 'autoBookmarkMode'
  ) THEN
    ALTER TABLE "PdfAutoRemediationRun" ADD COLUMN "autoBookmarkMode" TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'PdfAutoRemediationRun' AND column_name = 'autoStallEscalated'
  ) THEN
    ALTER TABLE "PdfAutoRemediationRun" ADD COLUMN "autoStallEscalated" BOOLEAN NOT NULL DEFAULT false;
  END IF;
END $$;
