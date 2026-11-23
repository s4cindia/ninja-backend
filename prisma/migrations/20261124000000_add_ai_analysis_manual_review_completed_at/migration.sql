-- Theme B3 QC fix (docs/qc/2026-11-23-ninja-qc-karsaklian-brief.md): tracks
-- when a human completes review of a requiresManualReview row (reject,
-- "Approve & apply long description", or "Keep short alt") -- distinct
-- from `status`, which can reach 'applied' the instant a short-alt
-- baseline auto-applies, long before any human has reviewed anything. See
-- AiAnalysis.manualReviewCompletedAt in schema.prisma for the full
-- mechanism.
ALTER TABLE "AiAnalysis" ADD COLUMN IF NOT EXISTS "manualReviewCompletedAt" TIMESTAMP(3);
