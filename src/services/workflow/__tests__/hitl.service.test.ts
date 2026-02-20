import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HITLGate, HITLAction } from '../../../types/workflow-contracts';
import type { HITLReviewItem } from '../../../types/workflow-contracts';

vi.mock('../../../lib/prisma', () => ({
  default: {
    hITLDecision: {
      create: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
  },
}));

// Imports must come after vi.mock (hoisted, but keep order explicit)
import { hitlService } from '../hitl.service';
import { timeoutService } from '../timeout.service';
import prisma from '../../../lib/prisma';

// Typed access to mocked Prisma methods
const db = prisma as unknown as {
  hITLDecision: {
    create: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
  };
};

function makeItem(itemId: string, gate: HITLGate = HITLGate.AI_REVIEW): HITLReviewItem {
  return { id: itemId, gate, itemType: 'alt_text', itemId, originalValue: { src: 'img.png' } };
}

// ─── HITLService ──────────────────────────────────────────────────────────────

describe('HITLService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.hITLDecision.create.mockResolvedValue({});
    db.hITLDecision.findMany.mockResolvedValue([]);
    db.hITLDecision.count.mockResolvedValue(0);
  });

  describe('openGate', () => {
    it('stores items in pending map', async () => {
      const wfId = 'wf-open-1';
      const items = [makeItem('item1')];
      hitlService.openGate(wfId, HITLGate.AI_REVIEW, items);
      const result = await hitlService.getGateItems(wfId, HITLGate.AI_REVIEW);
      expect(result).toEqual(items);
    });

    it('overwrites existing items if gate reopened', async () => {
      const wfId = 'wf-open-2';
      hitlService.openGate(wfId, HITLGate.AI_REVIEW, [makeItem('old')]);
      const newItems = [makeItem('new1'), makeItem('new2')];
      hitlService.openGate(wfId, HITLGate.AI_REVIEW, newItems);
      const result = await hitlService.getGateItems(wfId, HITLGate.AI_REVIEW);
      expect(result).toEqual(newItems);
    });
  });

  describe('getGateItems', () => {
    it('returns items from in-memory store', async () => {
      const wfId = 'wf-get-1';
      const items = [makeItem('item1'), makeItem('item2')];
      hitlService.openGate(wfId, HITLGate.AI_REVIEW, items);
      const result = await hitlService.getGateItems(wfId, HITLGate.AI_REVIEW);
      expect(result).toHaveLength(2);
      expect(result[0].itemId).toBe('item1');
    });

    it('returns empty array if gate not opened', async () => {
      const wfId = 'wf-get-never-opened';
      db.hITLDecision.findMany.mockResolvedValue([]);
      const result = await hitlService.getGateItems(wfId, HITLGate.AI_REVIEW);
      expect(result).toEqual([]);
    });
  });

  describe('recordDecision', () => {
    it('persists decision to DB', async () => {
      const wfId = 'wf-record-1';
      hitlService.openGate(wfId, HITLGate.AI_REVIEW, [makeItem('item-db')]);

      await hitlService.recordDecision(
        wfId,
        HITLGate.AI_REVIEW,
        'item-db',
        HITLAction.ACCEPT,
        'reviewer-1'
      );

      expect(db.hITLDecision.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          workflowId: wfId,
          gate: HITLGate.AI_REVIEW,
          itemId: 'item-db',
          decision: HITLAction.ACCEPT,
          reviewerId: 'reviewer-1',
        }),
      });
    });

    it('removes item from pending store after decision', async () => {
      const wfId = 'wf-record-2';
      hitlService.openGate(wfId, HITLGate.AI_REVIEW, [makeItem('item-a'), makeItem('item-b')]);

      await hitlService.recordDecision(
        wfId,
        HITLGate.AI_REVIEW,
        'item-a',
        HITLAction.ACCEPT,
        'reviewer-1'
      );

      const remaining = await hitlService.getGateItems(wfId, HITLGate.AI_REVIEW);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].itemId).toBe('item-b');
    });

    it('throws if itemId not found in pending', async () => {
      const wfId = 'wf-record-3';
      hitlService.openGate(wfId, HITLGate.AI_REVIEW, [makeItem('only-item')]);

      await expect(
        hitlService.recordDecision(
          wfId,
          HITLGate.AI_REVIEW,
          'nonexistent',
          HITLAction.ACCEPT,
          'reviewer-1'
        )
      ).rejects.toThrow('Review item not found');
    });
  });

  describe('isGateComplete', () => {
    it('returns true when no pending items', () => {
      const wfId = 'wf-complete-never-opened';
      expect(hitlService.isGateComplete(wfId, HITLGate.AI_REVIEW)).toBe(true);
    });

    it('returns false when items remain', () => {
      const wfId = 'wf-complete-has-items';
      hitlService.openGate(wfId, HITLGate.AI_REVIEW, [makeItem('item1')]);
      expect(hitlService.isGateComplete(wfId, HITLGate.AI_REVIEW)).toBe(false);
    });
  });

  describe('getGateStatus', () => {
    it('returns correct total, reviewed, pending counts', async () => {
      const wfId = 'wf-status-1';
      // 2 items still pending in memory
      hitlService.openGate(wfId, HITLGate.AI_REVIEW, [makeItem('s1'), makeItem('s2')]);
      // DB reports 3 already-decided records
      db.hITLDecision.count.mockResolvedValue(3);

      const status = await hitlService.getGateStatus(wfId, HITLGate.AI_REVIEW);
      expect(status.total).toBe(3);
      expect(status.pending).toBe(2);
      expect(status.reviewed).toBe(1); // total - pending = 3 - 2
    });
  });
});

// ─── TimeoutService ───────────────────────────────────────────────────────────

describe('TimeoutService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls onTimeout callback after scheduled duration', () => {
    const wfId = 'wf-to-1';
    const onTimeout = vi.fn();
    timeoutService.scheduleTimeout(wfId, HITLGate.AI_REVIEW, onTimeout, 1000);

    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('cancels existing timer when rescheduling same key', () => {
    const wfId = 'wf-to-2';
    const firstCb = vi.fn();
    const secondCb = vi.fn();

    timeoutService.scheduleTimeout(wfId, HITLGate.AI_REVIEW, firstCb, 1000);
    timeoutService.scheduleTimeout(wfId, HITLGate.AI_REVIEW, secondCb, 2000);

    vi.advanceTimersByTime(2000);

    expect(firstCb).not.toHaveBeenCalled();
    expect(secondCb).toHaveBeenCalledTimes(1);
  });

  it('cancelAll removes all timers for a workflowId', () => {
    const wfId = 'wf-to-3';
    const cb1 = vi.fn();
    const cb2 = vi.fn();

    timeoutService.scheduleTimeout(wfId, HITLGate.AI_REVIEW, cb1, 1000);
    timeoutService.scheduleTimeout(wfId, HITLGate.CONFORMANCE_REVIEW, cb2, 2000);
    timeoutService.cancelAll(wfId);

    vi.advanceTimersByTime(5000);

    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).not.toHaveBeenCalled();
  });
});
