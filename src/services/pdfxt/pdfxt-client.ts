import type { BBox, CanonicalZoneType } from '../zone-extractor/types';

export interface PdfxtZone {
  pageNumber: number;
  bbox: BBox;
  label: string;
  confidence?: number;
}

export interface PdfxtServiceResponse {
  jobId: string;
  zones: PdfxtZone[];
  processingTimeMs: number;
}

const PDFXT_LABEL_MAP: Record<string, CanonicalZoneType> = {
  'text': 'paragraph',
  'heading': 'section-header',
  'table': 'table',
  'figure': 'figure',
  'caption': 'caption',
  'footnote': 'footnote',
  'header': 'header',
  'footer': 'footer',
  'list': 'paragraph',
  'list-item': 'paragraph',
};

export function mapPdfxtLabel(label: string): CanonicalZoneType {
  const mapped = PDFXT_LABEL_MAP[label.toLowerCase()];
  if (!mapped) {
    console.warn(
      `[PdfxtMapper] Unknown pdfxt label "${label}" — defaulting to paragraph`,
    );
    return 'paragraph';
  }
  return mapped;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function detectWithPdfxt(
  pdfPath: string,
  jobId: string,
): Promise<PdfxtServiceResponse> {
  const baseUrl = process.env.PDFXT_SERVICE_URL;
  if (!baseUrl) {
    throw new Error('PDFXT_SERVICE_URL env var is not set');
  }

  const apiKey = process.env.PDFXT_API_KEY;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90_000);

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/detect`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ pdfPath, jobId }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`PDFXT_TIMEOUT: exceeded 90s for jobId ${jobId}`);
      }
      throw err;
    }

    clearTimeout(timer);

    if (response.ok) {
      return (await response.json()) as PdfxtServiceResponse;
    }

    if (response.status >= 400 && response.status < 500) {
      const body = await response.text();
      throw new Error(`PDFXT_CLIENT_ERROR: ${response.status} ${body}`);
    }

    // 5xx — retry if attempts remain
    if (attempt < maxAttempts) {
      await sleep(3000);
      continue;
    }

    throw new Error(
      `PDFXT_SERVICE_ERROR: ${response.status} after retries`,
    );
  }

  // Unreachable, but TypeScript needs it
  throw new Error('PDFXT_SERVICE_ERROR: unexpected');
}
