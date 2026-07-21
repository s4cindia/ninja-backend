import { logger } from '../../lib/logger';
import type { YoloServiceResponse } from './types';

// Client for the YOLOv8 zone-detector service (zone-detector-service/). Mirrors
// the docling submit-and-poll flow so a long detection doesn't hold a
// connection open across the NAT idle timeout. Endpoint from YOLO_SERVICE_URL.

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface AsyncJobResponse {
  asyncJobId: string;
  status: 'PROCESSING' | 'COMPLETED' | 'FAILED';
  result?: YoloServiceResponse;
  error?: string;
}

async function submitAsyncJob(
  baseUrl: string,
  pdfPath: string,
  jobId: string,
): Promise<string> {
  const res = await fetch(`${baseUrl}/detect-async`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pdfPath, jobId }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const body = await res.text();
    if (res.status >= 500) {
      throw new Error(`YOLO_SERVICE_ERROR: ${res.status} ${body}`);
    }
    throw new Error(`YOLO_CLIENT_ERROR: ${res.status} ${body}`);
  }

  const { asyncJobId } = (await res.json()) as AsyncJobResponse;
  return asyncJobId;
}

export async function detectWithYolo(
  pdfPath: string,
  jobId: string,
): Promise<YoloServiceResponse> {
  const baseUrl = process.env.YOLO_SERVICE_URL;
  if (!baseUrl) {
    throw new Error('YOLO_SERVICE_URL env var is not set');
  }

  const MAX_RETRIES = 2; // re-submit on container restart (404)
  const POLL_INTERVAL_MS = 5_000;
  const MAX_POLL_TIME_MS = 30 * 60 * 1000; // 30 min — GPU inference on a large PDF is minutes, not hours
  const startTime = Date.now();

  let asyncJobId = await submitAsyncJob(baseUrl, pdfPath, jobId);
  logger.info(`[YoloClient] Job ${jobId}: async submitted as ${asyncJobId}`);
  let retryCount = 0;

  while (Date.now() - startTime < MAX_POLL_TIME_MS) {
    await sleep(POLL_INTERVAL_MS);

    let pollResponse: Response;
    try {
      pollResponse = await fetch(`${baseUrl}/jobs/${asyncJobId}`, {
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      logger.warn(`[YoloClient] Job ${jobId}: poll request failed, retrying...`);
      continue;
    }

    if (!pollResponse.ok) {
      if (pollResponse.status === 404) {
        // Container likely restarted and lost in-memory job state — re-submit.
        if (retryCount < MAX_RETRIES) {
          retryCount++;
          logger.warn(
            `[YoloClient] Job ${jobId}: async job ${asyncJobId} returned 404 ` +
            `(container restart?), re-submitting (attempt ${retryCount + 1}/${MAX_RETRIES + 1})`,
          );
          try {
            asyncJobId = await submitAsyncJob(baseUrl, pdfPath, jobId);
            logger.info(`[YoloClient] Job ${jobId}: re-submitted as ${asyncJobId}`);
            continue;
          } catch (resubmitErr) {
            throw new Error(`YOLO_SERVICE_ERROR: re-submit after 404 failed: ${resubmitErr}`);
          }
        }
        throw new Error(
          `YOLO_SERVICE_ERROR: async job not found after ${retryCount} retries (container keeps restarting?)`,
        );
      }
      logger.warn(`[YoloClient] Job ${jobId}: poll returned ${pollResponse.status}, retrying...`);
      continue;
    }

    const job = (await pollResponse.json()) as AsyncJobResponse;

    if (job.status === 'COMPLETED' && job.result) {
      logger.info(
        `[YoloClient] Job ${jobId}: completed in ${Date.now() - startTime}ms` +
        (retryCount > 0 ? ` (after ${retryCount} restart retries)` : ''),
      );
      return job.result;
    }

    if (job.status === 'FAILED') {
      throw new Error(`YOLO_SERVICE_ERROR: ${job.error ?? 'unknown error'}`);
    }
    // Still PROCESSING — keep polling.
  }

  throw new Error(`YOLO_TIMEOUT: exceeded ${MAX_POLL_TIME_MS / 1000}s for jobId ${jobId}`);
}
