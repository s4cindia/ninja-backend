-- Add taggedPdfPath column to CorpusDocument (idempotent)
DO $
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'CorpusDocument'
    AND column_name = 'taggedPdfPath'
  ) THEN
    ALTER TABLE "CorpusDocument" ADD COLUMN "taggedPdfPath" TEXT;
  END IF;
END $;
