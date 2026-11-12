-- A Team Leader can now upload a PDF and assign it directly to an
-- Executive at creation time (Job.userId becomes the Executive, not the
-- Team Leader). These two columns record who made that assignment and
-- when -- null for every normal self-upload.
ALTER TABLE "Job" ADD COLUMN "assignedById" TEXT;
ALTER TABLE "Job" ADD COLUMN "assignedAt" TIMESTAMP(3);

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'JOB_ASSIGNED';
