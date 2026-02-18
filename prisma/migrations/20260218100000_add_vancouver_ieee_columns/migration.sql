-- AlterTable (idempotent - handles case where columns already exist)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'ReferenceListEntry'
        AND column_name = 'formattedVancouver'
    ) THEN
        ALTER TABLE "ReferenceListEntry" ADD COLUMN "formattedVancouver" TEXT;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'ReferenceListEntry'
        AND column_name = 'formattedIeee'
    ) THEN
        ALTER TABLE "ReferenceListEntry" ADD COLUMN "formattedIeee" TEXT;
    END IF;
END $$;
