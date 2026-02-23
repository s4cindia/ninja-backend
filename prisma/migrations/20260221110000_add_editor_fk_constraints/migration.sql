-- AddForeignKeyConstraints for Editor and Document Versioning tables
-- This migration adds proper FK relations to prevent orphaned records

-- Add FK for DocumentVersion.documentId -> EditorialDocument.id
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'DocumentVersion_documentId_fkey'
    ) THEN
        ALTER TABLE "DocumentVersion"
        ADD CONSTRAINT "DocumentVersion_documentId_fkey"
        FOREIGN KEY ("documentId") REFERENCES "EditorialDocument"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- Add FK for DocumentChange.documentId -> EditorialDocument.id
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'DocumentChange_documentId_fkey'
    ) THEN
        ALTER TABLE "DocumentChange"
        ADD CONSTRAINT "DocumentChange_documentId_fkey"
        FOREIGN KEY ("documentId") REFERENCES "EditorialDocument"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- Add FK for EditorSession.documentId -> EditorialDocument.id
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'EditorSession_documentId_fkey'
    ) THEN
        ALTER TABLE "EditorSession"
        ADD CONSTRAINT "EditorSession_documentId_fkey"
        FOREIGN KEY ("documentId") REFERENCES "EditorialDocument"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- Add FK for EditorSession.userId -> User.id
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'EditorSession_userId_fkey'
    ) THEN
        ALTER TABLE "EditorSession"
        ADD CONSTRAINT "EditorSession_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "User"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
