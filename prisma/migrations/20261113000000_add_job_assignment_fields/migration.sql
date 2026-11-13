-- A Team Leader can now upload a PDF and assign it directly to an
-- Executive at creation time (Job.userId becomes the Executive, not the
-- Team Leader). These two columns record who made that assignment and
-- when -- null for every normal self-upload.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Job' AND column_name = 'assignedById'
  ) THEN
    ALTER TABLE "Job" ADD COLUMN "assignedById" TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Job' AND column_name = 'assignedAt'
  ) THEN
    ALTER TABLE "Job" ADD COLUMN "assignedAt" TIMESTAMP(3);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'JOB_ASSIGNED'
    AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'NotificationType')
  ) THEN
    ALTER TYPE "NotificationType" ADD VALUE 'JOB_ASSIGNED';
  END IF;
END $$;
