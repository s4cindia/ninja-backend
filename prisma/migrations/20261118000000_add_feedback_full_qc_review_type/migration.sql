-- New feedback type for notes/flags filed during the Full QC page-by-page
-- structure-tag review (Structure Tag QC Review plan, section 4,
-- 2026-11-18) -- reuses the existing Feedback model rather than a second
-- feedback mechanism.
ALTER TYPE "FeedbackType" ADD VALUE IF NOT EXISTS 'FULL_QC_REVIEW';
