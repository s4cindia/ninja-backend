-- EPUB-from-certified-PDF, Phase 0 (B3b): cached sha256 of the job's
-- remediated PDF, bound to the storage object it was computed from.
--
-- Job.remediatedSha256            hex sha256 of the object's bytes
-- Job.remediatedSha256Ref         S3 key / local path that was hashed
-- Job.remediatedSha256Fingerprint ETag + versionId (S3) or size + mtime
--                                 (local) of that object when hashed
-- Job.remediatedSha256At          when it was hashed
--
-- A cache only: every reader re-checks the fingerprint with a HEAD and
-- re-hashes on mismatch, so a null or stale row is never trusted.
--
-- Idempotent, matching this repo's hand-baselined-database convention.
-- Reverse with:
--   ALTER TABLE "Job" DROP COLUMN "remediatedSha256", DROP COLUMN "remediatedSha256Ref",
--     DROP COLUMN "remediatedSha256Fingerprint", DROP COLUMN "remediatedSha256At";

ALTER TABLE "Job"
  ADD COLUMN IF NOT EXISTS "remediatedSha256" TEXT,
  ADD COLUMN IF NOT EXISTS "remediatedSha256Ref" TEXT,
  ADD COLUMN IF NOT EXISTS "remediatedSha256Fingerprint" TEXT,
  ADD COLUMN IF NOT EXISTS "remediatedSha256At" TIMESTAMP(3);
