import { describe, it, expect } from 'vitest';
import { aiAnalysisService } from '../../../../src/services/pdf/ai-analysis.service';
import type { AiRemediationConfig } from '../../../../src/services/pdf/ai-analysis.service';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';
import type { PdfParseResult } from '../../../../src/services/pdf/pdf-comprehensive-parser.service';

/**
 * Regression coverage for ROLEMAP-FOOTNOTE-FLATTENED's dispatch. Like
 * ROLEMAP-INDEX-FLATTENED (see ai-analysis-index-structure-routing.test.ts),
 * this does NOT route to the plain /RoleMap retarget fix
 * (pdfStructureWriterService.fixDegenerateRoleMapEntry) -- it routes to a
 * dedicated structural fix (fixFootnoteStructure) that retargets /RoleMap
 * to /FENote, sets a NoteType attribute, and best-effort splits a clean
 * leading numeric label into /Lbl+/LBody -- see that method's own doc
 * comment for the full defect, the confirmed spec details, and the
 * deliberate /Ref-pairing (-2/-3) residual gap.
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

function footnoteIssue(): AuditIssue {
  return {
    id: 'rolemap-footnote-1',
    source: 'pdf-rolemap-integrity',
    severity: 'serious',
    code: 'ROLEMAP-FOOTNOTE-FLATTENED',
    message: 'The custom style "/TFN" is used 42 time(s) in this document...',
    element: 'TFN',
    location: 'Document-wide (style: /TFN)',
    matterhornCheckpoint: '01-006',
    matterhornHow: 'H',
  } as AuditIssue;
}

function buildParsed(): PdfParseResult {
  return { isTagged: true, pages: [{}] } as unknown as PdfParseResult;
}

describe('dispatchIssue: ROLEMAP-FOOTNOTE-FLATTENED routing', () => {
  it('routes to the dedicated footnote-structure-fix, a deterministic rule-based apply-to-pdf fix', async () => {
    const parsed = buildParsed();

    const res = await svc.dispatchIssue(footnoteIssue(), parsed, CONFIG, new Map(), new Map(), new Map());

    expect(res).not.toBeNull();
    expect(res.suggestionType).toBe('footnote-structure-fix');
    expect(res.applyMode).toBe('apply-to-pdf');
    expect(res.model).toBe('rule-based');
    // 0.8 -- lower than both the plain /RoleMap retarget (1.0) and the
    // index rebuild (0.9): the /Lbl split is a per-instance heuristic, and
    // the fix is KNOWN incomplete relative to the full PDF/UA-2 checkpoint
    // even when every instance succeeds (the -2/-3 /Ref pairing is a
    // documented, deliberate residual gap).
    expect(res.confidence).toBe(0.8);
  });

  it('never routes ROLEMAP-FOOTNOTE-FLATTENED to the plain /RoleMap retarget fix or the index structural fix', async () => {
    const parsed = buildParsed();

    const res = await svc.dispatchIssue(footnoteIssue(), parsed, CONFIG, new Map(), new Map(), new Map());

    expect(res.suggestionType).not.toBe('rolemap-target-fix');
    expect(res.suggestionType).not.toBe('index-structure-fix');
  });
});
