import { HITLGate, HITLAction, HITLReviewItem, GateStatus } from '../../types/workflow-contracts';
import prisma from '../../lib/prisma';
import { Prisma } from '@prisma/client';
import { logger } from '../../lib/logger';

class HITLService {
  private pending = new Map<string, HITLReviewItem[]>();

  openGate(workflowId: string, gate: HITLGate, items: HITLReviewItem[]): void {
    this.pending.set(`${workflowId}:${gate}`, items);
    logger.info(`[HITL] Gate ${gate} opened for workflow ${workflowId} with ${items.length} items`);
  }

  async getGateItems(workflowId: string, gate: HITLGate): Promise<HITLReviewItem[]> {
    const key = `${workflowId}:${gate}`;
    const inMemory = this.pending.get(key);
    if (inMemory !== undefined) {
      return inMemory;
    }

    const records = await prisma.hITLDecision.findMany({ where: { workflowId, gate } });
    return records.map((r) => ({
      id: r.itemId,
      gate: r.gate as HITLGate,
      itemType: r.itemType,
      itemId: r.itemId,
      originalValue: r.originalValue,
    }));
  }

  async recordDecision(
    workflowId: string,
    gate: HITLGate,
    itemId: string,
    decision: HITLAction,
    reviewerId: string,
    opts?: { modifiedValue?: unknown; justification?: string }
  ): Promise<void> {
    const key = `${workflowId}:${gate}`;
    const items = this.pending.get(key);
    const item = items?.find((i) => i.itemId === itemId);

    if (!item) {
      throw new Error('Review item not found');
    }

    await prisma.hITLDecision.create({
      data: {
        workflowId,
        gate,
        itemType: item.itemType,
        itemId,
        decision,
        originalValue: item.originalValue as Prisma.InputJsonValue,
        modifiedValue: opts?.modifiedValue as Prisma.InputJsonValue | undefined,
        justification: opts?.justification,
        reviewerId,
      },
    });

    const remaining = (items ?? []).filter((i) => i.itemId !== itemId);
    if (remaining.length === 0) {
      this.pending.delete(key);
    } else {
      this.pending.set(key, remaining);
    }
  }

  async getGateStatus(workflowId: string, gate: HITLGate): Promise<GateStatus> {
    const total = await prisma.hITLDecision.count({ where: { workflowId, gate } });
    const pending = this.pending.get(`${workflowId}:${gate}`)?.length ?? 0;
    return { total, reviewed: total - pending, pending };
  }

  isGateComplete(workflowId: string, gate: HITLGate): boolean {
    const items = this.pending.get(`${workflowId}:${gate}`);
    return !items || items.length === 0;
  }

  clearGate(workflowId: string, gate: HITLGate): void {
    this.pending.delete(`${workflowId}:${gate}`);
  }
}

export const hitlService = new HITLService();
