-- Add requiresManualReview flag to AiAnalysis
-- Used to mark issues where automated fix is not possible (equations, circuits, complex diagrams)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'AiAnalysis' AND column_name = 'requiresManualReview'
  ) THEN
    ALTER TABLE "AiAnalysis" ADD COLUMN "requiresManualReview" BOOLEAN NOT NULL DEFAULT false;
  END IF;
END $$;
