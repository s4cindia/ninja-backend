import { describe, it, expect } from 'vitest';
import { aiAnalysisService } from '../../../../src/services/pdf/ai-analysis.service';
import type { AiRemediationConfig } from '../../../../src/services/pdf/ai-analysis.service';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';
import type { PdfParseResult } from '../../../../src/services/pdf/pdf-comprehensive-parser.service';

/**
 * Regression coverage for ROLEMAP-INDEX-FLATTENED's dispatch. Unlike
 * ROLEMAP-HEADING-FLATTENED/ROLEMAP-CAPTION-FLATTENED (which retarget a
 * single /RoleMap entry, see ai-analysis-rolemap-routing.test.ts), this
 * routes to a dedicated structural fix (pdfStructureWriterService.
 * fixIndexStructure) that builds a real /Index > /L > /LI > /LBody
 * container around each contiguous run of raw IDX1/IDX1F/IDX2/IDX3-tagged
 * elements -- see that method's own doc comment for the full defect and
 * algorithm this closes.
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

function indexIssue(): AuditIssue {
  return {
    id: 'rolemap-index-1',
    source: 'pdf-rolemap-integrity',
    severity: 'serious',
    code: 'ROLEMAP-INDEX-FLATTENED',
    message: 'The custom style "/IDX1" is used 42 time(s) in this document...',
    element: 'IDX1',
    location: 'Document-wide (style: /IDX1)',
    matterhornCheckpoint: '01-006',
    matterhornHow: 'H',
  } as AuditIssue;
}

function buildParsed(): PdfParseResult {
  return { isTagged: true, pages: [{}] } as unknown as PdfParseResult;
}

describe('dispatchIssue: ROLEMAP-INDEX-FLATTENED routing', () => {
  it('routes to the dedicated index-structure-fix, a deterministic rule-based apply-to-pdf fix', async () => {
    const parsed = buildParsed();

    const res = await svc.dispatchIssue(indexIssue(), parsed, CONFIG, new Map(), new Map(), new Map());

    expect(res).not.toBeNull();
    expect(res.suggestionType).toBe('index-structure-fix');
    expect(res.applyMode).toBe('apply-to-pdf');
    expect(res.model).toBe('rule-based');
    // 0.9, not 1.0 -- the transform is mechanically deterministic, but the
    // internal /Index shape it builds has no published normative
    // requirement (see fixIndexStructure's own doc comment), unlike a
    // straight /RoleMap retarget's 1.0.
    expect(res.confidence).toBe(0.9);
  });

  it('never routes ROLEMAP-INDEX-FLATTENED to the plain /RoleMap retarget fix', async () => {
    const parsed = buildParsed();

    const res = await svc.dispatchIssue(indexIssue(), parsed, CONFIG, new Map(), new Map(), new Map());

    expect(res.suggestionType).not.toBe('rolemap-target-fix');
  });
});
