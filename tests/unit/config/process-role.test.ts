/**
 * getWorkerFlags -- the web/worker process split's role→worker-group truth
 * table (see src/index.ts and src/workers/index.ts). This is the single
 * most safety-critical piece of that split: get it backwards and either
 * job processing (background workers) or real-time workflow updates (the
 * WebSocket-coupled workflow worker) silently stops running in production.
 */
import { describe, it, expect } from 'vitest';
import { getWorkerFlags } from '../../../src/config/process-role';

describe('getWorkerFlags', () => {
  it('legacy (unset/null): runs both worker groups, exactly like before the split existed', () => {
    expect(getWorkerFlags(null)).toEqual({
      runsBackgroundWorkers: true,
      runsWorkflowWorker: true,
    });
  });

  it('web: runs only the WebSocket-coupled workflow worker, no background job processing', () => {
    expect(getWorkerFlags('web')).toEqual({
      runsBackgroundWorkers: false,
      runsWorkflowWorker: true,
    });
  });

  it('worker: runs only background job processing, not the WebSocket-coupled workflow worker', () => {
    expect(getWorkerFlags('worker')).toEqual({
      runsBackgroundWorkers: true,
      runsWorkflowWorker: false,
    });
  });
});
