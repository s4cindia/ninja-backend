-- CreateTable: Team, TeamMembership, TeamReview -- RBAC Phase 1 (production-
-- team oversight: Team Leader / Executive / Viewer roles, layered on top of
-- the existing single-owner Job model; see the RBAC design doc). Deliberately
-- separate from UserRole (ADMIN/USER/VIEWER/OPERATOR), which gates platform
-- admin and research tooling -- a different axis. Idempotent (CREATE TABLE/
-- INDEX IF NOT EXISTS, CREATE TYPE guarded with duplicate_object, guarded ADD
-- CONSTRAINT) so this is safe to re-apply against a hand-baselined database,
-- matching the convention established in 20260928010000_add_pdf_batch_processing.
-- Reverse with:
--   DROP TABLE "TeamReview";
--   DROP TABLE "TeamMembership";
--   DROP TABLE "Team";
--   DROP TYPE "ReviewOutcome";
--   DROP TYPE "TeamRole";

-- CreateEnum: TeamRole
DO $$ BEGIN
    CREATE TYPE "TeamRole" AS ENUM ('EXECUTIVE', 'TEAM_LEADER', 'VIEWER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum: ReviewOutcome
DO $$ BEGIN
    CREATE TYPE "ReviewOutcome" AS ENUM ('OK', 'NEEDS_CORRECTION');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "Team" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "TeamMembership" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "teamRole" "TeamRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamMembership_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "TeamReview" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "reviewedBy" TEXT NOT NULL,
    "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "outcome" "ReviewOutcome" NOT NULL,
    "notes" TEXT,

    CONSTRAINT "TeamReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Team_tenantId_idx" ON "Team"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "TeamMembership_teamId_userId_key" ON "TeamMembership"("teamId", "userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TeamMembership_userId_idx" ON "TeamMembership"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TeamReview_jobId_idx" ON "TeamReview"("jobId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TeamReview_reviewedBy_idx" ON "TeamReview"("reviewedBy");

-- Foreign keys (guarded so re-apply doesn't error). Scoped on
-- table_schema = current_schema() so an identically-named constraint in
-- another schema can't cause the ADD to be skipped.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'Team'
      AND constraint_name = 'Team_tenantId_fkey'
  ) THEN
    ALTER TABLE "Team"
      ADD CONSTRAINT "Team_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'TeamMembership'
      AND constraint_name = 'TeamMembership_teamId_fkey'
  ) THEN
    ALTER TABLE "TeamMembership"
      ADD CONSTRAINT "TeamMembership_teamId_fkey"
      FOREIGN KEY ("teamId") REFERENCES "Team"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'TeamMembership'
      AND constraint_name = 'TeamMembership_userId_fkey'
  ) THEN
    ALTER TABLE "TeamMembership"
      ADD CONSTRAINT "TeamMembership_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'TeamReview'
      AND constraint_name = 'TeamReview_jobId_fkey'
  ) THEN
    ALTER TABLE "TeamReview"
      ADD CONSTRAINT "TeamReview_jobId_fkey"
      FOREIGN KEY ("jobId") REFERENCES "Job"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'TeamReview'
      AND constraint_name = 'TeamReview_reviewedBy_fkey'
  ) THEN
    ALTER TABLE "TeamReview"
      ADD CONSTRAINT "TeamReview_reviewedBy_fkey"
      FOREIGN KEY ("reviewedBy") REFERENCES "User"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
