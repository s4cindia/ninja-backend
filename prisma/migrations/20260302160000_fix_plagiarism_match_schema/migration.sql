-- Fix PlagiarismMatch table and enums on staging
-- The original migration (20260219100000) created the table with old enum values
-- that don't match the current Prisma schema. This migration drops and recreates
-- the table and enums with the correct values.

-- Step 1: Drop the PlagiarismMatch table (no valuable data on staging)
DROP TABLE IF EXISTS "PlagiarismMatch" CASCADE;

-- Step 2: Drop old enums and recreate with correct values
DROP TYPE IF EXISTS "PlagiarismMatchType" CASCADE;
DROP TYPE IF EXISTS "PlagiarismClassification" CASCADE;
DROP TYPE IF EXISTS "MatchReviewStatus" CASCADE;

-- Recreate PlagiarismMatchType with correct values
CREATE TYPE "PlagiarismMatchType" AS ENUM (
  'INTERNAL',
  'SELF_PLAGIARISM',
  'EXTERNAL_WEB',
  'EXTERNAL_ACADEMIC',
  'EXTERNAL_PUBLISHER'
);

-- Recreate PlagiarismClassification with correct values
CREATE TYPE "PlagiarismClassification" AS ENUM (
  'VERBATIM_COPY',
  'PARAPHRASED',
  'COMMON_PHRASE',
  'PROPERLY_CITED',
  'COINCIDENTAL',
  'NEEDS_REVIEW'
);

-- Recreate MatchReviewStatus with correct values
CREATE TYPE "MatchReviewStatus" AS ENUM (
  'PENDING',
  'CONFIRMED_PLAGIARISM',
  'FALSE_POSITIVE',
  'PROPERLY_ATTRIBUTED',
  'DISMISSED'
);

-- Step 3: Recreate PlagiarismMatch table with correct schema
CREATE TABLE "PlagiarismMatch" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "sourceChunkId" TEXT NOT NULL,
    "matchedChunkId" TEXT,
    "externalSource" TEXT,
    "externalUrl" TEXT,
    "externalTitle" TEXT,
    "matchType" "PlagiarismMatchType" NOT NULL,
    "similarityScore" DOUBLE PRECISION NOT NULL,
    "classification" "PlagiarismClassification" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "aiReasoning" TEXT,
    "sourceText" TEXT NOT NULL,
    "matchedText" TEXT NOT NULL,
    "status" "MatchReviewStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlagiarismMatch_pkey" PRIMARY KEY ("id")
);

-- Step 4: Create indexes
CREATE INDEX "PlagiarismMatch_documentId_idx" ON "PlagiarismMatch"("documentId");
CREATE INDEX "PlagiarismMatch_sourceChunkId_idx" ON "PlagiarismMatch"("sourceChunkId");
CREATE INDEX "PlagiarismMatch_matchType_idx" ON "PlagiarismMatch"("matchType");
CREATE INDEX "PlagiarismMatch_classification_idx" ON "PlagiarismMatch"("classification");
CREATE INDEX "PlagiarismMatch_status_idx" ON "PlagiarismMatch"("status");

-- Step 5: Add foreign keys
ALTER TABLE "PlagiarismMatch" ADD CONSTRAINT "PlagiarismMatch_documentId_fkey"
    FOREIGN KEY ("documentId") REFERENCES "EditorialDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PlagiarismMatch" ADD CONSTRAINT "PlagiarismMatch_sourceChunkId_fkey"
    FOREIGN KEY ("sourceChunkId") REFERENCES "EditorialTextChunk"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PlagiarismMatch" ADD CONSTRAINT "PlagiarismMatch_matchedChunkId_fkey"
    FOREIGN KEY ("matchedChunkId") REFERENCES "EditorialTextChunk"("id") ON DELETE SET NULL ON UPDATE CASCADE;
