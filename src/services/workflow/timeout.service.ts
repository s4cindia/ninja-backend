import { HITLGate } from '../../types/workflow-contracts';
import { logger } from '../../lib/logger';

class TimeoutService {
  private timers = new Map<string, NodeJS.Timeout>();

  private readonly defaults: Record<HITLGate, number> = {
    [HITLGate.AI_REVIEW]: 86400000,
    [HITLGate.REMEDIATION_REVIEW]: 172800000,
    [HITLGate.CONFORMANCE_REVIEW]: 172800000,
    [HITLGate.ACR_SIGNOFF]: 259200000,
  };

  scheduleTimeout(
    workflowId: string,
    gate: HITLGate,
    onTimeout: () => void,
    overrideMs?: number
  ): void {
    const key = `${workflowId}:${gate}`;
    const existing = this.timers.get(key);
    if (existing !== undefined) {
      clearTimeout(existing);
    }
    const ms = overrideMs ?? this.defaults[gate];
    const timer = setTimeout(() => {
      logger.warn(`[Timeout] ${gate} timed out for ${workflowId}`);
      onTimeout();
    }, ms);
    this.timers.set(key, timer);
  }

  cancelTimeout(workflowId: string, gate: HITLGate): void {
    const key = `${workflowId}:${gate}`;
    const timer = this.timers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
  }

  cancelAll(workflowId: string): void {
    for (const key of this.timers.keys()) {
      if (key.startsWith(`${workflowId}:`)) {
        clearTimeout(this.timers.get(key)!);
        this.timers.delete(key);
      }
    }
  }

  getTimeoutMs(gate: HITLGate): number {
    return this.defaults[gate];
  }
}

export const timeoutService = new TimeoutService();
