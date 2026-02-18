-- AddWorkflowAgentModels
-- Sprint 9: WorkflowInstance, BatchWorkflow, HITLDecision, RemediationItem, WorkflowEvent

-- CreateTable: WorkflowInstance
CREATE TABLE "WorkflowInstance" (
    "id" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "batchId" TEXT,
    "currentState" TEXT NOT NULL DEFAULT 'UPLOAD_RECEIVED',
    "stateData" JSONB NOT NULL DEFAULT '{}',
    "priority" INTEGER NOT NULL DEFAULT 5,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "loopCount" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "WorkflowInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable: BatchWorkflow
CREATE TABLE "BatchWorkflow" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "totalFiles" INTEGER NOT NULL,
    "concurrency" INTEGER NOT NULL DEFAULT 3,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdBy" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "BatchWorkflow_pkey" PRIMARY KEY ("id")
);

-- CreateTable: HITLDecision
CREATE TABLE "HITLDecision" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "gate" TEXT NOT NULL,
    "itemType" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "originalValue" JSONB NOT NULL,
    "modifiedValue" JSONB,
    "justification" TEXT,
    "reviewerId" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HITLDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable: RemediationItem
CREATE TABLE "RemediationItem" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "auditFindingId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "autoFixApplied" BOOLEAN NOT NULL DEFAULT false,
    "autoFixDetail" JSONB,
    "requiresManual" BOOLEAN NOT NULL DEFAULT false,
    "manualFixApplied" BOOLEAN NOT NULL DEFAULT false,
    "manualFixDetail" JSONB,
    "fixedBy" TEXT,
    "fixedAt" TIMESTAMP(3),
    "wcagCriterion" TEXT NOT NULL,
    "aiSuggestion" JSONB,

    CONSTRAINT "RemediationItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable: WorkflowEvent
CREATE TABLE "WorkflowEvent" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "fromState" TEXT,
    "toState" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkflowInstance_currentState_idx" ON "WorkflowInstance"("currentState");
CREATE INDEX "WorkflowInstance_batchId_idx" ON "WorkflowInstance"("batchId");
CREATE INDEX "WorkflowInstance_createdBy_idx" ON "WorkflowInstance"("createdBy");
CREATE INDEX "WorkflowInstance_fileId_idx" ON "WorkflowInstance"("fileId");

CREATE INDEX "BatchWorkflow_status_idx" ON "BatchWorkflow"("status");
CREATE INDEX "BatchWorkflow_createdBy_idx" ON "BatchWorkflow"("createdBy");

CREATE INDEX "HITLDecision_workflowId_gate_idx" ON "HITLDecision"("workflowId", "gate");
CREATE INDEX "HITLDecision_reviewerId_idx" ON "HITLDecision"("reviewerId");

CREATE INDEX "RemediationItem_workflowId_category_idx" ON "RemediationItem"("workflowId", "category");
CREATE INDEX "RemediationItem_workflowId_requiresManual_manualFixApplied_idx" ON "RemediationItem"("workflowId", "requiresManual", "manualFixApplied");

CREATE INDEX "WorkflowEvent_workflowId_timestamp_idx" ON "WorkflowEvent"("workflowId", "timestamp");

-- AddForeignKey
ALTER TABLE "WorkflowInstance" ADD CONSTRAINT "WorkflowInstance_fileId_fkey"
    FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WorkflowInstance" ADD CONSTRAINT "WorkflowInstance_batchId_fkey"
    FOREIGN KEY ("batchId") REFERENCES "BatchWorkflow"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WorkflowInstance" ADD CONSTRAINT "WorkflowInstance_createdBy_fkey"
    FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "BatchWorkflow" ADD CONSTRAINT "BatchWorkflow_createdBy_fkey"
    FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "HITLDecision" ADD CONSTRAINT "HITLDecision_workflowId_fkey"
    FOREIGN KEY ("workflowId") REFERENCES "WorkflowInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "HITLDecision" ADD CONSTRAINT "HITLDecision_reviewerId_fkey"
    FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RemediationItem" ADD CONSTRAINT "RemediationItem_workflowId_fkey"
    FOREIGN KEY ("workflowId") REFERENCES "WorkflowInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RemediationItem" ADD CONSTRAINT "RemediationItem_fixedBy_fkey"
    FOREIGN KEY ("fixedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WorkflowEvent" ADD CONSTRAINT "WorkflowEvent_workflowId_fkey"
    FOREIGN KEY ("workflowId") REFERENCES "WorkflowInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;
