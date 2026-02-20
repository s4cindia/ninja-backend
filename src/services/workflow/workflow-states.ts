import { createMachine } from 'xstate';

export interface WorkflowContext {
  workflowId: string;
  fileId: string;
  currentState: string;
  stateData: Record<string, unknown>;
  retryCount: number;
  loopCount: number;
  errorMessage?: string;
  batchId?: string;
}

export type WorkflowEvent =
  | { type: 'PREPROCESS' }
  | { type: 'START_AUDIT' }
  | { type: 'ACE_START' }
  | { type: 'AI_START' }
  | { type: 'AI_DONE' }
  | { type: 'AI_ACCEPTED' }
  | { type: 'AI_REJECTED' }
  | { type: 'REMEDIATION_DONE' }
  | { type: 'REMEDIATION_APPROVED' }
  | { type: 'CONFORMANCE_START' }
  | { type: 'CONFORMANCE_DONE' }
  | { type: 'CONFORMANCE_APPROVED' }
  | { type: 'ACR_DONE' }
  | { type: 'ACR_SIGNED' }
  | { type: 'ERROR'; message?: string }
  | { type: 'PAUSE' }
  | { type: 'RESUME' }
  | { type: 'RETRY' }
  | { type: 'RETRY_EXECUTE' }
  | { type: 'TIMEOUT' };

export const WorkflowMachine = createMachine({
  id: 'workflow',
  initial: 'UPLOAD_RECEIVED',
  types: {} as {
    context: WorkflowContext;
    events: WorkflowEvent;
  },
  context: {
    workflowId: '',
    fileId: '',
    currentState: 'UPLOAD_RECEIVED',
    stateData: {},
    retryCount: 0,
    loopCount: 0,
    errorMessage: undefined,
    batchId: undefined,
  },
  states: {
    UPLOAD_RECEIVED: {
      on: {
        PREPROCESS: { target: 'PREPROCESSING' },
        ERROR: { target: 'FAILED' },
        PAUSE: { target: 'PAUSED' },
      },
    },
    PREPROCESSING: {
      on: {
        START_AUDIT: { target: 'RUNNING_EPUBCHECK' },
        ERROR: { target: 'FAILED' },
        PAUSE: { target: 'PAUSED' },
      },
    },
    RUNNING_EPUBCHECK: {
      on: {
        ACE_START: { target: 'RUNNING_ACE' },
        ERROR: { target: 'FAILED' },
        PAUSE: { target: 'PAUSED' },
      },
    },
    RUNNING_ACE: {
      on: {
        AI_START: { target: 'RUNNING_AI_ANALYSIS' },
        ERROR: { target: 'FAILED' },
        PAUSE: { target: 'PAUSED' },
      },
    },
    RUNNING_AI_ANALYSIS: {
      on: {
        AI_DONE: { target: 'AWAITING_AI_REVIEW' },
        ERROR: { target: 'FAILED' },
        PAUSE: { target: 'PAUSED' },
      },
    },
    AWAITING_AI_REVIEW: {
      on: {
        AI_ACCEPTED: { target: 'AUTO_REMEDIATION' },
        AI_REJECTED: { target: 'RUNNING_AI_ANALYSIS' },
        ERROR: { target: 'FAILED' },
        PAUSE: { target: 'PAUSED' },
        TIMEOUT: { target: 'HITL_TIMEOUT' },
      },
    },
    AUTO_REMEDIATION: {
      on: {
        REMEDIATION_DONE: { target: 'AWAITING_REMEDIATION_REVIEW' },
        ERROR: { target: 'FAILED' },
        PAUSE: { target: 'PAUSED' },
      },
    },
    AWAITING_REMEDIATION_REVIEW: {
      on: {
        REMEDIATION_APPROVED: { target: 'VERIFICATION_AUDIT' },
        ERROR: { target: 'FAILED' },
        PAUSE: { target: 'PAUSED' },
        TIMEOUT: { target: 'HITL_TIMEOUT' },
      },
    },
    VERIFICATION_AUDIT: {
      on: {
        CONFORMANCE_START: { target: 'CONFORMANCE_MAPPING' },
        ERROR: { target: 'FAILED' },
        PAUSE: { target: 'PAUSED' },
      },
    },
    CONFORMANCE_MAPPING: {
      on: {
        CONFORMANCE_DONE: { target: 'AWAITING_CONFORMANCE_REVIEW' },
        ERROR: { target: 'FAILED' },
        PAUSE: { target: 'PAUSED' },
      },
    },
    AWAITING_CONFORMANCE_REVIEW: {
      on: {
        CONFORMANCE_APPROVED: { target: 'ACR_GENERATION' },
        ERROR: { target: 'FAILED' },
        PAUSE: { target: 'PAUSED' },
        TIMEOUT: { target: 'HITL_TIMEOUT' },
      },
    },
    ACR_GENERATION: {
      on: {
        ACR_DONE: { target: 'AWAITING_ACR_SIGNOFF' },
        ERROR: { target: 'FAILED' },
        PAUSE: { target: 'PAUSED' },
      },
    },
    AWAITING_ACR_SIGNOFF: {
      on: {
        ACR_SIGNED: { target: 'COMPLETED' },
        ERROR: { target: 'FAILED' },
        PAUSE: { target: 'PAUSED' },
        TIMEOUT: { target: 'HITL_TIMEOUT' },
      },
    },
    COMPLETED: {
      type: 'final',
    },
    FAILED: {
      on: {
        RETRY: { target: 'RETRYING' },
      },
    },
    RETRYING: {
      on: {
        RETRY_EXECUTE: { target: 'PREPROCESSING' },
        ERROR: { target: 'FAILED' },
      },
    },
    CANCELLED: {
      type: 'final',
    },
    HITL_TIMEOUT: {
      type: 'final',
    },
    PAUSED: {
      on: {
        RESUME: { target: 'PREPROCESSING' },
        ERROR: { target: 'FAILED' },
      },
    },
  },
});
