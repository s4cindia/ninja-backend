import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { aiAnalysisService } from '../../../../src/services/pdf/ai-analysis.service';
import type { AiRemediationConfig } from '../../../../src/services/pdf/ai-analysis.service';
import { writePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';
import type { PdfParseResult } from '../../../../src/services/pdf/pdf-comprehensive-parser.service';

/**
 * Regression coverage for ARTIFACT-HIDES-ACTUALTEXT-SIBLING's dispatch:
 * always routes to a deterministic, rule-based, apply-to-pdf fix -- the
 * real letter is read directly from the active font's own /ToUnicode
 * CMap (confirmed real on Karsaklian_189165_9781606497623, see
 * pdf-structure-writer.service.ts's own fixArtifactActualTextSibling),
 * no AI judgment call needed, same tier as artifact-unwrap-complex-fix.
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

function artifactActualTextIssue(): AuditIssue {
  return {
    id: 'pdf-structure-1',
    source: 'pdf-structure',
    severity: 'serious',
    code: 'ARTIFACT-HIDES-ACTUALTEXT-SIBLING',
    message: '2 letter(s) on this page are marked /Artifact beside an already-tagged ActualText sibling',
    pageNumber: 1,
    location: 'Page 1',
    matterhornCheckpoint: '01-005',
    matterhornHow: 'M',
  } as AuditIssue;
}

async function buildParsed(): Promise<PdfParseResult> {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  writePageContent(doc, 1, '/Artifact BMC \n(D)Tj\nEMC /Span<</ActualText<0065>>> BDC \n(e)Tj\nEMC\n');
  return { isTagged: true, pages: [{}], parsedPdf: { pdfLibDoc: doc } } as unknown as PdfParseResult;
}

describe('dispatchIssue: ARTIFACT-HIDES-ACTUALTEXT-SIBLING routing', () => {
  it('returns a deterministic rule-based apply-to-pdf fix', async () => {
    const parsed = await buildParsed();

    const res = await svc.dispatchIssue(artifactActualTextIssue(), parsed, CONFIG, new Map(), new Map(), new Map());

    expect(res).not.toBeNull();
    expect(res.suggestionType).toBe('artifact-actualtext-fix');
    expect(res.applyMode).toBe('apply-to-pdf');
    expect(res.model).toBe('rule-based');
    expect(res.confidence).toBe(1.0);
  });
});
