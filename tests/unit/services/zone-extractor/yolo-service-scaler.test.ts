import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.hoisted so sendMock exists before the mocked module loads (the scaler
// constructs its ECSClient at import time, before a plain `const` would run).
const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock('@aws-sdk/client-ecs', () => {
  // Everything here is `new`ed by the scaler, so the mocks must be
  // constructor-compatible (regular functions, not arrows).
  const MockECSClient = vi.fn();
  MockECSClient.prototype.send = (...args: unknown[]) => sendMock(...args);
  const cmd = (type: string) =>
    vi.fn(function (this: Record<string, unknown>, input: unknown) {
      this.__type = type;
      this.input = input;
    });
  return {
    ECSClient: MockECSClient,
    UpdateServiceCommand: cmd('UpdateService'),
    DescribeServicesCommand: cmd('DescribeServices'),
    ListTasksCommand: cmd('ListTasks'),
    DescribeTasksCommand: cmd('DescribeTasks'),
  };
});

vi.mock('../../../../src/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  ensureYoloServiceUp,
  scaleYoloServiceDown,
  touchYoloIdleTimer,
  __clearYoloIdleTimerForTest,
} from '../../../../src/services/zone-extractor/yolo-service-scaler';

const IDLE_MS = 10 * 60 * 1000;
const POLL_MS = 10_000;

const updateCalls = () => sendMock.mock.calls.filter((c) => c[0].__type === 'UpdateService');

beforeEach(() => {
  sendMock.mockReset();
});
afterEach(() => {
  __clearYoloIdleTimerForTest();
  vi.useRealTimers();
});

describe('ensureYoloServiceUp', () => {
  it('is a no-op when a HEALTHY task already exists', async () => {
    sendMock.mockImplementation((cmd) => {
      if (cmd.__type === 'ListTasks') return Promise.resolve({ taskArns: ['t1'] });
      if (cmd.__type === 'DescribeTasks') {
        return Promise.resolve({ tasks: [{ lastStatus: 'RUNNING', healthStatus: 'HEALTHY' }] });
      }
      return Promise.resolve({});
    });

    await ensureYoloServiceUp();
    expect(updateCalls()).toHaveLength(0); // never scaled
  });

  it('scales to 1 when down, then resolves once a task is HEALTHY', async () => {
    vi.useFakeTimers();
    let listCall = 0;
    sendMock.mockImplementation((cmd) => {
      if (cmd.__type === 'ListTasks') {
        listCall++;
        return Promise.resolve({ taskArns: listCall === 1 ? [] : ['t1'] });
      }
      if (cmd.__type === 'DescribeTasks') {
        return Promise.resolve({ tasks: [{ lastStatus: 'RUNNING', healthStatus: 'HEALTHY' }] });
      }
      if (cmd.__type === 'DescribeServices') {
        return Promise.resolve({ services: [{ desiredCount: 0 }] });
      }
      return Promise.resolve({});
    });

    const p = ensureYoloServiceUp();
    await vi.advanceTimersByTimeAsync(POLL_MS); // let one poll cycle run
    await p;

    const up = updateCalls();
    expect(up).toHaveLength(1);
    expect(up[0][0].input.desiredCount).toBe(1);
  });
});

describe('scaleYoloServiceDown', () => {
  it('sets desiredCount to 0', async () => {
    sendMock.mockResolvedValue({});
    await scaleYoloServiceDown();
    const down = updateCalls();
    expect(down).toHaveLength(1);
    expect(down[0][0].input.desiredCount).toBe(0);
  });
});

describe('touchYoloIdleTimer', () => {
  it('scales to 0 after the idle window elapses', async () => {
    vi.useFakeTimers();
    sendMock.mockResolvedValue({});
    touchYoloIdleTimer();
    await vi.advanceTimersByTimeAsync(IDLE_MS + 100);
    const down = updateCalls();
    expect(down).toHaveLength(1);
    expect(down[0][0].input.desiredCount).toBe(0);
  });

  it('debounces — a second touch resets the countdown (only one scale-down)', async () => {
    vi.useFakeTimers();
    sendMock.mockResolvedValue({});
    touchYoloIdleTimer();
    await vi.advanceTimersByTimeAsync(IDLE_MS / 2);
    touchYoloIdleTimer(); // reset
    await vi.advanceTimersByTimeAsync(IDLE_MS / 2); // half-way from the reset — not yet
    expect(updateCalls()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(IDLE_MS / 2 + 100); // now past the reset window
    expect(updateCalls()).toHaveLength(1);
  });
});
