-- Two new NotificationType values so the QC <-> Executive review loop can
-- notify through the existing Notification system (TeamReview gate feature).
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'TEAM_REVIEW_NEEDS_CORRECTION';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'TEAM_REVIEW_RESUBMIT_REQUESTED';
