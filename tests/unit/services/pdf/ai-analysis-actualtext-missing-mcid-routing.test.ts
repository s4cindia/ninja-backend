import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { aiAnalysisService } from '../../../../src/services/pdf/ai-analysis.service';
import type { AiRemediationConfig } from '../../../../src/services/pdf/ai-analysis.service';
import { writePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';
import type { PdfParseResult } from '../../../../src/services/pdf/pdf-comprehensive-parser.service';

/**
 * Regression coverage for ACTUALTEXT-MISSING-MCID's dispatch: always
 * routes to a deterministic, rule-based, apply-to-pdf fix -- a real
 * struct element + MCID + /ParentTree entry is built from a purely
 * structural fact about the content stream (see
 * pdf-structure-writer.service.ts's own fixActualTextMissingMcid), no AI
 * judgment call needed, same tier as artifact-actualtext-fix.
 */

// dispatchIssue is private; exercise via cast, same pattern as every other
// *-routing.test.ts in this suite.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const svc = aiAnalysisService as any;

const CONFIG: AiRemediationConfig = {
  tableFixMode: 'apply-to-pdf',
  altTextMode: 'apply-to-pdf',
  listMode: 'auto-resolve-decorative',
  languageMode: 'apply-to-pdf',
  colorContrastMode: 'guidance-only',
  linkTextMode: 'guidance-only',
  formFieldMode: 'guidance-only',
  bookmarkMode: 'guidance-only',
  confidenceThreshold: 0.75,
  autoApplyHighConfidence: false,
};

function actualTextMissingMcidIssue(): AuditIssue {
  return {
    id: 'pdf-structure-1',
    source: 'pdf-structure',
    severity: 'serious',
    code: 'ACTUALTEXT-MISSING-MCID',
    message: '4 /Span <</ActualText>> fragment(s) in 1 run(s) on this page have no real /MCID',
    pageNumber: 1,
    location: 'Page 1',
    matterhornCheckpoint: '01-005',
    matterhornHow: 'M',
  } as AuditIssue;
}

async function buildParsed(): Promise<PdfParseResult> {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  writePageContent(doc, 1, '/Span<</ActualText<0041>>> BDC \n(A)Tj\nEMC /Span<</ActualText<0042>>> BDC \n(B)Tj\nEMC\n');
  return { isTagged: true, pages: [{}], parsedPdf: { pdfLibDoc: doc } } as unknown as PdfParseResult;
}

describe('dispatchIssue: ACTUALTEXT-MISSING-MCID routing', () => {
  it('returns a deterministic rule-based apply-to-pdf fix', async () => {
    const parsed = await buildParsed();

    const res = await svc.dispatchIssue(actualTextMissingMcidIssue(), parsed, CONFIG, new Map(), new Map(), new Map());

    expect(res).not.toBeNull();
    expect(res.suggestionType).toBe('actualtext-missing-mcid-fix');
    expect(res.applyMode).toBe('apply-to-pdf');
    expect(res.model).toBe('rule-based');
    expect(res.confidence).toBe(1.0);
  });
});
