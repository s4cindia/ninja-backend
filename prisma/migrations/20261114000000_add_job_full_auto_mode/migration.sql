-- Full Auto Mode: an upload-time override letting a job skip the manual
-- "Start Auto Remediation" click entirely. Null means "inherit the
-- tenant's own aiRemediation.fullAutoModeDefault setting" -- see
-- resolveFullAutoMode in auto-remediation-loop.service.ts.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Job' AND column_name = 'fullAutoMode'
  ) THEN
    ALTER TABLE "Job" ADD COLUMN "fullAutoMode" BOOLEAN;
  END IF;
END $$;
