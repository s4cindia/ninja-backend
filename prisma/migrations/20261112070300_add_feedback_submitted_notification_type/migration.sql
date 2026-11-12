-- New feedback submitted on the floating in-app feedback form now notifies
-- every ADMIN user in the submitting tenant (in-app + email), closing the
-- "no one sees it" gap ahead of UAT.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'FEEDBACK_SUBMITTED';
