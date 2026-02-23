# Sprint 9.2: Workflow Agent Automation

## Overview
Implement automated workflow processing to transition EPUB/PDF files through the full accessibility workflow without manual intervention.

## Current State
- ✅ Workflow state machine defined (workflow-states.ts)
- ✅ Workflow queue infrastructure exists (workflow.queue.ts)
- ✅ HITL gates configured with timeouts (Sprint 9.1)
- ❌ Workflow worker NOT started
- ❌ No automated state transitions
- ❌ Manual trigger required for each step

## Target State
- ✅ Workflow worker running
- ✅ Automatic state transitions from upload → completion
- ✅ Automated audit execution (EPUBCheck, ACE, AI Analysis)
- ✅ Automated remediation
- ✅ Automated ACR generation
- ✅ HITL gates respected (with configured timeouts)

---

## Architecture

### Workflow Agent Service
**File:** `src/services/workflow/workflow-agent.service.ts`

**Responsibilities:**
- Listen for workflow state changes
- Trigger appropriate actions for each state
- Handle both EPUB and PDF workflows
- Respect HITL gates (pause for human review)
- Queue next state transition upon completion

### State Transition Flow

```
UPLOAD_RECEIVED
  → [Auto] trigger preprocessing
  ↓
PREPROCESSING
  → [Auto] trigger audit (EPUBCheck/Matterhorn)
  ↓
RUNNING_EPUBCHECK / RUNNING_MATTERHORN
  → [Auto] trigger ACE
  ↓
RUNNING_ACE
  → [Auto] trigger AI Analysis
  ↓
RUNNING_AI_ANALYSIS
  → [Auto] complete → AWAITING_AI_REVIEW (HITL)
  ↓
AWAITING_AI_REVIEW (HITL gate - timeout or manual)
  → [Manual/Timeout] AI_ACCEPTED
  ↓
AUTO_REMEDIATION
  → [Auto] run remediation service
  → [Auto] complete → AWAITING_REMEDIATION_REVIEW (HITL)
  ↓
AWAITING_REMEDIATION_REVIEW (HITL gate - timeout or manual)
  → [Manual/Timeout] REMEDIATION_APPROVED
  ↓
VERIFICATION_AUDIT
  → [Auto] re-audit remediated file
  → [Auto] complete → CONFORMANCE_MAPPING
  ↓
CONFORMANCE_MAPPING
  → [Auto] map issues to WCAG/Section 508
  → [Auto] complete → AWAITING_CONFORMANCE_REVIEW (HITL)
  ↓
AWAITING_CONFORMANCE_REVIEW (HITL gate - timeout or manual)
  → [Manual/Timeout] CONFORMANCE_APPROVED
  ↓
ACR_GENERATION
  → [Auto] generate ACR/VPAT
  → [Auto] complete → AWAITING_ACR_SIGNOFF (HITL)
  ↓
AWAITING_ACR_SIGNOFF (HITL gate - no timeout, manual only)
  → [Manual] ACR_SIGNED
  ↓
COMPLETED
```

---

## Implementation Tasks

### Task 1: Create Workflow Agent Service ⭐

**File:** `src/services/workflow/workflow-agent.service.ts`

**Interface:**
```typescript
class WorkflowAgentService {
  // Process workflow event after state change
  async processWorkflowState(workflowId: string): Promise<void>

  // Trigger next automated action based on current state
  private async handleUploadReceived(workflow: WorkflowInstance): Promise<void>
  private async handlePreprocessing(workflow: WorkflowInstance): Promise<void>
  private async handleRunningEpubcheck(workflow: WorkflowInstance): Promise<void>
  private async handleRunningAce(workflow: WorkflowInstance): Promise<void>
  private async handleRunningAiAnalysis(workflow: WorkflowInstance): Promise<void>
  private async handleAutoRemediation(workflow: WorkflowInstance): Promise<void>
  private async handleVerificationAudit(workflow: WorkflowInstance): Promise<void>
  private async handleConformanceMapping(workflow: WorkflowInstance): Promise<void>
  private async handleAcrGeneration(workflow: WorkflowInstance): Promise<void>

  // HITL gate handlers (just log, timeout service handles auto-advance)
  private async handleHitlGate(workflow: WorkflowInstance, gateName: string): Promise<void>
}
```

**Key Logic:**
- Each handler triggers the appropriate service
- Upon completion, enqueues next transition event
- HITL gates just log (timeout service auto-advances if configured)
- Error handling → transition to FAILED state

---

### Task 2: Enable Workflow Worker

**File:** `src/workers/index.ts`

