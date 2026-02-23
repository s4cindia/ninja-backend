/**
 * Workflow Agent Shared Contracts
 * Sprint 9-11 | Created on main branch — READ ONLY for all terminals
 *
 * This file is the single source of truth for all workflow types.
 * ALL terminals import from here. NONE modify it.
 * Changes require a main-branch commit followed by branch rebases.
 */

import { z } from 'zod';

// ============================================================
// ENUMS (as const for runtime access + TypeScript types)
// ============================================================

export const WorkflowState = {
  // Auto states — machine transitions automatically
  UPLOAD_RECEIVED: 'UPLOAD_RECEIVED',
  PREPROCESSING: 'PREPROCESSING',
  RUNNING_EPUBCHECK: 'RUNNING_EPUBCHECK',
  RUNNING_ACE: 'RUNNING_ACE',
  RUNNING_AI_ANALYSIS: 'RUNNING_AI_ANALYSIS',
  AUTO_REMEDIATION: 'AUTO_REMEDIATION',
  VERIFICATION_AUDIT: 'VERIFICATION_AUDIT',
  CONFORMANCE_MAPPING: 'CONFORMANCE_MAPPING',
  ACR_GENERATION: 'ACR_GENERATION',
  // HITL states — machine suspends, waits for human decision
  AWAITING_AI_REVIEW: 'AWAITING_AI_REVIEW',
  AWAITING_REMEDIATION_REVIEW: 'AWAITING_REMEDIATION_REVIEW',
  AWAITING_CONFORMANCE_REVIEW: 'AWAITING_CONFORMANCE_REVIEW',
  AWAITING_ACR_SIGNOFF: 'AWAITING_ACR_SIGNOFF',
  // Terminal states
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  RETRYING: 'RETRYING',
  CANCELLED: 'CANCELLED',
  HITL_TIMEOUT: 'HITL_TIMEOUT',
  PAUSED: 'PAUSED',
} as const;

export type WorkflowState = typeof WorkflowState[keyof typeof WorkflowState];

export const HITLGate = {
  AI_REVIEW: 'AI_REVIEW',
  REMEDIATION_REVIEW: 'REMEDIATION_REVIEW',
  CONFORMANCE_REVIEW: 'CONFORMANCE_REVIEW',
  ACR_SIGNOFF: 'ACR_SIGNOFF',
} as const;

export type HITLGate = typeof HITLGate[keyof typeof HITLGate];

export const HITLAction = {
  ACCEPT: 'ACCEPT',
  REJECT: 'REJECT',
  MODIFY: 'MODIFY',
  OVERRIDE: 'OVERRIDE',
  MANUAL_FIX: 'MANUAL_FIX',
} as const;

export type HITLAction = typeof HITLAction[keyof typeof HITLAction];

export const RemediationCategory = {
  ALT_TEXT: 'ALT_TEXT',
  TABLE_HEADERS: 'TABLE_HEADERS',
  READING_ORDER: 'READING_ORDER',
  CONTRAST: 'CONTRAST',
  LANG: 'LANG',
  HEADING: 'HEADING',
  METADATA: 'METADATA',
  ARIA: 'ARIA',
  DESCRIPTION: 'DESCRIPTION',
  DUPLICATE_ID: 'DUPLICATE_ID',
  PAGE_LIST: 'PAGE_LIST',
  OTHER: 'OTHER',
} as const;

export type RemediationCategory = typeof RemediationCategory[keyof typeof RemediationCategory];

export const BatchStatus = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  PAUSED: 'PAUSED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
} as const;

export type BatchStatus = typeof BatchStatus[keyof typeof BatchStatus];

export const ConfidenceLevel = {
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
  MANUAL_REQUIRED: 'MANUAL_REQUIRED',
} as const;

export type ConfidenceLevel = typeof ConfidenceLevel[keyof typeof ConfidenceLevel];

// ============================================================
// BATCH AGENTIC POLICY TYPES
// ============================================================

/**
 * Per-gate approval policy for batch agentic workflows.
 * 'auto-accept' — gate is skipped (machine approves automatically).
 * 'require-manual' — gate pauses for human review (default behavior).
 */
export type BatchGatePolicy = 'auto-accept' | 'require-manual';

/**
 * Error handling strategy when a workflow within a batch fails.
 * 'pause-batch'     — pause all non-terminal sibling workflows.
 * 'continue-others' — only the failing workflow is marked FAILED; others continue.
 * 'fail-batch'      — immediately cancel all non-terminal sibling workflows.
 */
export type BatchErrorStrategy = 'pause-batch' | 'continue-others' | 'fail-batch';

/**
 * Defines the automatic-approval and error-handling behaviour for a batch run.
 * Stored in BatchWorkflow.autoApprovalPolicy (JSON).
 */
export interface BatchAutoApprovalPolicy {
  gates: {
    AI_REVIEW?: BatchGatePolicy;
    REMEDIATION_REVIEW?: BatchGatePolicy;
    CONFORMANCE_REVIEW?: BatchGatePolicy;
    ACR_SIGNOFF?: BatchGatePolicy;
  };
  onError: BatchErrorStrategy;
}

