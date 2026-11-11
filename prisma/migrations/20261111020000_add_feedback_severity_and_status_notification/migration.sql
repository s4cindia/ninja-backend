-- Feedback severity (for the UAT/defect-logging extension) and a new
-- NotificationType so a feedback submitter is notified when its status
-- changes.
DO $$ BEGIN
  CREATE TYPE "FeedbackSeverity" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "Feedback" ADD COLUMN IF NOT EXISTS "severity" "FeedbackSeverity";
CREATE INDEX IF NOT EXISTS "Feedback_severity_idx" ON "Feedback"("severity");

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'FEEDBACK_STATUS_CHANGED';