**Changes:**
```typescript
import { startWorkflowWorker } from '../queues/workflow.queue';

export function startWorkers(): void {
  logger.info('🚀 Starting job workers...');

  // Existing workers...

  // NEW: Workflow automation worker
  if (isRedisConfigured()) {
    const workflowWorker = startWorkflowWorker();
    workers.push(workflowWorker);
    logger.info('✅ Workflow automation worker started');
  }

  // ...
}
```

---

### Task 3: Auto-Trigger Initial Workflow

**File:** `src/services/workflow/workflow.service.ts`

**Changes:**
```typescript
async createWorkflow(
  fileId: string,
  createdBy: string,
  batchId?: string,
): Promise<WorkflowInstance> {
  const id = crypto.randomUUID();
  const workflow = await prisma.workflowInstance.create({
    data: {
      id,
      fileId,
      createdBy,
      batchId,
      currentState: 'UPLOAD_RECEIVED',
      stateData: {},
    },
  });

  // NEW: Auto-trigger preprocessing
  await enqueueWorkflowEvent(id, 'PREPROCESS');

  return workflow;
}
```

**File:** `src/queues/workflow.queue.ts`

**Update worker to trigger agent:**
```typescript
async (job: Job<WorkflowJobData>) => {
  const { workflowId, event, payload } = job.data;

  logger.info(`[Queue Worker] Processing ${event} for workflow ${workflowId}`);

  const { workflowService } = await import('../services/workflow/workflow.service');
  await workflowService.transition(workflowId, event, payload as never);

  // NEW: Trigger agent to process new state
  const { workflowAgentService } = await import('../services/workflow/workflow-agent.service');
  await workflowAgentService.processWorkflowState(workflowId);

  logger.info(`[Queue Worker] Completed ${event} for workflow ${workflowId}`);
}
```

---

### Task 4: Integrate Audit Services

**Services to call:**
- `epubAuditService.runAudit(fileId)` → returns audit results
- `pdfAuditService.auditPdf(fileId)` → returns PDF audit
- `aiAnalysisService.analyzeAudit(auditResults)` → AI analysis

**Example Handler:**
```typescript
private async handleRunningEpubcheck(workflow: WorkflowInstance): Promise<void> {
  const file = await prisma.file.findUnique({ where: { id: workflow.fileId } });
  if (!file) throw new Error('File not found');

  // Run EPUBCheck
  const auditResults = await epubAuditService.runEpubCheck(file.storageKey);

  // Store results in workflow stateData
  await prisma.workflowInstance.update({
    where: { id: workflow.id },
    data: {
      stateData: {
        ...workflow.stateData,
        epubCheckResults: auditResults,
      } as unknown as Prisma.InputJsonValue,
    },
  });

  // Trigger next transition
  await enqueueWorkflowEvent(workflow.id, 'ACE_START');
}
```

---

### Task 5: Integrate Remediation Services

**Services to call:**
- `autoRemediationService.runAutoRemediation(buffer, auditJobId, fileName)`
- `pdfAutoRemediationService.autoFix(pdfPath, issues)`

**Example Handler:**
```typescript
private async handleAutoRemediation(workflow: WorkflowInstance): Promise<void> {
  const file = await prisma.file.findUnique({ where: { id: workflow.fileId } });
  if (!file) throw new Error('File not found');

  const auditResults = (workflow.stateData as any).auditResults;

  if (file.fileType === 'EPUB') {
    const result = await autoRemediationService.runAutoRemediation(
      fileBuffer,
      auditJobId,
      file.fileName
    );

    // Save remediated file
    await s3Service.uploadFile(remediatedBuffer, remediatedKey);
  } else if (file.fileType === 'PDF') {
    const result = await pdfAutoRemediationService.autoFix(filePath, auditResults.issues);
    // Save remediated PDF
  }

  // Trigger next transition
  await enqueueWorkflowEvent(workflow.id, 'REMEDIATION_DONE');
}
```

---

### Task 6: Integrate ACR Generation

**File:** `src/services/workflow/workflow-agent.service.ts`

**ACR Handler:**
```typescript
private async handleAcrGeneration(workflow: WorkflowInstance): Promise<void> {
  const file = await prisma.file.findUnique({ where: { id: workflow.fileId } });
  if (!file) throw new Error('File not found');

  // Get job with audit results
  const job = await prisma.job.findFirst({
    where: { fileId: workflow.fileId },
    orderBy: { createdAt: 'desc' },
  });

  if (!job) throw new Error('Job not found for ACR generation');

  // Generate ACR
  const acr = await acrGeneratorService.generateAcr(job.id);

  // Store ACR ID in workflow
  await prisma.workflowInstance.update({
    where: { id: workflow.id },
    data: {
      stateData: {
        ...workflow.stateData,
        acrId: acr.id,
      } as unknown as Prisma.InputJsonValue,
    },
  });

  // Trigger next transition
  await enqueueWorkflowEvent(workflow.id, 'ACR_DONE');
}
```

