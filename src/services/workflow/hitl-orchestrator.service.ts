import { hitlService } from './hitl.service';
import { timeoutService } from './timeout.service';
import { HITLGate, HITLAction, HITLReviewItem } from '../../types/workflow-contracts';
import { logger } from '../../lib/logger';

class HITLOrchestratorService {
  suspendAtGate(
    workflowId: string,
    gate: HITLGate,
    items: HITLReviewItem[],
    transitionFn: (event: string) => Promise<void>
  ): void {
    hitlService.openGate(workflowId, gate, items);
    timeoutService.scheduleTimeout(workflowId, gate, async () => {
      await transitionFn('TIMEOUT');
    });
    logger.info(`[HITL Orchestrator] Suspended at gate ${gate}`);
  }

  async submitDecisions(
    workflowId: string,
    gate: HITLGate,
    decisions: Array<{
      itemId: string;
      decision: HITLAction;
      modifiedValue?: unknown;
      justification?: string;
    }>,
    reviewerId: string,
    transitionFn: (event: string) => Promise<void>
  ): Promise<{ gateComplete: boolean }> {
    for (const d of decisions) {
      await hitlService.recordDecision(workflowId, gate, d.itemId, d.decision, reviewerId, {
        modifiedValue: d.modifiedValue,
        justification: d.justification,
      });
    }

    if (hitlService.isGateComplete(workflowId, gate)) {
      timeoutService.cancelTimeout(workflowId, gate);

      let event: string;
      if (gate === HITLGate.AI_REVIEW) {
        const hasRejection = decisions.some((d) => d.decision === HITLAction.REJECT);
        event = hasRejection ? 'AI_REJECTED' : 'AI_ACCEPTED';
      } else if (gate === HITLGate.REMEDIATION_REVIEW) {
        event = 'REMEDIATION_APPROVED';
      } else if (gate === HITLGate.CONFORMANCE_REVIEW) {
        event = 'CONFORMANCE_APPROVED';
      } else {
        event = 'ACR_SIGNED';
      }

      await transitionFn(event);
      hitlService.clearGate(workflowId, gate);
      return { gateComplete: true };
    }

    return { gateComplete: false };
  }

  async forceCompleteGate(
    workflowId: string,
    gate: HITLGate,
    reviewerId: string,
    transitionFn: (event: string) => Promise<void>
  ): Promise<void> {
    if (gate !== HITLGate.AI_REVIEW) {
      throw new Error(`Gate ${gate} cannot be force-completed`);
    }

    const remaining = await hitlService.getGateItems(workflowId, gate);
    const decisions = remaining.map((item) => ({
      itemId: item.itemId,
      decision: HITLAction.ACCEPT,
    }));

    await this.submitDecisions(workflowId, gate, decisions, reviewerId, transitionFn);
  }
}

export const hitlOrchestratorService = new HITLOrchestratorService();
