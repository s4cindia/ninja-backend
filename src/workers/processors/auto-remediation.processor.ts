import { Job } from 'bullmq';
import { AutoRemediationJobData, AutoRemediationJobResult } from '../../queues';
import {
  autoRemediationLoopService,
  ComparisonTrialAutoRemediationDriver,
  JobAutoRemediationDriver,
} from '../../services/pdf/auto-remediation-loop.service';
import { logger } from '../../lib/logger';

/**
 * Thin pass-through: reconstructs the right driver from {kind, id} and
 * awaits startAutoLoop. No try/catch needed here -- startAutoLoop already
 * has its own complete try/catch/finally that always writes a terminal
 * driver.markStopped(...) and releases the remediation-cycle lock before
 * resolving, so there's nothing left to recover or clean up at this layer.
 */
export async function processAutoRemediationJob(
  job: Job<AutoRemediationJobData, AutoRemediationJobResult>
): Promise<AutoRemediationJobResult> {
  const { kind, id } = job.data;
  const driver = kind === 'trial'
    ? new ComparisonTrialAutoRemediationDriver(id)
    : new JobAutoRemediationDriver(id);

  logger.info(`[AutoRemediationWorker] Starting ${driver.describe()}`);
  await autoRemediationLoopService.startAutoLoop(driver);
  return { kind, id };
}
