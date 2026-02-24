-- AlterTable: Add auto-approval policy storage to BatchWorkflow
-- Stores per-batch HITL gate policies and error strategies as JSON.
ALTER TABLE "BatchWorkflow" ADD COLUMN IF NOT EXISTS "autoApprovalPolicy" JSONB;
