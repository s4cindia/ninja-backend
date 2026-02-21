-- CreateMissingEditorTables
-- This migration adds the missing Editor and Document versioning tables

-- CreateEnum: DocumentChangeType
DO $$ BEGIN
    CREATE TYPE "DocumentChangeType" AS ENUM ('INSERT', 'DELETE', 'FORMAT', 'REPLACE', 'STYLE_FIX', 'COMPLIANCE_FIX');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum: DocumentChangeStatus
DO $$ BEGIN
    CREATE TYPE "DocumentChangeStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'AUTO_APPLIED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum: EditorSessionStatus (if not exists)
DO $$ BEGIN
    CREATE TYPE "EditorSessionStatus" AS ENUM ('ACTIVE', 'EDITING', 'SAVING', 'SAVED', 'CLOSED', 'EXPIRED', 'ERROR');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateTable: DocumentVersion
CREATE TABLE IF NOT EXISTS "DocumentVersion" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "changeLog" JSONB NOT NULL,
    "snapshot" JSONB NOT NULL,
    "snapshotType" TEXT NOT NULL DEFAULT 'full',

    CONSTRAINT "DocumentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable: DocumentChange
CREATE TABLE IF NOT EXISTS "DocumentChange" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "versionId" TEXT,
    "changeType" "DocumentChangeType" NOT NULL,
    "status" "DocumentChangeStatus" NOT NULL DEFAULT 'PENDING',
    "startOffset" INTEGER NOT NULL,
    "endOffset" INTEGER NOT NULL,
    "beforeText" TEXT,
    "afterText" TEXT,
    "reason" TEXT,
    "sourceType" TEXT,
    "metadata" JSONB,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "DocumentChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable: EditorSession
CREATE TABLE IF NOT EXISTS "EditorSession" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionKey" TEXT NOT NULL,
    "status" "EditorSessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastActivity" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "metadata" JSONB,

    CONSTRAINT "EditorSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndexes: DocumentVersion
CREATE UNIQUE INDEX IF NOT EXISTS "DocumentVersion_documentId_version_key" ON "DocumentVersion"("documentId", "version");
CREATE INDEX IF NOT EXISTS "DocumentVersion_documentId_idx" ON "DocumentVersion"("documentId");
CREATE INDEX IF NOT EXISTS "DocumentVersion_createdAt_idx" ON "DocumentVersion"("createdAt");

-- CreateIndexes: DocumentChange
CREATE INDEX IF NOT EXISTS "DocumentChange_documentId_status_idx" ON "DocumentChange"("documentId", "status");
CREATE INDEX IF NOT EXISTS "DocumentChange_documentId_createdAt_idx" ON "DocumentChange"("documentId", "createdAt");
CREATE INDEX IF NOT EXISTS "DocumentChange_versionId_idx" ON "DocumentChange"("versionId");

-- CreateIndexes: EditorSession
CREATE UNIQUE INDEX IF NOT EXISTS "EditorSession_sessionKey_key" ON "EditorSession"("sessionKey");
CREATE INDEX IF NOT EXISTS "EditorSession_documentId_idx" ON "EditorSession"("documentId");
CREATE INDEX IF NOT EXISTS "EditorSession_userId_idx" ON "EditorSession"("userId");
CREATE INDEX IF NOT EXISTS "EditorSession_sessionKey_idx" ON "EditorSession"("sessionKey");
CREATE INDEX IF NOT EXISTS "EditorSession_status_idx" ON "EditorSession"("status");

-- AddForeignKey: DocumentChange.versionId -> DocumentVersion.id
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'DocumentChange_versionId_fkey'
    ) THEN
        ALTER TABLE "DocumentChange"
        ADD CONSTRAINT "DocumentChange_versionId_fkey"
        FOREIGN KEY ("versionId") REFERENCES "DocumentVersion"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;
