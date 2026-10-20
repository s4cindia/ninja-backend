-- Tracks how many times applyApprovedSuggestions has failed to apply a given
-- AiAnalysis row. Real incident (2026-10-20, Math_Olszewski_PDF.pdf): a
-- suggestion whose apply handler fails for a structural reason that never
-- changes (e.g. the PDF genuinely has no Figure element for this image)
-- stayed 'approved' forever and was silently re-approved and re-attempted
-- every single auto-mode round, burning that round's AI analysis cost on a
-- guaranteed repeat failure -- confirmed live: the same ~190 suggestion IDs
-- failed with the identical error message in all 3 rounds. Once
-- failedAttempts reaches MAX_APPLY_ATTEMPTS (ai-analysis.service.ts), the row
-- is marked 'failed' (terminal, excluded from actionableFound's
-- pending/approved query) instead of being retried forever.
--
-- Nullable with a default of 0: every existing row behaves identically to
-- before this migration (0 failures recorded so far), no backfill needed.
--
-- Idempotent (IF NOT EXISTS), matching this repo's established migration
-- convention. Reverse with:
--   ALTER TABLE "AiAnalysis" DROP COLUMN "failedAttempts";

ALTER TABLE "AiAnalysis"
  ADD COLUMN IF NOT EXISTS "failedAttempts" INTEGER NOT NULL DEFAULT 0;
