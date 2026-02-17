-- Remove unique constraint on (tenantId, jobId) to allow versioning
ALTER TABLE "AcrJob" DROP CONSTRAINT IF EXISTS "AcrJob_tenantId_jobId_key";

-- Add composite index for efficient version queries
CREATE INDEX IF NOT EXISTS "AcrJob_tenantId_jobId_idx" ON "AcrJob"("tenantId", "jobId");
