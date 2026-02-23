/**
 * @fileoverview Type definitions for workflow configuration system.
 * Provides tenant-level and job-level configuration for agentic workflow behavior.
 */

/**
 * Configuration for HITL (Human-in-the-Loop) gate timeouts.
 * Values are in milliseconds. Set to null for no timeout (manual approval required).
 */
export interface HitlGateConfig {
  AWAITING_AI_REVIEW?: number | null;
  AWAITING_REMEDIATION_REVIEW?: number | null;
  AWAITING_CONFORMANCE_REVIEW?: number | null;
  AWAITING_ACR_SIGNOFF?: number | null;
}

/**
 * Configuration for automatic retry behavior when workflows fail.
 */
export interface AutoRetryConfig {
  enabled: boolean;
  maxRetries: number;
  backoffMs: number; // Base milliseconds for exponential backoff
  retryableStates: string[]; // States that are eligible for retry
}

/**
 * Policy for an individual HITL gate in a batch workflow.
 * - 'auto-accept': Gate is automatically approved without human review.
 * - 'require-manual': Gate requires human review (default behavior).
 */
export type BatchGatePolicy = 'auto-accept' | 'require-manual';

/**
 * Strategy when a workflow within a batch encounters an error.
 * - 'pause-batch': Pause all non-terminal workflows in the batch.
 * - 'continue-others': Only the failed workflow is marked FAILED; others continue.
 * - 'fail-batch': Immediately cancel all non-terminal workflows.
 */
export type BatchErrorStrategy = 'pause-batch' | 'continue-others' | 'fail-batch';

/**
 * Auto-approval policy for a specific batch run.
 * Stored per-batch in BatchWorkflow.autoApprovalPolicy JSON field.
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

/**
 * Tenant-level batch policy configuration.
 * Controls whether fully headless (no human review) batches are permitted.
 */
export interface BatchPolicyTenantConfig {
  /** When true, batches may set all gates to 'auto-accept' with no human review. */
  allowFullyHeadless: boolean;
}

/**
 * Complete workflow configuration.
 */
export interface WorkflowConfig {
  enabled: boolean;
  hitlGates?: HitlGateConfig;
  autoRetry?: AutoRetryConfig;
  batchPolicy?: BatchPolicyTenantConfig;
}

/**
 * Tenant-level settings stored in Tenant.settings JSON field.
 */
export interface TenantSettings {
  workflow?: WorkflowConfig;
  // Other tenant settings can be added here
}

/**
 * Job-level workflow options passed via Job.input JSON field.
 * These override tenant-level settings.
 */
export interface JobWorkflowOptions {
  workflowEnabled?: boolean; // Override tenant workflow.enabled
  hitlGates?: Partial<HitlGateConfig>; // Override specific gate timeouts
  autoRetry?: Partial<AutoRetryConfig>; // Override retry configuration
}

/**
 * Default workflow configuration.
 * - Workflow is DISABLED by default for backwards compatibility
 * - HITL gates have 1-hour timeouts except ACR signoff (no timeout)
 * - Auto-retry is disabled (manual retry only)
 */
export const DEFAULT_WORKFLOW_CONFIG: WorkflowConfig = {
  enabled: false, // DISABLED by default for backwards compatibility
  hitlGates: {
    AWAITING_AI_REVIEW: 3600000, // 1 hour
    AWAITING_REMEDIATION_REVIEW: 3600000, // 1 hour
    AWAITING_CONFORMANCE_REVIEW: 3600000, // 1 hour
    AWAITING_ACR_SIGNOFF: null, // No timeout - requires manual signoff
  },
  autoRetry: {
    enabled: false, // Disabled - manual retry only in Phase 1
    maxRetries: 3,
    backoffMs: 5000, // 5 seconds base
    retryableStates: ['FAILED'],
  },
  batchPolicy: {
    allowFullyHeadless: false, // By default, at least one gate must require manual review
  },
};
