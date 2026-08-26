import { describe, it, expect } from 'vitest';
import { pdfAuditService } from '../../../../src/services/pdf/pdf-audit.service';
import { TABLE_LIKELY_FORMULA_CODE } from '../../../../src/services/pdf/validators/pdf-table.validator';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';

// reconcileFormulaTableOverlap / boundingBoxOverlapRatio are private;
// exercise via cast, same pattern as ai-analysis-formula.test.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const svc = pdfAuditService as any;

const box = (x: number, y: number, width: number, height: number) => ({
  x, y, width, height, pageWidth: 612, pageHeight: 792,
});

const genuineFormula = (pageNumber: number, boundingBox: ReturnType<typeof box>): AuditIssue => ({
  id: 'pdf-formula-1',
  source: 'pdf-formula',
  severity: 'serious',
  code: 'FORMULA-MISSING-ACTUALTEXT',
  message: 'Formula missing ActualText',
  pageNumber,
  element: `formula_p${pageNumber}_mc0`,
  boundingBox,
});

const redirectedTable = (pageNumber: number, boundingBox: ReturnType<typeof box>): AuditIssue => ({
  id: 'pdf-table-1',
  source: 'pdf-table',
  severity: 'serious',
  code: TABLE_LIKELY_FORMULA_CODE,
  message: 'Table region likely a formula',
  pageNumber,
  element: `table-as-formula_p${pageNumber}_0`,
  boundingBox,
});

describe('PdfAuditService.reconcileFormulaTableOverlap', () => {
  it('drops a redirected table issue that substantially overlaps a genuine formula finding', () => {
    const formula = genuineFormula(3, box(100, 100, 200, 50));
    const redirected = redirectedTable(3, box(100, 100, 200, 50)); // identical region

    const result = svc.reconcileFormulaTableOverlap([redirected], [formula]);

    expect(result).toEqual([]);
  });

  it('keeps a redirected table issue on a different page from the genuine formula', () => {
    const formula = genuineFormula(3, box(100, 100, 200, 50));
    const redirected = redirectedTable(4, box(100, 100, 200, 50));

    const result = svc.reconcileFormulaTableOverlap([redirected], [formula]);

    expect(result).toEqual([redirected]);
  });

  it('keeps a redirected table issue that does not spatially overlap the genuine formula', () => {
    const formula = genuineFormula(3, box(100, 100, 200, 50));
    const redirected = redirectedTable(3, box(400, 400, 100, 50)); // far away, same page

    const result = svc.reconcileFormulaTableOverlap([redirected], [formula]);

    expect(result).toEqual([redirected]);
  });

  it('keeps a redirected table issue with only marginal overlap (below the 50% threshold)', () => {
    const formula = genuineFormula(3, box(100, 100, 200, 50));
    // Overlap area 10x50=500 of the redirected box's own 100x50=5000 → 10%, well under 50%.
    const redirected = redirectedTable(3, box(290, 100, 100, 50));

    const result = svc.reconcileFormulaTableOverlap([redirected], [formula]);

    expect(result).toEqual([redirected]);
  });

  it('never touches non-redirect table issues, even ones with an overlapping bounding box', () => {
    const formula = genuineFormula(3, box(100, 100, 200, 50));
    const ordinaryTableIssue: AuditIssue = {
      id: 'pdf-table-2',
      source: 'pdf-table',
      severity: 'serious',
      code: 'MATTERHORN-15-002',
      message: 'Table missing headers',
      pageNumber: 3,
      element: 'table_p3_0',
      boundingBox: box(100, 100, 200, 50),
    };

    const result = svc.reconcileFormulaTableOverlap([ordinaryTableIssue], [formula]);

    expect(result).toEqual([ordinaryTableIssue]);
  });

  it('is a no-op (identity, no filtering pass) when there are no genuine formula findings at all', () => {
    const redirected = redirectedTable(3, box(100, 100, 200, 50));

    const result = svc.reconcileFormulaTableOverlap([redirected], []);

    expect(result).toEqual([redirected]);
  });
});
