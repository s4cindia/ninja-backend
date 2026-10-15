-- Enforce at most one ACTIVE (unreleased) PdfConcurrencyLease per batch item.
-- CodeRabbit finding on PR #633, left open at the time (no caller of
-- acquireLease/waitForLease existed yet to make it load-bearing): without
-- this, two workers racing to process the same PdfBatchItem could each
-- insert an unreleased lease, double-processing the item and double-
-- charging the tenant's concurrency budget. Closed now because the
-- PdfBatch orchestrator being built is the first real caller of
-- concurrency-budget.service.ts's leasing primitives.
--
-- A partial unique index (not a plain @@unique, which Prisma's schema
-- language can't express with a WHERE clause) -- only rows with
-- "releasedAt" IS NULL participate in the uniqueness check, so a batch
-- item can accumulate any number of past (released) leases across its
-- 'audit' and 'auto_remediation' phases, just never more than one active
-- one at a time. Idempotent (IF NOT EXISTS), matching this repo's
-- established migration convention. Reverse with:
--   DROP INDEX "PdfConcurrencyLease_batchItemId_active_key";

CREATE UNIQUE INDEX IF NOT EXISTS "PdfConcurrencyLease_batchItemId_active_key"
  ON "PdfConcurrencyLease"("batchItemId")
  WHERE "releasedAt" IS NULL;
