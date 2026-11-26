-- CreateTable: ZoneDetectionCache -- caches a YOLO zone-detector result
-- (seam-c-tag.service.ts) keyed on (source PDF bytes, weights identity,
-- deploy version, detection params) so the exact same input never calls
-- the GPU service twice. Second, independent layer alongside the
-- zone-detector service's own cuDNN-deterministic-mode fix (see
-- zone-detector-service/main.py) for the real T4 run-to-run Figure-count
-- divergence this closes. Tenant-scoped (never a global/shared cache), so
-- a cache row is deletable per-tenant for a data-retention request.
-- Idempotent (CREATE TABLE/INDEX IF NOT EXISTS + guarded ADD CONSTRAINT),
-- matching this repo's hand-baselined-database convention.
-- Reverse with: `DROP TABLE "ZoneDetectionCache";`.

CREATE TABLE IF NOT EXISTS "ZoneDetectionCache" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "cacheKey" TEXT NOT NULL,
    "sourcePdfSha256" TEXT NOT NULL,
    "weightsUri" TEXT NOT NULL,
    "weightsETag" TEXT NOT NULL,
    "zoneDetectorVersion" TEXT NOT NULL,
    "reportedWeightsSha256" TEXT,
    "zones" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ZoneDetectionCache_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ZoneDetectionCache_tenantId_cacheKey_key"
    ON "ZoneDetectionCache"("tenantId", "cacheKey");

CREATE INDEX IF NOT EXISTS "ZoneDetectionCache_tenantId_sourcePdfSha256_idx"
    ON "ZoneDetectionCache"("tenantId", "sourcePdfSha256");

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'ZoneDetectionCache'
      AND constraint_name = 'ZoneDetectionCache_tenantId_fkey'
  ) THEN
    ALTER TABLE "ZoneDetectionCache"
      ADD CONSTRAINT "ZoneDetectionCache_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
