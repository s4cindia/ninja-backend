-- Add ghost zone fields for pdfxt extraction gap tracking
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Zone' AND column_name = 'isGhost'
  ) THEN
    ALTER TABLE "Zone" ADD COLUMN "isGhost" BOOLEAN NOT NULL DEFAULT false;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Zone' AND column_name = 'ghostTag'
  ) THEN
    ALTER TABLE "Zone" ADD COLUMN "ghostTag" TEXT;
  END IF;
END $$;
