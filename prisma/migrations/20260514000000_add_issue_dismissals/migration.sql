-- CreateTable: IssueDismissal — per-instance audit-issue dismissals.
-- Idempotent (CREATE TABLE / INDEX IF NOT EXISTS + guarded ADD CONSTRAINT)
-- so the migration is safe to re-apply against a hand-baselined database.
-- Reverse with `DROP TABLE "IssueDismissal";`.

CREATE TABLE IF NOT EXISTS "IssueDismissal" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "instanceKey" TEXT NOT NULL,
    "dismissedBy" TEXT NOT NULL,
    "dismissedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" VARCHAR(280),

    CONSTRAINT "IssueDismissal_pkey" PRIMARY KEY ("id")
);

-- Indexes.
CREATE UNIQUE INDEX IF NOT EXISTS "IssueDismissal_jobId_instanceKey_key"
    ON "IssueDismissal"("jobId", "instanceKey");
CREATE INDEX IF NOT EXISTS "IssueDismissal_jobId_idx"
    ON "IssueDismissal"("jobId");
CREATE INDEX IF NOT EXISTS "IssueDismissal_code_idx"
    ON "IssueDismissal"("code");

-- Foreign key (guarded so re-apply doesn't error). Scoped on
-- table_schema = current_schema() so an identically-named constraint
-- in another schema can't cause the ADD to be skipped.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'IssueDismissal'
      AND constraint_name = 'IssueDismissal_jobId_fkey'
  ) THEN
    ALTER TABLE "IssueDismissal"
      ADD CONSTRAINT "IssueDismissal_jobId_fkey"
      FOREIGN KEY ("jobId") REFERENCES "Job"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
