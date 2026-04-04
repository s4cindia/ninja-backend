import { logger } from '../../lib/logger';
import type { DoclingServiceResponse } from './types';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface AsyncJobResponse {
  asyncJobId: string;
  status: 'PROCESSING' | 'COMPLETED' | 'FAILED';
  result?: DoclingServiceResponse;
  error?: string;
}

async function submitAsyncJob(
  baseUrl: string,
  pdfPath: string,
  jobId: string,
): Promise<string> {
  const submitResponse = await fetch(`${baseUrl}/detect-async`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pdfPath, jobId }),
    signal: AbortSignal.timeout(30_000), // 30s to submit
  });

  if (!submitResponse.ok) {
    const body = await submitResponse.text();
    if (submitResponse.status >= 500) {
      throw new Error(`DOCLING_SERVICE_ERROR: ${submitResponse.status} ${body}`);
    }
    throw new Error(`DOCLING_CLIENT_ERROR: ${submitResponse.status} ${body}`);
  }

  const { asyncJobId } = (await submitResponse.json()) as AsyncJobResponse;
  return asyncJobId;
}

export async function detectWithDocling(
  pdfPath: string,
  jobId: string,
): Promise<DoclingServiceResponse> {
  const baseUrl = process.env.DOCLING_SERVICE_URL;
  if (!baseUrl) {
    throw new Error('DOCLING_SERVICE_URL env var is not set');
  }

  const MAX_RETRIES = 2; // retry up to 2 times on container restart (404)
  const POLL_INTERVAL_MS = 5_000; // 5 seconds
  const MAX_POLL_TIME_MS = 25 * 60 * 1000; // 25 minutes
  const startTime = Date.now();

  let asyncJobId = await submitAsyncJob(baseUrl, pdfPath, jobId);
  logger.info(`[DoclingClient] Job ${jobId}: async submitted as ${asyncJobId}`);
  let retryCount = 0;

  // Step 2: Poll for result — each poll is a fresh short-lived connection
  while (Date.now() - startTime < MAX_POLL_TIME_MS) {
    await sleep(POLL_INTERVAL_MS);

    let pollResponse: Response;
    try {
      pollResponse = await fetch(`${baseUrl}/jobs/${asyncJobId}`, {
        signal: AbortSignal.timeout(10_000), // 10s per poll
      });
    } catch {
      // Transient network error during poll — retry
      logger.warn(`[DoclingClient] Job ${jobId}: poll request failed, retrying...`);
      continue;
    }

    if (!pollResponse.ok) {
      if (pollResponse.status === 404) {
        // Container likely restarted and lost in-memory job state.
        // Re-submit the job instead of failing immediately.
        if (retryCount < MAX_RETRIES) {
          retryCount++;
          logger.warn(
            `[DoclingClient] Job ${jobId}: async job ${asyncJobId} returned 404 ` +
            `(container restart?), re-submitting (attempt ${retryCount + 1}/${MAX_RETRIES + 1})`,
          );
          try {
            asyncJobId = await submitAsyncJob(baseUrl, pdfPath, jobId);
            logger.info(`[DoclingClient] Job ${jobId}: re-submitted as ${asyncJobId}`);
            continue;
          } catch (resubmitErr) {
            logger.error(`[DoclingClient] Job ${jobId}: re-submit failed: ${resubmitErr}`);
            throw new Error(`DOCLING_SERVICE_ERROR: re-submit after 404 failed: ${resubmitErr}`);
          }
        }
        throw new Error(
          `DOCLING_SERVICE_ERROR: async job not found after ${retryCount} retries (container keeps restarting?)`,
        );
      }
      // Transient server error — retry
      logger.warn(`[DoclingClient] Job ${jobId}: poll returned ${pollResponse.status}, retrying...`);
      continue;
    }

    const job = (await pollResponse.json()) as AsyncJobResponse;

    if (job.status === 'COMPLETED' && job.result) {
      logger.info(
        `[DoclingClient] Job ${jobId}: completed in ${Date.now() - startTime}ms` +
        (retryCount > 0 ? ` (after ${retryCount} restart retries)` : ''),
      );
      return job.result;
    }

    if (job.status === 'FAILED') {
      throw new Error(`DOCLING_SERVICE_ERROR: ${job.error ?? 'unknown error'}`);
    }

    // Still PROCESSING — continue polling
  }

  throw new Error(`DOCLING_TIMEOUT: exceeded ${MAX_POLL_TIME_MS / 1000}s for jobId ${jobId}`);
}
