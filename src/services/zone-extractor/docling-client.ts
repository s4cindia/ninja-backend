import type { DoclingServiceResponse } from './types';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function detectWithDocling(
  pdfPath: string,
  jobId: string,
): Promise<DoclingServiceResponse> {
  const baseUrl = process.env.DOCLING_SERVICE_URL;
  if (!baseUrl) {
    throw new Error('DOCLING_SERVICE_URL env var is not set');
  }

  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/detect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pdfPath, jobId }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`DOCLING_TIMEOUT: exceeded 60s for jobId ${jobId}`);
      }
      throw err;
    }

    clearTimeout(timer);

    if (response.ok) {
      return (await response.json()) as DoclingServiceResponse;
    }

    if (response.status >= 400 && response.status < 500) {
      const body = await response.text();
      throw new Error(`DOCLING_CLIENT_ERROR: ${response.status} ${body}`);
    }

    // 5xx — retry if attempts remain
    if (attempt < maxAttempts) {
      await sleep(2000);
      continue;
    }

    throw new Error(
      `DOCLING_SERVICE_ERROR: ${response.status} after retries`,
    );
  }

  // Unreachable, but TypeScript needs it
  throw new Error('DOCLING_SERVICE_ERROR: unexpected');
}