// ============================================================
// CORE DOMAIN INTERFACES
// ============================================================

/** A single pending review item at a HITL gate */
export interface HITLReviewItem {
  id: string;
  gate: HITLGate;
  itemType: string;                    // 'alt_text' | 'table' | 'reading_order' | 'conformance' | 'acr'
  itemId: string;
  originalValue: unknown;
  confidence?: ConfidenceLevel;
  aiSuggestion?: unknown;
  requiresManual?: boolean;
}

/** A single remediation item (auto-fixed or needs manual fix) */
export interface RemediationItemData {
  id: string;
  workflowId: string;
  auditFindingId: string;
  category: RemediationCategory;
  autoFixApplied: boolean;
  autoFixDetail?: { before: unknown; after: unknown };
  requiresManual: boolean;
  manualFixApplied: boolean;
  manualFixDetail?: { before: unknown; after: unknown };
  fixedBy?: string;
  fixedAt?: string;
  wcagCriterion: string;
  aiSuggestion?: unknown;
}

/** HITL gate status summary */
export interface GateStatus {
  total: number;
  reviewed: number;
  pending: number;
}

// ============================================================
// API REQUEST INTERFACES
// ============================================================

/** POST /api/v1/workflows */
export interface StartWorkflowRequest {
  fileId: string;
  vpatEditions?: string[];             // 'VPAT2.5-508' | 'VPAT2.5-WCAG' | 'VPAT2.5-EU' | 'VPAT2.5-INT'
}

/** POST /api/v1/workflows/:id/pause|resume|cancel|retry */
export interface WorkflowActionBody {
  reason?: string;
}

/** POST /api/v1/workflows/:id/hitl/ai-review */
export interface AIReviewDecisionRequest {
  decisions: Array<{
    itemId: string;
    decision: HITLAction;
    modifiedValue?: unknown;
    justification?: string;
  }>;
}

/** POST /api/v1/workflows/:id/hitl/remediation-fix */
export interface RemediationFixRequest {
  itemId: string;
  fixDetail: {
    before: unknown;
    after: unknown;
    notes?: string;
  };
}

/** POST /api/v1/workflows/:id/hitl/remediation-review */
export interface RemediationReviewRequest {
  notes?: string;
}

/** POST /api/v1/workflows/:id/hitl/conformance-review */
export interface ConformanceReviewRequest {
  decisions: Array<{
    criterionId: string;
    decision: 'CONFIRM' | 'OVERRIDE';
    overrideValue?: string;            // New conformance level
    justification?: string;            // Required for OVERRIDE
  }>;
}

/** POST /api/v1/workflows/:id/hitl/acr-signoff */
export interface ACRSignoffRequest {
  attestation: {
    text: string;                      // Must be non-empty
    confirmed: boolean;                // Must be true
  };
  notes?: string;
}

/** POST /api/v1/workflows/batch */
export interface StartBatchRequest {
  name: string;
  fileIds: string[];
  concurrency?: number;                // Default: 3
  vpatEditions?: string[];
  autoApprovalPolicy?: BatchAutoApprovalPolicy;
}

// ============================================================
// API RESPONSE INTERFACES
// ============================================================

/** Workflow timeline event */
export interface WorkflowEventRecord {
  id: string;
  eventType: string;
  fromState?: WorkflowState;
  toState?: WorkflowState;
  payload: unknown;
  timestamp: string;
}

/** GET /api/v1/workflows/:id */
export interface WorkflowStatusResponse {
  id: string;
  fileId: string;
  currentState: WorkflowState;
  phase: 'ingest' | 'audit' | 'remediate' | 'certify' | 'complete' | 'failed';
  progress: number;                    // 0-100
  startedAt: string;
  completedAt?: string;
  errorMessage?: string;
  retryCount: number;
  loopCount: number;
  createdBy: string;
  batchId?: string;
  stateData?: Record<string, unknown>;
}

/** GET /api/v1/workflows/:id/timeline */
export interface WorkflowTimelineResponse {
  workflowId: string;
  events: WorkflowEventRecord[];
}

/** HITL decision record */
export interface HITLDecisionRecord {
  id: string;
  gate: HITLGate;
  itemType: string;
  itemId: string;
  decision: HITLAction;
  originalValue: unknown;
  modifiedValue?: unknown;
  justification?: string;
  reviewerId: string;
  decidedAt: string;
}

/** GET /api/v1/batches/:id */
export interface BatchDashboardResponse {
  id: string;
  name: string;
  totalFiles: number;
  status: BatchStatus;
  metrics: {
    perStage: Record<string, number>;
    perGate: Record<HITLGate, number>;
    avgTimeMs?: number;
    etaMs?: number;
    completedCount: number;
    failedCount: number;
    errorCount: number;
  };
  startedAt: string;
  completedAt?: string;
  autoApprovalPolicy?: BatchAutoApprovalPolicy;
}

