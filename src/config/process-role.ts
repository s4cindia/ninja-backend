export type ProcessRole = 'web' | 'worker' | null;

/**
 * Which of the two BullMQ worker groups (see src/workers/index.ts) a given
 * PROCESS_ROLE should run. Pulled out of src/index.ts as a small pure
 * function specifically so this truth table -- the single most
 * safety-critical piece of the web/worker split -- is directly unit
 * testable without needing to import and mock the whole bootstrap file.
 * Get this backwards and either job processing (background workers) or
 * real-time workflow updates (the workflow worker, WebSocket-coupled) would
 * silently stop running in production.
 */
export function getWorkerFlags(role: ProcessRole): {
  runsBackgroundWorkers: boolean;
  runsWorkflowWorker: boolean;
} {
  return {
    runsBackgroundWorkers: role !== 'web',   // legacy (null) or worker
    runsWorkflowWorker: role !== 'worker',   // legacy (null) or web
  };
}
