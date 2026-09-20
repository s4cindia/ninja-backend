import { describe, it, expect, vi, afterEach } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { aiAnalysisService } from '../../../../src/services/pdf/ai-analysis.service';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';
import type { PdfParseResult } from '../../../../src/services/pdf/pdf-comprehensive-parser.service';

/**
 * Regression coverage for fallbackToPageRender's crop-render path (built
 * alongside mcid-bounding-box.ts to close a real, confirmed-live gap):
 * pdf-figure-structtree.validator.ts's struct-tree-only /Figure issues have
 * no extracted image to draft alt text from, so this fallback previously
 * always rendered and sent the WHOLE page -- on a page with more than one
 * such Figure, every separate issue got the IDENTICAL uncropped image with
 * no way to tell which figure was being asked about. Confirmed as the real
 * cause of a 283-issue category's round-over-round Auto Mode yield
 * collapsing to near zero after the first pass on a real 377-page document.
 */

// fallbackToPageRender/cropBase64Region are private; exercise via cast, same
// pattern as ai-analysis-table-summary-render.test.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const svc = aiAnalysisService as any;

/** A real, decodable PNG (not a mock string) so cropBase64Region's own
 * @napi-rs/canvas loadImage/drawImage calls exercise real code, not a stub. */
function realPageBase64(width = 600, height = 800): string {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#000000';
  ctx.fillRect(100, 200, 50, 30); // a distinguishable region
  return canvas.toBuffer('image/png').toString('base64');
}

function buildIssue(overrides: Partial<AuditIssue> = {}): AuditIssue {
  return {
    id: 'pdf-figure-structtree-1',
    source: 'pdf-figure-structtree',
    severity: 'critical',
    code: 'MATTERHORN-13-001',
    message: 'Figure "figure_p1_mc5" on page 1 has no alternative text',
    category: 'alt-text',
    pageNumber: 1,
    element: 'figure_p1_mc5',
    ...overrides,
  } as AuditIssue;
}

const PARSED = { parsedPdf: {} } as unknown as PdfParseResult;

describe('fallbackToPageRender crop-render path', () => {
  afterEach(() => vi.restoreAllMocks());

  it('crops to the issue\'s boundingBox, producing a smaller image than the uncropped page', async () => {
    const pageBase64 = realPageBase64();
    vi.spyOn(svc, 'renderPageToBase64').mockResolvedValue(pageBase64);
    const issue = buildIssue({ boundingBox: { x: 90, y: 190, width: 70, height: 50, pageWidth: 600, pageHeight: 800 } });

    const result = await svc.fallbackToPageRender(undefined, issue, PARSED, new Map());

    expect(result).toBeTruthy();
    expect(result.base64).not.toBe(pageBase64); // actually cropped, not just passed through
    // A cropped PNG of a ~78x58px region is unambiguously smaller than a 600x800 page.
    expect(Buffer.from(result.base64, 'base64').length).toBeLessThan(Buffer.from(pageBase64, 'base64').length);
  });

  it('returns the uncropped page image unchanged when the issue has no boundingBox', async () => {
    const pageBase64 = realPageBase64();
    vi.spyOn(svc, 'renderPageToBase64').mockResolvedValue(pageBase64);
    const issue = buildIssue(); // no boundingBox

    const result = await svc.fallbackToPageRender(undefined, issue, PARSED, new Map());

    expect(result.base64).toBe(pageBase64);
  });

  it('reuses one cached whole-page render across multiple issues on the same page, cropping each separately (no extra pdfjs render per figure)', async () => {
    const pageBase64 = realPageBase64();
    const renderSpy = vi.spyOn(svc, 'renderPageToBase64').mockResolvedValue(pageBase64);
    const cache = new Map();
    const issue1 = buildIssue({ id: 'a', element: 'figure_p1_mc1', boundingBox: { x: 10, y: 10, width: 20, height: 20, pageWidth: 600, pageHeight: 800 } });
    const issue2 = buildIssue({ id: 'b', element: 'figure_p1_mc2', boundingBox: { x: 300, y: 400, width: 40, height: 40, pageWidth: 600, pageHeight: 800 } });

    const result1 = await svc.fallbackToPageRender(undefined, issue1, PARSED, cache);
    const result2 = await svc.fallbackToPageRender(undefined, issue2, PARSED, cache);

    expect(renderSpy).toHaveBeenCalledTimes(1); // only one whole-page render for both
    expect(result1.base64).not.toBe(result2.base64); // but two distinct crops
  });

  it('falls back to the uncropped page when the cached render is not valid image data (crop failure is non-fatal)', async () => {
    vi.spyOn(svc, 'renderPageToBase64').mockResolvedValue('bm90LWEtcG5n'); // "not-a-png", decodable base64 but not a real image
    const issue = buildIssue({ boundingBox: { x: 10, y: 10, width: 20, height: 20, pageWidth: 600, pageHeight: 800 } });

    const result = await svc.fallbackToPageRender(undefined, issue, PARSED, new Map());

    expect(result).toBeTruthy();
    expect(result.base64).toBe('bm90LWEtcG5n'); // gracefully returns the (uncropped) page data instead of throwing
  });

  it('returns null when the page itself cannot be rendered at all, regardless of boundingBox', async () => {
    vi.spyOn(svc, 'renderPageToBase64').mockResolvedValue(null);
    const issue = buildIssue({ boundingBox: { x: 10, y: 10, width: 20, height: 20, pageWidth: 600, pageHeight: 800 } });

    const result = await svc.fallbackToPageRender(undefined, issue, PARSED, new Map());

    expect(result).toBeNull();
  });
});