---

### Task 7: HITL Timeout Integration

**Already implemented in Sprint 9.1!**
- HITL timeouts configured per tenant
- Timeout service schedules auto-advance
- When timeout fires → enqueues approval event (AI_ACCEPTED, REMEDIATION_APPROVED, etc.)

**No changes needed** - just ensure agent doesn't interfere with HITL gates.

---

### Task 8: Error Handling & Retry

**All handlers wrapped in try/catch:**
```typescript
async processWorkflowState(workflowId: string): Promise<void> {
  try {
    const workflow = await workflowService.getWorkflow(workflowId);
    if (!workflow) return;

    switch (workflow.currentState) {
      case 'UPLOAD_RECEIVED':
        await this.handleUploadReceived(workflow);
        break;
      // ... other states
      default:
        logger.debug(`[WorkflowAgent] No handler for state: ${workflow.currentState}`);
    }
  } catch (error) {
    logger.error(`[WorkflowAgent] Error processing workflow ${workflowId}:`, error);

    // Transition to FAILED with error message
    await workflowService.transition(workflowId, 'ERROR', {
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}
```

---

## Testing Strategy

### Unit Tests
- `workflow-agent.service.test.ts` - Test each state handler
- Mock audit/remediation services
- Verify correct events enqueued

### Integration Tests
- `workflow-automation.integration.test.ts`
- Create workflow → verify auto-progression through states
- Test EPUB workflow end-to-end
- Test PDF workflow end-to-end
- Test error handling → FAILED state

### Manual Testing
1. Enable workflow for tenant via API
2. Upload EPUB → watch it progress automatically
3. Verify HITL gates pause correctly
4. Approve HITL gate → verify auto-resume
5. Check final ACR generated

---

## Rollout Plan

### Phase 1: Infrastructure (Week 1, Day 1-2)
- ✅ Create workflow agent service
- ✅ Enable workflow worker
- ✅ Auto-trigger on workflow creation
- ✅ Basic state handlers (logging only)
- ✅ Deploy to staging
- ✅ Test worker starts correctly

### Phase 2: Audit Automation (Week 1, Day 3-4)
- ✅ Implement PREPROCESSING handler
- ✅ Implement RUNNING_EPUBCHECK handler
- ✅ Implement RUNNING_ACE handler
- ✅ Implement RUNNING_AI_ANALYSIS handler
- ✅ Test audit automation end-to-end

### Phase 3: Remediation Automation (Week 1, Day 5)
- ✅ Implement AUTO_REMEDIATION handler
- ✅ Implement VERIFICATION_AUDIT handler
- ✅ Test remediation automation

### Phase 4: ACR Automation (Week 2, Day 1-2)
- ✅ Implement CONFORMANCE_MAPPING handler
- ✅ Implement ACR_GENERATION handler
- ✅ Test full workflow end-to-end

### Phase 5: Polish & Deploy (Week 2, Day 3)
- ✅ Error handling improvements
- ✅ Monitoring and metrics
- ✅ Documentation
- ✅ Deploy to production

---

## Success Criteria

✅ Workflow worker running in production
✅ EPUB upload → automatically audited → remediated → ACR generated
✅ PDF upload → same automated flow
✅ HITL gates pause correctly with configured timeouts
✅ Errors transition to FAILED state
✅ Full observability (logs, events tracked)
✅ <5% failure rate on automated transitions

---

## Metrics to Track

- `workflow.automation.transitions_total` - Count of automated transitions
- `workflow.automation.transition_duration` - Time per state
- `workflow.automation.failures_total` - Failures by state
- `workflow.hitl.timeout_count` - HITL gates that timed out
- `workflow.hitl.manual_approval_count` - Manual HITL approvals
- `workflow.end_to_end_duration` - Upload → Completion time

---

## Dependencies

### Existing Services (Already Built)
- ✅ `epubAuditService` - EPUB auditing
- ✅ `pdfAuditService` - PDF auditing
- ✅ `autoRemediationService` - EPUB remediation
- ✅ `pdfAutoRemediationService` - PDF remediation
- ✅ `acrGeneratorService` - ACR generation
- ✅ `workflowConfigService` - Tenant configuration
- ✅ `hitlTimeoutService` - HITL timeout scheduling

### New Services (To Build)
- 🆕 `workflowAgentService` - State automation logic
