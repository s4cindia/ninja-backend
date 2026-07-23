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
//                           already warm. Call before a yolo detection.
//   touchYoloIdleTimer()    (re)arm an idle countdown; when it elapses with no
//                           further use, scale the service back to 0. Called
//                           after each yolo detection, so a BATCH of documents
//                           keeps the GPU warm and it drops once the batch ends.
//
// Requires the backend task role to allow ecs:UpdateService, DescribeServices,
// ListTasks, DescribeTasks on the cluster/service.

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

/**
 * Ensure the yolo service is up with a HEALTHY task. Scales to 1 if needed and
 * polls until ready (or throws YOLO_SCALE_TIMEOUT). No-op when already warm.
 */
export async function ensureYoloServiceUp(): Promise<void> {
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
    logger.info('[YoloScaler] within business-hours warm window — keeping zone-detector warm');
    touchYoloIdleTimer();
    return;
  }
  logger.info('[YoloScaler] scaling zone-detector service to 0 (idle)');
  await setDesiredCount(0);
}

// Debounced idle scale-down. Kept module-level; in a multi-instance backend each
// instance debounces independently and the scale-down is idempotent (a running
// detection re-arms via ensureYoloServiceUp on the next call).
let idleTimer: ReturnType<typeof setTimeout> | null = null;

export function touchYoloIdleTimer(): void {
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

/** Exported for tests — cancel any pending idle timer. */
export function __clearYoloIdleTimerForTest(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
}
