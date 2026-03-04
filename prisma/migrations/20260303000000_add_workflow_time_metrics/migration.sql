-- Add Workflow Time Metrics tables (Sprint 10)
-- WorkflowTimeMetric, HITLGateMetric, BatchTimeMetric

-- WorkflowTimeMetric: one row per workflow, accumulates timing across all states
CREATE TABLE IF NOT EXISTS "WorkflowTimeMetric" (
    "id"                 TEXT NOT NULL,
    "workflowId"         TEXT NOT NULL,
    "tenantId"           TEXT NOT NULL,
    "batchId"            TEXT,
    "workflowType"       TEXT NOT NULL,
    "startedAt"          TIMESTAMP(3) NOT NULL,
    "completedAt"        TIMESTAMP(3),
    "totalElapsedMs"     INTEGER,
    "machineTimeMs"      INTEGER NOT NULL DEFAULT 0,
    "humanWaitMs"        INTEGER NOT NULL DEFAULT 0,
    "humanActiveMs"      INTEGER NOT NULL DEFAULT 0,
    "idleTimeMs"         INTEGER,
    "gateCount"          INTEGER NOT NULL DEFAULT 0,
    "autoApprovedCount"  INTEGER NOT NULL DEFAULT 0,
    "manualReviewCount"  INTEGER NOT NULL DEFAULT 0,
    "stateBreakdown"     JSONB NOT NULL DEFAULT '{}',
    "lastState"          TEXT,
    "lastStateEnteredAt" TIMESTAMP(3),
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowTimeMetric_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "WorkflowTimeMetric_workflowId_key" ON "WorkflowTimeMetric"("workflowId");
CREATE INDEX IF NOT EXISTS "WorkflowTimeMetric_tenantId_idx" ON "WorkflowTimeMetric"("tenantId");
CREATE INDEX IF NOT EXISTS "WorkflowTimeMetric_batchId_idx" ON "WorkflowTimeMetric"("batchId");

-- HITLGateMetric: one row per gate encounter per workflow
CREATE TABLE IF NOT EXISTS "HITLGateMetric" (
    "id"                TEXT NOT NULL,
    "workflowId"        TEXT NOT NULL,
    "timeMetricId"      TEXT NOT NULL,
    "tenantId"          TEXT NOT NULL,
    "gate"              TEXT NOT NULL,
    "gateEnteredAt"     TIMESTAMP(3) NOT NULL,
    "reviewStartedAt"   TIMESTAMP(3),
    "reviewSubmittedAt" TIMESTAMP(3),
    "waitMs"            INTEGER,
    "activeMs"          INTEGER,
    "autoApproved"      BOOLEAN NOT NULL DEFAULT false,
    "reviewerId"        TEXT,
    "sessionCount"      INTEGER NOT NULL DEFAULT 0,
    "sessionLog"        JSONB NOT NULL DEFAULT '[]',
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HITLGateMetric_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "HITLGateMetric_workflowId_idx" ON "HITLGateMetric"("workflowId");
CREATE INDEX IF NOT EXISTS "HITLGateMetric_tenantId_gate_idx" ON "HITLGateMetric"("tenantId", "gate");

-- BatchTimeMetric: one row per batch, aggregated from all workflow metrics
CREATE TABLE IF NOT EXISTS "BatchTimeMetric" (
    "id"                  TEXT NOT NULL,
    "batchId"             TEXT NOT NULL,
    "tenantId"            TEXT NOT NULL,
    "batchStartedAt"      TIMESTAMP(3) NOT NULL,
    "batchCompletedAt"    TIMESTAMP(3),
    "totalElapsedMs"      INTEGER,
    "totalFiles"          INTEGER NOT NULL,
    "completedFiles"      INTEGER NOT NULL DEFAULT 0,
    "failedFiles"         INTEGER NOT NULL DEFAULT 0,
    "totalMachineMs"      INTEGER NOT NULL DEFAULT 0,
    "totalHumanWaitMs"    INTEGER NOT NULL DEFAULT 0,
    "totalHumanActiveMs"  INTEGER NOT NULL DEFAULT 0,
    "avgWorkflowTimeMs"   INTEGER,
    "autoApprovalRate"    DOUBLE PRECISION,
    "humanTimeSavedMs"    INTEGER,
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BatchTimeMetric_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BatchTimeMetric_batchId_key" ON "BatchTimeMetric"("batchId");
CREATE INDEX IF NOT EXISTS "BatchTimeMetric_tenantId_idx" ON "BatchTimeMetric"("tenantId");

-- Foreign keys (idempotent via DO blocks)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'WorkflowTimeMetric_workflowId_fkey') THEN
    ALTER TABLE "WorkflowTimeMetric" ADD CONSTRAINT "WorkflowTimeMetric_workflowId_fkey"
      FOREIGN KEY ("workflowId") REFERENCES "WorkflowInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'HITLGateMetric_workflowId_fkey') THEN
    ALTER TABLE "HITLGateMetric" ADD CONSTRAINT "HITLGateMetric_workflowId_fkey"
      FOREIGN KEY ("workflowId") REFERENCES "WorkflowInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'HITLGateMetric_timeMetricId_fkey') THEN
    ALTER TABLE "HITLGateMetric" ADD CONSTRAINT "HITLGateMetric_timeMetricId_fkey"
      FOREIGN KEY ("timeMetricId") REFERENCES "WorkflowTimeMetric"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BatchTimeMetric_batchId_fkey') THEN
    ALTER TABLE "BatchTimeMetric" ADD CONSTRAINT "BatchTimeMetric_batchId_fkey"
      FOREIGN KEY ("batchId") REFERENCES "BatchWorkflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
