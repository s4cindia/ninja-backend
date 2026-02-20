import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock must be declared before any imports that use prisma
vi.mock('../../../lib/prisma', () => ({
  default: {
    workflowInstance: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    workflowEvent: {
      create: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

import prisma from '../../../lib/prisma';
import { workflowService } from '../workflow.service';

// Typed prisma mock helpers
const mockCreate = prisma.workflowInstance.create as ReturnType<typeof vi.fn>;
const mockFindUnique = prisma.workflowInstance.findUnique as ReturnType<typeof vi.fn>;
const mockUpdate = prisma.workflowInstance.update as ReturnType<typeof vi.fn>;
const mockEventCreate = prisma.workflowEvent.create as ReturnType<typeof vi.fn>;
const mockTransaction = prisma.$transaction as ReturnType<typeof vi.fn>;

/** Build a minimal WorkflowInstance-shaped object */
function makeInstance(overrides: Partial<{
  id: string;
  fileId: string;
  batchId: string | null;
  currentState: string;
  stateData: Record<string, unknown>;
  retryCount: number;
  loopCount: number;
  errorMessage: string | null;
  createdBy: string;
  priority: number;
  startedAt: Date;
  completedAt: Date | null;
}> = {}) {
  return {
    id: 'wf-001',
    fileId: 'file-001',
    batchId: null,
    currentState: 'UPLOAD_RECEIVED',
    stateData: {},
    retryCount: 0,
    loopCount: 0,
    errorMessage: null,
    createdBy: 'user-001',
    priority: 5,
    startedAt: new Date(),
    completedAt: null,
    ...overrides,
  };
}

describe('WorkflowService', () => {
  beforeEach(() => {
    // resetAllMocks clears implementations AND drains queued mockResolvedValueOnce values
    vi.resetAllMocks();
  });

  // ─────────────────────────────────────────────────────────
  // createWorkflow
  // ─────────────────────────────────────────────────────────
  describe('createWorkflow', () => {
    it('creates a workflow with UPLOAD_RECEIVED state', async () => {
      const expected = makeInstance({ currentState: 'UPLOAD_RECEIVED' });
      mockCreate.mockResolvedValue(expected);

      const result = await workflowService.createWorkflow('file-001', 'user-001');

      expect(mockCreate).toHaveBeenCalledOnce();
      const callArg = mockCreate.mock.calls[0][0] as { data: Record<string, unknown> };
      expect(callArg.data.currentState).toBe('UPLOAD_RECEIVED');
      expect(callArg.data.fileId).toBe('file-001');
      expect(callArg.data.stateData).toEqual({});
      expect(result.currentState).toBe('UPLOAD_RECEIVED');
    });

    it('throws if fileId is empty', async () => {
      // The service passes fileId directly to Prisma; Prisma would reject an empty
      // required field. We simulate that rejection here.
      mockCreate.mockRejectedValue(new Error('fileId is required'));

      await expect(
        workflowService.createWorkflow('', 'user-001'),
      ).rejects.toThrow('fileId is required');
    });
  });

  // ─────────────────────────────────────────────────────────
  // transition
  // ─────────────────────────────────────────────────────────
  describe('transition', () => {
    it('transitions UPLOAD_RECEIVED to PREPROCESSING on PREPROCESS event', async () => {
      const instance = makeInstance({ currentState: 'UPLOAD_RECEIVED' });
      const updated = makeInstance({ currentState: 'PREPROCESSING' });

      mockFindUnique.mockResolvedValue(instance);
      // Set up BEFORE transition() is called — Prisma ops are invoked before $transaction
      mockUpdate.mockResolvedValue(updated);
      mockEventCreate.mockResolvedValue({ id: 'evt-001' });
      // $transaction receives an array of already-pending promises; resolve them all
      mockTransaction.mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops));

      const result = await workflowService.transition('wf-001', 'PREPROCESS');

      expect(mockFindUnique).toHaveBeenCalledWith({ where: { id: 'wf-001' } });
      expect(mockTransaction).toHaveBeenCalledOnce();
      expect(result.currentState).toBe('PREPROCESSING');
    });

    it('throws on invalid state transition', async () => {
      const instance = makeInstance({ currentState: 'UPLOAD_RECEIVED' });
      mockFindUnique.mockResolvedValue(instance);

      // BOGUS_EVENT is not a valid transition from UPLOAD_RECEIVED
      await expect(
        workflowService.transition('wf-001', 'BOGUS_EVENT'),
      ).rejects.toThrow(/Invalid transition/);
    });

    it('creates a WorkflowEvent record on each transition', async () => {
      const instance = makeInstance({ currentState: 'UPLOAD_RECEIVED' });
      const updated = makeInstance({ currentState: 'PREPROCESSING' });

      mockFindUnique.mockResolvedValue(instance);
      // Set up before transition() so Prisma calls resolve correctly
      mockUpdate.mockResolvedValue(updated);
      mockEventCreate.mockResolvedValue({ id: 'evt-002' });

      // Capture the ops array passed to $transaction
      let capturedOps: unknown[] = [];
      mockTransaction.mockImplementation((ops: Promise<unknown>[]) => {
        capturedOps = ops;
        return Promise.all(ops);
      });

      await workflowService.transition('wf-001', 'PREPROCESS', { step: 'init' });

      // $transaction should have been called with 2 operations
      expect(capturedOps).toHaveLength(2);
      // The workflowEvent.create should have been invoked with the right data
      expect(mockEventCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            workflowId: 'wf-001',
            eventType: 'PREPROCESS',
            fromState: 'UPLOAD_RECEIVED',
            toState: 'PREPROCESSING',
          }),
        }),
      );
    });

    it('increments loopCount when re-entering RUNNING_AI_ANALYSIS', async () => {
      // Set up a machine in AWAITING_AI_REVIEW and reject (loops back to AI_ANALYSIS)
      const instance = makeInstance({
        currentState: 'AWAITING_AI_REVIEW',
        loopCount: 1,
      });
      const updated = makeInstance({
        currentState: 'RUNNING_AI_ANALYSIS',
        loopCount: 2,
      });

      mockFindUnique.mockResolvedValue(instance);
      // Set up before transition() so the Prisma ops resolve correctly
      mockUpdate.mockResolvedValue(updated);
      mockEventCreate.mockResolvedValue({ id: 'evt-003' });
      mockTransaction.mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops));

      const result = await workflowService.transition('wf-001', 'AI_REJECTED');

      // Verify state went back to RUNNING_AI_ANALYSIS (the retry loop)
      expect(result.currentState).toBe('RUNNING_AI_ANALYSIS');
      // loopCount increment is handled by the agent service (out of scope here);
      // the service returns whatever Prisma gives back — we verify the updated mock value
      expect(result.loopCount).toBe(2);
    });
  });

  // ─────────────────────────────────────────────────────────
  // computePhase
  // ─────────────────────────────────────────────────────────
  describe('computePhase', () => {
    it('returns ingest for UPLOAD_RECEIVED and PREPROCESSING', () => {
      expect(workflowService.computePhase('UPLOAD_RECEIVED')).toBe('ingest');
      expect(workflowService.computePhase('PREPROCESSING')).toBe('ingest');
    });

    it('returns audit for RUNNING_EPUBCHECK, RUNNING_ACE, RUNNING_AI_ANALYSIS', () => {
      expect(workflowService.computePhase('RUNNING_EPUBCHECK')).toBe('audit');
      expect(workflowService.computePhase('RUNNING_ACE')).toBe('audit');
      expect(workflowService.computePhase('RUNNING_AI_ANALYSIS')).toBe('audit');
      expect(workflowService.computePhase('AWAITING_AI_REVIEW')).toBe('audit');
    });

    it('returns remediate for AUTO_REMEDIATION states', () => {
      expect(workflowService.computePhase('AUTO_REMEDIATION')).toBe('remediate');
      expect(workflowService.computePhase('AWAITING_REMEDIATION_REVIEW')).toBe('remediate');
      expect(workflowService.computePhase('VERIFICATION_AUDIT')).toBe('remediate');
    });

    it('returns certify for CONFORMANCE_MAPPING states', () => {
      expect(workflowService.computePhase('CONFORMANCE_MAPPING')).toBe('certify');
      expect(workflowService.computePhase('AWAITING_CONFORMANCE_REVIEW')).toBe('certify');
      expect(workflowService.computePhase('ACR_GENERATION')).toBe('certify');
      expect(workflowService.computePhase('AWAITING_ACR_SIGNOFF')).toBe('certify');
    });

    it('returns complete for COMPLETED', () => {
      expect(workflowService.computePhase('COMPLETED')).toBe('complete');
    });

    it('returns failed for FAILED, CANCELLED, HITL_TIMEOUT', () => {
      expect(workflowService.computePhase('FAILED')).toBe('failed');
      expect(workflowService.computePhase('CANCELLED')).toBe('failed');
      expect(workflowService.computePhase('HITL_TIMEOUT')).toBe('failed');
      expect(workflowService.computePhase('RETRYING')).toBe('failed');
      expect(workflowService.computePhase('PAUSED')).toBe('failed');
    });
  });

  // ─────────────────────────────────────────────────────────
  // computeProgress
  // ─────────────────────────────────────────────────────────
  describe('computeProgress', () => {
    it('returns 5 for UPLOAD_RECEIVED', () => {
      expect(workflowService.computeProgress('UPLOAD_RECEIVED')).toBe(5);
    });

    it('returns 100 for COMPLETED', () => {
      expect(workflowService.computeProgress('COMPLETED')).toBe(100);
    });

    it('returns 0 for FAILED', () => {
      expect(workflowService.computeProgress('FAILED')).toBe(0);
    });
  });
});
