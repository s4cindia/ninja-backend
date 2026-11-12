import { describe, it, expect } from 'vitest';
import { aiAnalysisService } from '../../../../src/services/pdf/ai-analysis.service';
import type { AiRemediationConfig } from '../../../../src/services/pdf/ai-analysis.service';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';
import type { PdfParseResult } from '../../../../src/services/pdf/pdf-comprehensive-parser.service';

/**
 * Regression coverage for ROLEMAP-HEADING-FLATTENED/ROLEMAP-CAPTION-
 * FLATTENED's dispatch: always routes to a deterministic, rule-based,
 * apply-to-pdf fix -- retargeting a /RoleMap entry is safe and document-
 * wide once the custom tag's own name resolves to one of the two
 * unambiguous categories. ROLEMAP-FOOTNOTE-FLATTENED deliberately has NO
 * dispatch routing (falls through to manual review) -- see
 * pdf-rolemap-integrity.validator.ts's own header comment for why.
 *
 * ROLEMAP-INDEX-FLATTENED USED to fall through to manual review too, but
 * now has its own dedicated structural fix (routes to 'index-structure-fix',
 * NOT 'rolemap-target-fix' -- see pdf-structure-writer.service.ts's
 * fixIndexStructure and this suite's own dedicated
 * ai-analysis-index-structure-routing.test.ts for full coverage of that
 * path).
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

function roleMapIssue(code: string, element: string): AuditIssue {
  return {
    id: 'rolemap-1',
    source: 'pdf-rolemap-integrity',
    severity: 'serious',
    code,
    message: `test ${code}`,
    element,
    location: `Document-wide (style: /${element})`,
    matterhornCheckpoint: '01-006',
    matterhornHow: 'H',
  } as AuditIssue;
}

function buildParsed(): PdfParseResult {
  return { isTagged: true, pages: [{}] } as unknown as PdfParseResult;
}

describe('dispatchIssue: ROLEMAP-*-FLATTENED routing', () => {
  it('routes ROLEMAP-HEADING-FLATTENED to a deterministic rule-based apply-to-pdf fix', async () => {
    const parsed = buildParsed();

    const res = await svc.dispatchIssue(roleMapIssue('ROLEMAP-HEADING-FLATTENED', 'H1A'), parsed, CONFIG, new Map(), new Map(), new Map());

    expect(res).not.toBeNull();
    expect(res.suggestionType).toBe('rolemap-target-fix');
    expect(res.applyMode).toBe('apply-to-pdf');
    expect(res.model).toBe('rule-based');
    expect(res.confidence).toBe(1.0);
  });

  it('routes ROLEMAP-CAPTION-FLATTENED to the same deterministic fix', async () => {
    const parsed = buildParsed();

    const res = await svc.dispatchIssue(roleMapIssue('ROLEMAP-CAPTION-FLATTENED', 'FGC'), parsed, CONFIG, new Map(), new Map(), new Map());

    expect(res).not.toBeNull();
    expect(res.suggestionType).toBe('rolemap-target-fix');
    expect(res.applyMode).toBe('apply-to-pdf');
  });

  it('routes ROLEMAP-INDEX-FLATTENED to its own dedicated structural fix, NOT the RoleMap retarget', async () => {
    const parsed = buildParsed();

    const res = await svc.dispatchIssue(roleMapIssue('ROLEMAP-INDEX-FLATTENED', 'IDX1'), parsed, CONFIG, new Map(), new Map(), new Map());

    expect(res).not.toBeNull();
    expect(res.suggestionType).toBe('index-structure-fix');
    expect(res.suggestionType).not.toBe('rolemap-target-fix');
    expect(res.applyMode).toBe('apply-to-pdf');
    expect(res.model).toBe('rule-based');
    // Deliberately 0.9, not 1.0 -- see ROLEMAP_INDEX_CODES' own comment in
    // ai-analysis.service.ts for why this carries slightly less certainty
    // than a straight /RoleMap retarget.
    expect(res.confidence).toBe(0.9);
  });

  it('does not route ROLEMAP-FOOTNOTE-FLATTENED to the auto-fix path', async () => {
    const parsed = buildParsed();

    const res = await svc.dispatchIssue(roleMapIssue('ROLEMAP-FOOTNOTE-FLATTENED', 'TFN'), parsed, CONFIG, new Map(), new Map(), new Map());

    expect(res?.suggestionType).not.toBe('rolemap-target-fix');
  });
});
