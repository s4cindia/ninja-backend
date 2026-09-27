import {
  ECSClient,
  UpdateServiceCommand,
  DescribeServicesCommand,
  ListTasksCommand,
  DescribeTasksCommand,
} from '@aws-sdk/client-ecs';
import { logger } from '../../lib/logger';

// On-demand orchestration for the scale-to-zero YOLO zone-detector service.
//
//   ensureYoloServiceUp()   scale the service to 1 (if down) and wait until a
//                           task is RUNNING + HEALTHY. Idempotent — a no-op when
//                           already warm. Call before a yolo detection; on
//                           success it registers an active-request lease.
//   touchYoloIdleTimer()    releases that lease and (re)arms an idle countdown;
//                           when it elapses with no further use, scale the
//                           service back to 0. REQUIRED pair for every
//                           ensureYoloServiceUp() call, from a `finally` block
//                           so it runs even if the caller's own work throws.
//
// Requires the backend task role to allow ecs:UpdateService, DescribeServices,
// ListTasks, DescribeTasks on the cluster/service.
//
// Concurrency safety (2026-09-27): the worker runs up to 5 accessibility jobs
// at once (src/workers/index.ts), each of which can call into this module
// independently, while the detector itself serializes actual GPU work behind
// its own semaphore. Real incident this fixes: job A finishes its detection
// and arms a 10-minute idle timer; job B is still queued waiting for ITS
// detection when that timer fires outside the warm window, and
// scaleYoloServiceDown() would scale the service to 0 while job B's request
// is in flight, failing its auto-tag. activeRequestCount tracks how many
// callers are currently between "decided to use the detector" and "done with
// it" (not just mid-HTTP-call) -- scaleYoloServiceDown() checks it and skips
// the scale-down if any caller is still active; that caller's own eventual
// touchYoloIdleTimer() call re-arms a fresh countdown from ITS completion
// time, so nothing needs to be manually rescheduled.

const region = process.env.AWS_REGION ?? 'ap-south-1';
const ecs = new ECSClient({ region });

const CLUSTER = process.env.YOLO_ECS_CLUSTER ?? 'ninja-cluster';
const SERVICE = process.env.YOLO_ECS_SERVICE ?? 'ninja-zone-detector-service';
// Cold start = GPU instance provisioning + image pull + model load; observed at
// ~6-7 min end-to-end, so allow generous headroom (a too-short timeout throws
// YOLO_SCALE_TIMEOUT while the service is still coming up).
const READY_TIMEOUT_MS = Number(process.env.YOLO_READY_TIMEOUT_MS ?? 10 * 60 * 1000);
const POLL_MS = Number(process.env.YOLO_READY_POLL_MS ?? 10_000);
const IDLE_MS = Number(process.env.YOLO_IDLE_MS ?? 10 * 60 * 1000);

async function hasHealthyTask(): Promise<boolean> {
  const list = await ecs.send(new ListTasksCommand({
    cluster: CLUSTER, serviceName: SERVICE, desiredStatus: 'RUNNING',
  }));
  const taskArns = list.taskArns ?? [];
  if (taskArns.length === 0) return false;
  const desc = await ecs.send(new DescribeTasksCommand({ cluster: CLUSTER, tasks: taskArns }));
  return (desc.tasks ?? []).some(
    (t) => t.lastStatus === 'RUNNING' && t.healthStatus === 'HEALTHY',
  );
}

async function getDesiredCount(): Promise<number> {
  const res = await ecs.send(new DescribeServicesCommand({ cluster: CLUSTER, services: [SERVICE] }));
  return res.services?.[0]?.desiredCount ?? 0;
}

async function setDesiredCount(count: number): Promise<void> {
  await ecs.send(new UpdateServiceCommand({ cluster: CLUSTER, service: SERVICE, desiredCount: count }));
}

async function waitForHealthyTask(): Promise<void> {
  if (await hasHealthyTask()) return;

  if ((await getDesiredCount()) < 1) {
    logger.info('[YoloScaler] scaling zone-detector service to 1 (on-demand)');
    await setDesiredCount(1);
  }

  const start = Date.now();
  while (Date.now() - start < READY_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    if (await hasHealthyTask()) {
      logger.info(`[YoloScaler] zone-detector healthy in ${Date.now() - start}ms`);
      return;
    }
  }
  throw new Error(
    `YOLO_SCALE_TIMEOUT: zone-detector not healthy within ${READY_TIMEOUT_MS / 1000}s`,
  );
}

