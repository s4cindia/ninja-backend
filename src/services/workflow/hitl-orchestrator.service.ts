import { hitlService } from './hitl.service';
import { timeoutService } from './timeout.service';
import { workflowConfigService } from './workflow-config.service';
import { HITLGate, HITLAction, HITLReviewItem } from '../../types/workflow-contracts';
import { HitlGateConfig } from '../../types/workflow-config.types';
import { logger } from '../../lib/logger';

class HITLOrchestratorService {
  /**
   * Map HITLGate enum to config key names.
   */
  private gateToConfigKey(gate: HITLGate): keyof HitlGateConfig {
    const mapping: Record<HITLGate, keyof HitlGateConfig> = {
      [HITLGate.AI_REVIEW]: 'AWAITING_AI_REVIEW',
      [HITLGate.REMEDIATION_REVIEW]: 'AWAITING_REMEDIATION_REVIEW',
      [HITLGate.CONFORMANCE_REVIEW]: 'AWAITING_CONFORMANCE_REVIEW',
      [HITLGate.ACR_SIGNOFF]: 'AWAITING_ACR_SIGNOFF',
    };
    return mapping[gate];
  }

  async suspendAtGate(
    workflowId: string,
    gate: HITLGate,
    items: HITLReviewItem[],
    transitionFn: (event: string) => Promise<void>,
    tenantId: string
  ): Promise<void> {
    hitlService.openGate(workflowId, gate, items);

    // Get configured timeout for this gate
    const configKey = this.gateToConfigKey(gate);
    const timeoutMs = await workflowConfigService.getGateTimeout(
      tenantId,
      configKey
    );

    // Schedule timeout if configured
    if (timeoutMs === null) {
      logger.info(`[HITL Orchestrator] No timeout configured for gate ${gate}, awaiting manual approval`);
    } else {
      timeoutService.scheduleTimeout(workflowId, gate, async () => {
        logger.warn(`[HITL Orchestrator] Gate ${gate} timed out after ${timeoutMs}ms`);
        await transitionFn('TIMEOUT');
      }, timeoutMs);
      logger.info(`[HITL Orchestrator] Timeout scheduled for gate ${gate}: ${timeoutMs}ms`);
    }

    logger.info(`[HITL Orchestrator] Suspended at gate ${gate} with ${items.length} items`);
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
