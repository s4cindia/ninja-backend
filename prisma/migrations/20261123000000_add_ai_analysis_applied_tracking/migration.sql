-- Theme A/B QC fix (docs/qc/2026-11-23-ninja-qc-karsaklian-brief.md): tracks
-- when a suggestion was actually marked 'applied', and whether a later audit
-- re-detected the identical finding anyway (the fix didn't take effect or
-- didn't persist). See AiAnalysis.appliedAt / .appliedButUnresolved in
-- schema.prisma for the full mechanism.
ALTER TABLE "AiAnalysis" ADD COLUMN IF NOT EXISTS "appliedAt" TIMESTAMP(3);
ALTER TABLE "AiAnalysis" ADD COLUMN IF NOT EXISTS "appliedButUnresolved" BOOLEAN NOT NULL DEFAULT false;
