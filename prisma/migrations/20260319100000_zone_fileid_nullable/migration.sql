-- AlterTable: make Zone.fileId nullable for corpus calibration runs
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Zone'
    AND column_name = 'fileId'
    AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE "Zone" ALTER COLUMN "fileId" DROP NOT NULL;
  END IF;
END $$;

-- AlterEnum: add CALIBRATION_RUN to JobType
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'CALIBRATION_RUN'
    AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'JobType')
  ) THEN
    ALTER TYPE "JobType" ADD VALUE 'CALIBRATION_RUN';
  END IF;
END $$;
