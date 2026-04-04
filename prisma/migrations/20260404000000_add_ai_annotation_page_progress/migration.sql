-- AlterTable: Add page progress tracking to AiAnnotationRun
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'AiAnnotationRun' AND column_name = 'currentPage'
  ) THEN
    ALTER TABLE "AiAnnotationRun" ADD COLUMN "currentPage" INTEGER;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'AiAnnotationRun' AND column_name = 'totalPages'
  ) THEN
    ALTER TABLE "AiAnnotationRun" ADD COLUMN "totalPages" INTEGER;
  END IF;
END $$;
