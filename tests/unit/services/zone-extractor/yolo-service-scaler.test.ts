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
  isWithinWarmWindow,
  __clearYoloIdleTimerForTest,
  __resetYoloActiveRequestCountForTest,
} from '../../../../src/services/zone-extractor/yolo-service-scaler';

const IDLE_MS = 10 * 60 * 1000;
const POLL_MS = 10_000;

const updateCalls = () => sendMock.mock.calls.filter((c) => c[0].__type === 'UpdateService');

// A healthy task from the first check onward — lets ensureYoloServiceUp()
// resolve immediately without needing fake timers.
const mockAlreadyHealthy = () => {
  sendMock.mockImplementation((cmd) => {
    if (cmd.__type === 'ListTasks') return Promise.resolve({ taskArns: ['t1'] });
    if (cmd.__type === 'DescribeTasks') {
      return Promise.resolve({ tasks: [{ lastStatus: 'RUNNING', healthStatus: 'HEALTHY' }] });
    }
    return Promise.resolve({});
  });
};

beforeEach(() => {
  sendMock.mockReset();
});
afterEach(() => {
  __clearYoloIdleTimerForTest();
  __resetYoloActiveRequestCountForTest();
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

describe('isWithinWarmWindow (business-hours warm window, IST Mon-Fri)', () => {
  const S = 'YOLO_WARM_START_HOUR_IST';
  const E = 'YOLO_WARM_END_HOUR_IST';
  afterEach(() => { delete process.env[S]; delete process.env[E]; });

  it('is false when the window env is unset', () => {
    expect(isWithinWarmWindow(new Date('2026-07-22T05:00:00Z'))).toBe(false); // Wed 10:30 IST
  });

  it('is true for a weekday time inside the window', () => {
    process.env[S] = '9'; process.env[E] = '19';
    expect(isWithinWarmWindow(new Date('2026-07-22T05:00:00Z'))).toBe(true);  // Wed 10:30 IST
  });

  it('honours the start (inclusive) and end (exclusive) boundaries', () => {
    process.env[S] = '9'; process.env[E] = '19';
    expect(isWithinWarmWindow(new Date('2026-07-22T03:30:00Z'))).toBe(true);  // 09:00 IST
    expect(isWithinWarmWindow(new Date('2026-07-22T13:30:00Z'))).toBe(false); // 19:00 IST
  });

  it('is false outside the window on a weekday', () => {
    process.env[S] = '9'; process.env[E] = '19';
    expect(isWithinWarmWindow(new Date('2026-07-22T20:00:00Z'))).toBe(false); // Thu 01:30 IST
  });

  it('is false on the weekend even within the hours', () => {
    process.env[S] = '9'; process.env[E] = '19';
    expect(isWithinWarmWindow(new Date('2026-07-25T05:00:00Z'))).toBe(false); // Sat 10:30 IST
  });
});

describe('active-request lease (concurrent worker jobs)', () => {
  it('skips scale-down while another caller is still active, then scales down once released', async () => {
    mockAlreadyHealthy();

    // Two concurrent callers each acquire the service (worker concurrency: 5).
    await ensureYoloServiceUp(); // caller A
    await ensureYoloServiceUp(); // caller B

    // Caller A finishes; B is still active — must not scale to 0.
    touchYoloIdleTimer();
    await scaleYoloServiceDown();
    expect(updateCalls()).toHaveLength(0);

    // Caller B finishes; nothing left active — now it's safe to scale down.
    touchYoloIdleTimer();
    await scaleYoloServiceDown();
    const down = updateCalls();
    expect(down).toHaveLength(1);
    expect(down[0][0].input.desiredCount).toBe(0);
  });

  it('the idle timer itself is blocked from scaling down while a caller is active', async () => {
    vi.useFakeTimers();
    mockAlreadyHealthy();

    await ensureYoloServiceUp(); // caller A
    await ensureYoloServiceUp(); // caller B — stays active for the rest of this test
    touchYoloIdleTimer(); // A finishes: releases its lease, arms the countdown
    await vi.advanceTimersByTimeAsync(IDLE_MS + 100);

    expect(updateCalls()).toHaveLength(0); // B still holds a lease
  });

  it('releasing the lease never drops the count below zero', async () => {
    // touchYoloIdleTimer() called without a prior ensureYoloServiceUp() (e.g.
    // a defensive/duplicate release) must not push the count negative and
    // permanently block future scale-downs.
    touchYoloIdleTimer();
    await scaleYoloServiceDown();
    expect(updateCalls()).toHaveLength(1);
    expect(updateCalls()[0][0].input.desiredCount).toBe(0);
  });
});

describe('scaleYoloServiceDown warm-window suppression', () => {
  const S = 'YOLO_WARM_START_HOUR_IST';
  const E = 'YOLO_WARM_END_HOUR_IST';
  afterEach(() => { delete process.env[S]; delete process.env[E]; });

  it('scales to 0 when no warm window is configured', async () => {
    await scaleYoloServiceDown();
    expect(updateCalls()).toHaveLength(1);
    expect(updateCalls()[0][0].input.desiredCount).toBe(0);
  });
});