// ============================================================
// WEBSOCKET EVENT TYPES
// ============================================================

/** Emitted on every state machine transition */
export interface WorkflowStateChangeEvent {
  workflowId: string;
  from: WorkflowState;
  to: WorkflowState;
  timestamp: string;
  phase: string;
}

/** Emitted when a workflow reaches a HITL gate */
export interface HITLRequiredEvent {
  workflowId: string;
  gate: HITLGate;
  itemCount: number;
  deepLink: string;                    // URL to the review page
  timeoutAt?: string;                  // ISO timestamp of deadline
}

/** Emitted as remediation items are processed */
export interface RemediationProgressEvent {
  workflowId: string;
  autoFixed: number;
  manualPending: number;
  manualComplete: number;
  total: number;
}

/** Emitted on workflow errors */
export interface WorkflowErrorEvent {
  workflowId: string;
  error: string;
  state: WorkflowState;
  retryable: boolean;
  retryCount: number;
}

/** Emitted as batch files progress */
export interface BatchProgressEvent {
  batchId: string;
  completed: number;
  total: number;
  currentStages: Record<string, number>;
  failedCount: number;
}

// ============================================================
// ZOD SCHEMAS (runtime validation — mirrors interfaces above)
// ============================================================

export const workflowStateSchema = z.enum([
  'UPLOAD_RECEIVED', 'PREPROCESSING', 'RUNNING_EPUBCHECK', 'RUNNING_ACE',
  'RUNNING_AI_ANALYSIS', 'AWAITING_AI_REVIEW', 'AUTO_REMEDIATION',
  'AWAITING_REMEDIATION_REVIEW', 'VERIFICATION_AUDIT', 'CONFORMANCE_MAPPING',
  'AWAITING_CONFORMANCE_REVIEW', 'ACR_GENERATION', 'AWAITING_ACR_SIGNOFF',
  'COMPLETED', 'FAILED', 'RETRYING', 'CANCELLED', 'HITL_TIMEOUT', 'PAUSED',
]);

export const hitlGateSchema = z.enum([
  'AI_REVIEW', 'REMEDIATION_REVIEW', 'CONFORMANCE_REVIEW', 'ACR_SIGNOFF',
]);

export const hitlActionSchema = z.enum([
  'ACCEPT', 'REJECT', 'MODIFY', 'OVERRIDE', 'MANUAL_FIX',
]);

export const startWorkflowSchema = z.object({
  fileId: z.string().uuid('fileId must be a valid UUID'),
  vpatEditions: z.array(z.string()).optional(),
});

export const aiReviewDecisionSchema = z.object({
  decisions: z.array(z.object({
    itemId: z.string().min(1, 'Item ID required'),
    decision: hitlActionSchema,
    modifiedValue: z.unknown().optional(),
    justification: z.string().optional(),
  })).min(1, 'At least one decision required'),
});

export const remediationFixSchema = z.object({
  itemId: z.string().uuid(),
  fixDetail: z.object({
    before: z.unknown(),
    after: z.unknown(),
    notes: z.string().optional(),
  }),
});

export const remediationReviewSchema = z.object({
  notes: z.string().optional(),
});

export const conformanceReviewSchema = z.object({
  decisions: z.array(z.object({
    criterionId: z.string(),
    decision: z.enum(['CONFIRM', 'OVERRIDE']),
    overrideValue: z.string().optional(),
    justification: z.string().optional(),
  })).min(1),
});

export const acrSignoffSchema = z.object({
  attestation: z.object({
    text: z.string().min(1, 'Attestation text is required'),
    confirmed: z.literal(true).describe('Attestation must be confirmed'),
  }),
  notes: z.string().optional(),
});

export const batchGatePolicySchema = z.enum(['auto-accept', 'require-manual']);

export const batchErrorStrategySchema = z.enum(['pause-batch', 'continue-others', 'fail-batch']);

export const batchAutoApprovalPolicySchema = z.object({
  gates: z.object({
    AI_REVIEW: batchGatePolicySchema.optional(),
    REMEDIATION_REVIEW: batchGatePolicySchema.optional(),
    CONFORMANCE_REVIEW: batchGatePolicySchema.optional(),
    ACR_SIGNOFF: batchGatePolicySchema.optional(),
  }),
  onError: batchErrorStrategySchema,
});

export const startBatchSchema = z.object({
  name: z.string().min(1, 'Batch name is required'),
  fileIds: z.array(z.string().uuid()).min(1, 'At least one file required'),
  concurrency: z.number().int().min(1).max(10).default(3),
  vpatEditions: z.array(z.string()).optional(),
  autoApprovalPolicy: batchAutoApprovalPolicySchema.optional(),
});

export const workflowParamsSchema = z.object({
  id: z.string().uuid('Workflow ID must be a valid UUID'),
});

export const workflowActionSchema = z.object({
  reason: z.string().optional(),
});
