import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { pdfAuditService } from '../../../../src/services/pdf/pdf-audit.service';
import { writePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';

// reconcileContrastFalsePositives is private; exercise via cast, same
// pattern as pdf-audit-formula-table-reconciliation.test.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const svc = pdfAuditService as any;

async function buildDoc(content: string): Promise<PDFDocument> {
  const src = await PDFDocument.create();
  src.addPage([500, 700]);
  const doc = await PDFDocument.load(await src.save());
  writePageContent(doc, 1, content);
  return doc;
}

function contrastIssue(id: string, x: number, overrides: Partial<AuditIssue> = {}): AuditIssue {
  return {
    id,
    source: 'contrast-validator',
    severity: 'serious',
    code: 'COLOR-CONTRAST',
    message: 'Text has low contrast',
    pageNumber: 1,
    boundingBox: { x, y: 700 - 150, width: 40, height: 14, pageWidth: 500, pageHeight: 700 },
    contrastData: { foreground: '#707176', background: '#707176', ratio: 1, requiredRatio: 4.5, isLargeText: false },
    ...overrides,
  };
}

describe('PdfAuditService.reconcileContrastFalsePositives', () => {
  it('drops a COLOR-CONTRAST finding when the matched run\'s own content-stream color already clears the required ratio', async () => {
    // Real Math_Weir_PDF.pdf shape: the audit's blended/diluted cd.foreground
    // (#707176) is wrong -- the run's OWN true color (white) already passes.
    const doc = await buildDoc('BT\n1 0 0 1 50 150 Tm\n1 1 1 rg\n(Whole) Tj\nET');
    const issue = contrastIssue('c1', 50);

    const result = svc.reconcileContrastFalsePositives([issue], doc);
    expect(result).toEqual([]);
  });

  it('keeps a COLOR-CONTRAST finding when the matched run genuinely fails', async () => {
    const doc = await buildDoc('BT\n1 0 0 1 50 150 Tm\n0.4 0.4 0.42 rg\n(Whole) Tj\nET');
    const issue = contrastIssue('c1', 50);

    const result = svc.reconcileContrastFalsePositives([issue], doc);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('c1');
  });

  // The real "8 749 47" pattern: the audit's blended detection anchors to
  // "8" (whose own true color already passes), but "749" (a SIBLING run
  // in the same text object) genuinely fails. Dropping the issue here
  // would silently hide a real defect from the whole pipeline -- including
  // PR #600's own sibling-fix, which would never get a chance to run.
  it('keeps the finding when the matched run passes but a SIBLING run in the same text object genuinely fails', async () => {
    const doc = await buildDoc(`BT
1 0 0 1 50 150 Tm
1 1 1 rg
(8) Tj
10 0 Td
0.15 0.15 0.15 rg
(749) Tj
ET
`);
    const issue = contrastIssue('c1', 50, {
      contrastData: { foreground: '#262626', background: '#707176', ratio: 3.12, requiredRatio: 4.5, isLargeText: false },
    });

    const result = svc.reconcileContrastFalsePositives([issue], doc);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('c1');
  });

  it('keeps a finding whose run cannot be confidently located (e.g. an ambiguous multi-op run)', async () => {
    // Two internal fill ops within the same run's own span -- locateTextRun
    // refuses to match this unambiguously (see contrast-content-stream.ts).
    const doc = await buildDoc('BT\n1 0 0 1 50 150 Tm\n1 1 1 rg\n0 0 0 rg\n(Whole) Tj\nET');
    const issue = contrastIssue('c1', 50);

    const result = svc.reconcileContrastFalsePositives([issue], doc);
    expect(result).toHaveLength(1);
  });

  it('passes issues through unchanged when no pdf-lib document is available', async () => {
    const issue = contrastIssue('c1', 50);
    const result = svc.reconcileContrastFalsePositives([issue], undefined);
    expect(result).toEqual([issue]);
  });

  // Deliberate scope gate: color-contrast-verification.test.ts's own "KNOWN
  // LIMITATION" fixtures prove cd.background can itself be wrong (a static
  // fill near ordinary-width text fools detection's own background
  // sampling) -- this cross-check trusts cd.background as ground truth, so
  // applying it at that width would risk inheriting the same corruption
  // and wrongly clearing a genuinely-failing issue. Confirms a wide box
  // whose content-stream color WOULD otherwise read as passing is left
  // untouched rather than dropped.
  it('does not drop a wide-box finding even when its content-stream color would otherwise read as passing (KNOWN LIMITATION scope gate)', async () => {
    const doc = await buildDoc('BT\n1 0 0 1 50 150 Tm\n1 1 1 rg\n(This is a much wider run of text) Tj\nET');
    const issue = contrastIssue('c1', 50, {
      boundingBox: { x: 50, y: 700 - 150, width: 200, height: 14, pageWidth: 500, pageHeight: 700 },
    });

    const result = svc.reconcileContrastFalsePositives([issue], doc);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('c1');
  });

  it('passes through issues missing contrastData or pageNumber untouched', async () => {
    const doc = await buildDoc('BT\n1 0 0 1 50 150 Tm\n1 1 1 rg\n(Whole) Tj\nET');
    const noContrastData = contrastIssue('c1', 50, { contrastData: undefined });
    const noPage = contrastIssue('c2', 50, { pageNumber: undefined });

    const result = svc.reconcileContrastFalsePositives([noContrastData, noPage], doc);
    expect(result).toEqual([noContrastData, noPage]);
  });
});