// Active-request lease. Incremented once a caller has a confirmed-healthy task
// to use (ensureYoloServiceUp resolved), decremented once that caller is done
// with it (touchYoloIdleTimer, its required matching call — see callers'
// try/finally blocks). scaleYoloServiceDown refuses to scale to 0 while this
// is > 0, so a concurrent caller's own eventual touchYoloIdleTimer() call is
// what re-arms the next countdown, from its own completion time.
let activeRequestCount = 0;

/**
 * Ensure the yolo service is up with a HEALTHY task. Scales to 1 if needed and
 * polls until ready (or throws YOLO_SCALE_TIMEOUT). No-op when already warm.
 * On success, registers this caller as an active user of the service — pair
 * with a `finally`-guaranteed touchYoloIdleTimer() once done (see callers).
 */
export async function ensureYoloServiceUp(): Promise<void> {
  await waitForHealthyTask();
  activeRequestCount++;
}

// Business-hours warm window (IST, Mon-Fri). During it the idle scale-down is
// suppressed, so a scheduled pre-warm (or the day's first request) keeps the GPU
// warm all day and jobs never pay the cold start mid-window. Env is read per-call
// so it can be toggled without a redeploy; unset (either bound) = no window, pure
// on-demand. Off-hours behaviour is unchanged (scale up on demand, down when idle).
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export function isWithinWarmWindow(now: Date = new Date()): boolean {
  const startEnv = process.env.YOLO_WARM_START_HOUR_IST;
  const endEnv = process.env.YOLO_WARM_END_HOUR_IST;
  if (!startEnv || !endEnv) return false;
  const start = Number(startEnv);
  const end = Number(endEnv);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const day = ist.getUTCDay();   // 0=Sun..6=Sat on the IST-shifted clock
  const hour = ist.getUTCHours();
  if (day < 1 || day > 5) return false;   // weekdays only
  return hour >= start && hour < end;
}

export async function scaleYoloServiceDown(): Promise<void> {
  if (isWithinWarmWindow()) {
    // Stay warm, and re-arm a re-check so the service self-cools shortly after the
    // window closes even if no further request comes in — no external scheduler needed.
    // This is an internal self-recheck, not a caller finishing up, so it arms the
    // timer directly rather than going through touchYoloIdleTimer() (which would
    // incorrectly release an active-request lease no caller actually released).
    logger.info('[YoloScaler] within business-hours warm window — keeping zone-detector warm');
    armIdleTimer();
    return;
  }
  if (activeRequestCount > 0) {
    // A concurrent caller is still mid-detection (worker concurrency: 5 can run
    // several at once). Skip the scale-down; that caller's own touchYoloIdleTimer()
    // call, once it finishes, re-arms a fresh countdown from its completion time.
    logger.info(
      `[YoloScaler] ${activeRequestCount} request(s) still active — skipping scale-down`,
    );
    return;
  }
  logger.info('[YoloScaler] scaling zone-detector service to 0 (idle)');
  await setDesiredCount(0);
}

// Debounced idle scale-down. Kept module-level; in a multi-instance backend each
// instance debounces independently and the scale-down is idempotent (a running
// detection re-arms via ensureYoloServiceUp on the next call).
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function armIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    scaleYoloServiceDown().catch((e) =>
      logger.warn(`[YoloScaler] idle scale-down failed: ${(e as Error).message}`),
    );
  }, IDLE_MS);
  // Don't keep the event loop alive just for the idle timer.
  if (typeof idleTimer === 'object' && idleTimer && 'unref' in idleTimer) {
    (idleTimer as { unref: () => void }).unref();
  }
}

/**
 * Signal that a caller which previously called ensureYoloServiceUp() is done
 * with the service — releases its active-request lease and (re)arms the idle
 * countdown. Must be called exactly once per successful ensureYoloServiceUp(),
 * from a `finally` block so it always runs, even if the caller's own work
 * (e.g. the detection call) throws — otherwise the lease leaks and the
 * service can never scale down again.
 */
export function touchYoloIdleTimer(): void {
  activeRequestCount = Math.max(0, activeRequestCount - 1);
  armIdleTimer();
}

/** Exported for tests — cancel any pending idle timer. */
export function __clearYoloIdleTimerForTest(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
}

/** Exported for tests — reset the active-request lease count to 0. */
export function __resetYoloActiveRequestCountForTest(): void {
  activeRequestCount = 0;
}
