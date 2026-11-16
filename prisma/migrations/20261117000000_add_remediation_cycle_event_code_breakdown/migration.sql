DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'RemediationCycleEvent' AND column_name = 'resolvedByCode'
  ) THEN
    ALTER TABLE "RemediationCycleEvent" ADD COLUMN "resolvedByCode" JSONB;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'RemediationCycleEvent' AND column_name = 'regressionsByCode'
  ) THEN
    ALTER TABLE "RemediationCycleEvent" ADD COLUMN "regressionsByCode" JSONB;
  END IF;
END $$;
