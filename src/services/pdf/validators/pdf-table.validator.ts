/**
 * PDF Table Validator
 *
 * Validates table accessibility in PDF documents.
 * Checks table structure, headers, summaries, and identifies layout tables.
 *
 * Maps issues to WCAG 1.3.1, 1.3.2 and Matterhorn Protocol checkpoints.
 */

import { AuditIssue } from '../../audit/base-audit.service';
import { structureAnalyzerService, TableInfo } from '../structure-analyzer.service';
import { pdfParserService, ParsedPDF } from '../pdf-parser.service';
import { logger } from '../../../lib/logger';

/**
 * Issue code for a /Table-tagged region redirected to a formula-category
 * suggestion because its shape/lack of headers, combined with the same
 * page having confirmed genuine /Formula content, makes it far more
 * likely to be a matrix/equation than real tabular data. Deliberately
 * distinct from pdf-formula.validator.ts's FORMULA-MISSING-ACTUALTEXT —
 * this is a heuristic redirect, not a genuine structure-tree finding —
 * but ai-analysis.service.ts opts it into the same AI-drafting path.
 */
export const TABLE_LIKELY_FORMULA_CODE = 'TABLE-LIKELY-FORMULA-MISSING-ACTUALTEXT';

/**
 * Table validation result
 */
export interface TableValidationResult {
  issues: AuditIssue[];
  summary: {
    critical: number;
    serious: number;
    moderate: number;
    minor: number;
    total: number;
  };
  metadata: {
    totalTables: number;
    tablesWithHeaders: number;
    tablesWithoutHeaders: number;
    tablesWithSummary: number;
    layoutTables: number;
    dataTables: number;
    /** Tables redirected to a formula suggestion instead of a table issue — see TABLE_LIKELY_FORMULA_CODE. */
    redirectedToFormula: number;
  };
}

/**
 * Layout table detection result
 */
interface LayoutTableDetection {
  isLayoutTable: boolean;
  confidence: number;
  reasons: string[];
}

/**
 * PDF Table Validator Service
 *
 * Validates table accessibility in PDF documents
 * following WCAG 1.3.1, 1.3.2 and Matterhorn Protocol standards.
 */
class PDFTableValidator {
  private issueCounter = 0;
  private readonly MIN_DATA_TABLE_ROWS = 2;
  private readonly MIN_DATA_TABLE_COLS = 2;

  /**
   * Validate PDF tables from file path
   *
   * @param filePath - Path to PDF file
   * @returns Validation result with issues
   */
  async validateFromFile(filePath: string): Promise<TableValidationResult> {
    logger.info(`[PDFTableValidator] Starting validation for ${filePath}`);

    const parsedPdf = await pdfParserService.parse(filePath);

    try {
      return await this.validate(parsedPdf);
    } finally {
      await pdfParserService.close(parsedPdf);
    }
  }

  /**
   * Validate PDF tables from parsed PDF
   *
   * @param parsedPdf - Parsed PDF document
   * @param confirmedFormulaPages - Page numbers where pdf-formula.validator.ts
   *   found a genuine /Formula element. Used as a corroboration signal: a
   *   /Table-tagged region on one of these pages, with no header structure
   *   and an implausible aspect ratio, is redirected to a formula
   *   suggestion instead of a table issue. Requires the formula validator
   *   to have already run against the same document (pdf-audit.service.ts
   *   runs it before this one, specifically so this set is populated).
   * @returns Validation result with issues
   */
  async validate(parsedPdf: ParsedPDF, confirmedFormulaPages: ReadonlySet<number> = new Set()): Promise<TableValidationResult> {
    this.issueCounter = 0;
    const issues: AuditIssue[] = [];

    logger.info('[PDFTableValidator] Analyzing document structure...');

    // Analyze document structure to get table information
    const structure = await structureAnalyzerService.analyzeStructure(parsedPdf, {
      analyzeTables: true,
    });

    logger.info(`[PDFTableValidator] Found ${structure.tables.length} tables`);

    // Build page-dimension lookup (width/height at scale=1 in PDF points)
    const pageDims = new Map(
      parsedPdf.structure.pages.map(p => [p.pageNumber, { width: p.width, height: p.height }])
    );

    // Validate each table
    let layoutTableCount = 0;
    let dataTableCount = 0;
    let redirectedToFormulaCount = 0;

    for (const table of structure.tables) {
      const pageSize = pageDims.get(table.pageNumber) ?? { width: 0, height: 0 };

      if (this.isLikelyMisclassifiedFormula(table, confirmedFormulaPages)) {
        redirectedToFormulaCount++;
        issues.push(this.buildRedirectedFormulaIssue(table, pageSize));
        continue;
      }

      // Detect if this is a layout table
      const layoutDetection = this.detectLayoutTable(table);

      if (layoutDetection.isLayoutTable) {
        layoutTableCount++;
        issues.push(...this.validateLayoutTable(table, parsedPdf.structure.metadata.isTagged, layoutDetection, pageSize));
      } else {
        dataTableCount++;
        issues.push(...this.validateDataTable(table, parsedPdf.structure.metadata.isTagged, pageSize));
      }
    }

    // Calculate summary
    const summary = this.calculateSummary(issues);

    const metadata = {
      totalTables: structure.tables.length,
      tablesWithHeaders: structure.tables.filter(t => t.hasHeaderRow || t.hasHeaderColumn).length,
      tablesWithoutHeaders: structure.tables.filter(t => !t.hasHeaderRow && !t.hasHeaderColumn).length,
      tablesWithSummary: structure.tables.filter(t => t.hasSummary || (t.caption && t.caption.trim().length > 0)).length,
      layoutTables: layoutTableCount,
      dataTables: dataTableCount,
      redirectedToFormula: redirectedToFormulaCount,
    };

    logger.info(`[PDFTableValidator] Validation complete - ${issues.length} issues found`);

    return {
      issues,
      summary,
      metadata,
    };
  }

  /**
   * A /Table-tagged region is more likely a misclassified matrix/equation
   * than real tabular data when ALL of these hold:
   *  - the same page has a confirmed genuine /Formula element (the
   *    corroboration signal — without it, an oddly-shaped-but-real small
   *    table would otherwise get flagged too);
   *  - it has no header row or column at all (real data tables almost
   *    always have some header; matrices/vectors never do); and
   *  - its aspect ratio is implausible for a real table (e.g. 3 rows by
   *    20 columns) rather than merely unusual.
   *
   * This is a heuristic, not a certainty — see TABLE_LIKELY_FORMULA_CODE's
   * doc comment. Verified against real evidence (Math_Olszewski_PDF.pdf's
   * 16 misclassified regions, all on pages with confirmed formula content,
   * all header-less); the aspect-ratio bound is intentionally conservative
   * (>=3) to avoid flagging ordinary small data tables that just happen to
   * share a page with an unrelated formula.
   *
   * Also requires structureElementIndex to be set — without it there's no
   * way to re-locate the exact /Table StructElem at apply time, so this
   * table falls back to normal table validation instead of a suggestion
   * with a dead-end element id. In practice this only excludes untagged
   * PDFs (which never reach here: confirmedFormulaPages is always empty
   * without a structure tree to find genuine Formula elements in).
   */
  private isLikelyMisclassifiedFormula(table: TableInfo, confirmedFormulaPages: ReadonlySet<number>): boolean {
    if (!confirmedFormulaPages.has(table.pageNumber)) return false;
    if (table.hasHeaderRow || table.hasHeaderColumn) return false;
    if (table.structureElementIndex === undefined) return false;

    const larger = Math.max(table.rowCount, table.columnCount);
    const smaller = Math.max(1, Math.min(table.rowCount, table.columnCount));
    const aspectRatio = larger / smaller;
    return aspectRatio >= 3;
  }

  /**
   * Build a formula-category suggestion for a table region redirected by
   * isLikelyMisclassifiedFormula, instead of a table issue.
   *
   * The element id encodes structureElementIndex in the same
   * "formula_p{page}_{index}" positional format pdf-formula.validator.ts
   * uses for MCID-less formulas, so pdfModifierService.setActualText's
   * existing positional matching resolves it — Table elements are
   * containers with no MCID of their own, so exact MCID matching (used for
   * genuine Formula leaves) doesn't apply here. The caller must also pass
   * elementTypes: {'Table','table'} since this isn't a real /Formula
   * element; see ai-analysis.service.ts / pdf-ai-analysis.controller.ts.
   */
  private buildRedirectedFormulaIssue(
    table: TableInfo,
    pageSize: { width: number; height: number }
  ): AuditIssue {
    return this.createIssue({
      source: 'pdf-table',
      severity: 'serious',
      code: TABLE_LIKELY_FORMULA_CODE,
      message: `Region on page ${table.pageNumber} tagged as a Table (${table.rowCount}x${table.columnCount}, no headers) is likely a matrix or equation missing a text alternative`,
      wcagCriteria: ['1.1.1'],
      location: `Page ${table.pageNumber}, Table ${table.id}`,
      suggestion:
        'This region\'s shape and lack of header structure suggest it\'s a mathematical expression tagged as a Table, not real tabular data. AI can draft a spoken-math reading (ActualText) — review carefully, as the underlying classification is a heuristic, not a certainty.',
      category: 'formula',
      element: `table-as-formula_p${table.pageNumber}_${table.structureElementIndex}`,
      pageNumber: table.pageNumber,
      matterhornHow: 'M',
      boundingBox: {
        x: table.position.x,
        y: table.position.y,
        width: table.position.width,
        height: table.position.height,
        pageWidth: pageSize.width,
        pageHeight: pageSize.height,
      },
    });
  }

  /**
   * Detect if a table is used for layout purposes
   *
   * @param table - Table information
   * @returns Layout table detection result
   */
  private detectLayoutTable(table: TableInfo): LayoutTableDetection {
    const reasons: string[] = [];
    let layoutScore = 0;

    // Single column or single row tables are likely layout tables
    if (table.columnCount === 1) {
      reasons.push('single column');
      layoutScore += 30;
    }
    if (table.rowCount === 1) {
      reasons.push('single row');
      layoutScore += 30;
    }

    // No headers suggests layout table
    if (!table.hasHeaderRow && !table.hasHeaderColumn) {
      reasons.push('no headers');
      layoutScore += 20;
    }

    // Very small tables (2x2 or smaller) might be layout
    if (table.rowCount <= 2 && table.columnCount <= 2 && !table.hasHeaderRow) {
      reasons.push('small table without headers');
      layoutScore += 15;
    }

    // Tables with headers are likely data tables
    if (table.hasHeaderRow || table.hasHeaderColumn) {
      layoutScore -= 40;
    }

    // Tables with summaries are definitely data tables
    if (table.hasSummary) {
      layoutScore -= 50;
    }

    // Large tables are usually data tables
    if (table.rowCount >= 5 && table.columnCount >= 3) {
      layoutScore -= 20;
    }

    const isLayoutTable = layoutScore >= 30;
    const confidence = Math.min(100, Math.max(0, layoutScore)) / 100;

    return {
      isLayoutTable,
      confidence,
      reasons: isLayoutTable ? reasons : [],
    };
  }

  /**
   * Validate a data table for accessibility
   *
   * @param table - Table information
   * @param isTaggedPDF - Whether the PDF is tagged
   * @returns Array of issues for this table
   */
  private validateDataTable(
    table: TableInfo,
    isTaggedPDF: boolean,
    pageSize: { width: number; height: number }
  ): AuditIssue[] {
    const issues: AuditIssue[] = [];
    const tableDimensions = `${table.rowCount}×${table.columnCount}`;
    const location = `Page ${table.pageNumber}, Table ${table.id}`;
    const boundingBox = {
      x: table.position.x,
      y: table.position.y,
      width: table.position.width,
      height: table.position.height,
      pageWidth: pageSize.width,
      pageHeight: pageSize.height,
    };

    // Check if table is tagged (critical issue if not in tagged PDF)
    if (isTaggedPDF && table.issues.some(i => i.includes('not tagged'))) {
      issues.push(this.createIssue({
        source: 'pdf-table',
        severity: 'critical',
        code: 'MATTERHORN-15-001',
        message: `Table on page ${table.pageNumber} is not properly tagged (${tableDimensions})`,
        wcagCriteria: ['1.3.1'],
        location,
        suggestion: 'Tag the table with proper structure: Table element containing TR (rows) and TH/TD (cells).',
        category: 'table-structure',
        element: table.id,
        context: `Table dimensions: ${tableDimensions}`,
        pageNumber: table.pageNumber,
        boundingBox,
      }));
    }

    // Check for headers (serious issue if missing)
    if (!table.hasHeaderRow && !table.hasHeaderColumn) {
      issues.push(this.createIssue({
        source: 'pdf-table',
        severity: 'serious',
        code: 'MATTERHORN-15-002',
        message: `Data table on page ${table.pageNumber} has no headers (${tableDimensions})`,
        wcagCriteria: ['1.3.1'],
        location,
        suggestion: 'Add header row using TH (table header) tags in the first row, or use header column with TH tags in the first column.',
        category: 'table-headers',
        element: table.id,
        context: `Table dimensions: ${tableDimensions}`,
        pageNumber: table.pageNumber,
        boundingBox,
      }));
    }

    // Check for only one header type on larger tables (might need both)
    if (table.rowCount >= 5 && table.columnCount >= 5) {
      if (table.hasHeaderRow && !table.hasHeaderColumn) {
        issues.push(this.createIssue({
          source: 'pdf-table',
          severity: 'moderate',
          code: 'TABLE-HEADERS-INCOMPLETE',
          message: `Complex table on page ${table.pageNumber} only has header row (${tableDimensions})`,
          wcagCriteria: ['1.3.1'],
          location,
          suggestion: 'Consider adding header column for complex tables to improve navigation. Tables with both row and column headers are easier to understand.',
          category: 'table-headers',
          element: table.id,
          context: `Table dimensions: ${tableDimensions}`,
          pageNumber: table.pageNumber,
          boundingBox,
        }));
      } else if (!table.hasHeaderRow && table.hasHeaderColumn) {
        issues.push(this.createIssue({
          source: 'pdf-table',
          severity: 'moderate',
          code: 'TABLE-HEADERS-INCOMPLETE',
          message: `Complex table on page ${table.pageNumber} only has header column (${tableDimensions})`,
          wcagCriteria: ['1.3.1'],
          location,
          suggestion: 'Consider adding header row for complex tables to improve navigation. Tables with both row and column headers are easier to understand.',
          category: 'table-headers',
          element: table.id,
          context: `Table dimensions: ${tableDimensions}`,
          pageNumber: table.pageNumber,
          boundingBox,
        }));
      }
    }

    // Check for scope attribute (moderate issue if missing on headers)
    // Only report if there's explicit evidence from structure analyzer
    if (isTaggedPDF && (table.hasHeaderRow || table.hasHeaderColumn)) {
      const needsScopeCheck = table.rowCount > 3 || table.columnCount > 3;
      const hasMissingScopeEvidence = table.issues.some(
        i => i.toLowerCase().includes('missing scope') || i.toLowerCase().includes('scope attribute')
      );

      if (needsScopeCheck && hasMissingScopeEvidence) {
        issues.push(this.createIssue({
          source: 'pdf-table',
          severity: 'moderate',
          code: 'MATTERHORN-15-004',
          message: `Table on page ${table.pageNumber} headers missing scope attribute (${tableDimensions})`,
          wcagCriteria: ['1.3.1'],
          location,
          suggestion: 'Ensure TH (header) elements have scope attribute set to "row" or "col" to indicate what cells they apply to.',
          category: 'table-headers',
          element: table.id,
          context: `Table dimensions: ${tableDimensions}`,
          pageNumber: table.pageNumber,
          boundingBox,
        }));
      }
    }

    // Check for irregular structure
    if (table.issues.some(i => i.includes('irregular') || i.includes('structure'))) {
      issues.push(this.createIssue({
        source: 'pdf-table',
        severity: 'serious',
        code: 'MATTERHORN-15-003',
        message: `Table on page ${table.pageNumber} has irregular structure (${tableDimensions})`,
        wcagCriteria: ['1.3.1', '1.3.2'],
        location,
        suggestion: 'Ensure table has consistent structure with proper nesting: Table > TR > TH/TD. Fix any irregular cells or missing row/column tags.',
        category: 'table-structure',
        element: table.id,
        context: `Table dimensions: ${tableDimensions}`,
        pageNumber: table.pageNumber,
        boundingBox,
      }));
    }

    // Check for summary/caption (minor issue if missing on complex tables)
    if (!table.hasSummary && !table.caption) {
      if (table.rowCount >= 5 || table.columnCount >= 5) {
        issues.push(this.createIssue({
          source: 'pdf-table',
          severity: 'minor',
          code: 'TABLE-MISSING-SUMMARY',
          message: `Complex table on page ${table.pageNumber} lacks summary or caption (${tableDimensions})`,
          wcagCriteria: ['1.3.1'],
          location,
          suggestion: 'Add a summary or caption describing the table\'s purpose and structure. This helps screen reader users understand the table before navigating it.',
          category: 'table-summary',
          element: table.id,
          context: `Table dimensions: ${tableDimensions}`,
          pageNumber: table.pageNumber,
          boundingBox,
        }));
      }
    }

    // Add any existing issues from structure analyzer
    for (const tableIssue of table.issues) {
      // Skip issues we've already covered
      if (
        tableIssue.includes('no header') ||
        tableIssue.includes('not tagged') ||
        tableIssue.includes('irregular')
      ) {
        continue;
      }

      issues.push(this.createIssue({
        source: 'pdf-table',
        severity: 'moderate',
        code: 'TABLE-ACCESSIBILITY',
        message: `Table on page ${table.pageNumber}: ${tableIssue} (${tableDimensions})`,
        wcagCriteria: ['1.3.1'],
        location,
        suggestion: 'Review and fix the table accessibility issue identified.',
        category: 'table-structure',
        element: table.id,
        context: `Table dimensions: ${tableDimensions}`,
        pageNumber: table.pageNumber,
        boundingBox,
      }));
    }

    return issues;
  }

  /**
   * Validate a layout table
   *
   * @param table - Table information
   * @param isTaggedPDF - Whether the PDF is tagged
   * @param layoutDetection - Layout detection result
   * @returns Array of issues for this table
   */
  private validateLayoutTable(
    table: TableInfo,
    isTaggedPDF: boolean,
    layoutDetection: LayoutTableDetection,
    pageSize: { width: number; height: number }
  ): AuditIssue[] {
    const issues: AuditIssue[] = [];
    const tableDimensions = `${table.rowCount}×${table.columnCount}`;
    const location = `Page ${table.pageNumber}, Table ${table.id}`;
    const reasons = layoutDetection.reasons.join(', ');

    // Layout tables should be marked as artifacts or have role="presentation"
    if (isTaggedPDF) {
      // In a tagged PDF, layout tables should ideally be artifacts
      // This is a moderate issue as it affects how screen readers interpret the content
      issues.push(this.createIssue({
        source: 'pdf-table',
        severity: 'moderate',
        code: 'MATTERHORN-15-005',
        message: `Layout table on page ${table.pageNumber} should be marked as artifact (${tableDimensions})`,
        wcagCriteria: ['1.3.1', '1.3.2'],
        location,
        suggestion: `Mark layout table as artifact or use role="presentation" to indicate it's used for visual layout, not data. Detected as layout table because: ${reasons}.`,
        category: 'layout-table',
        element: table.id,
        context: `Table dimensions: ${tableDimensions}, Detection confidence: ${Math.round(layoutDetection.confidence * 100)}%`,
        pageNumber: table.pageNumber,
        boundingBox: {
          x: table.position.x,
          y: table.position.y,
          width: table.position.width,
          height: table.position.height,
          pageWidth: pageSize.width,
          pageHeight: pageSize.height,
        },
      }));
    }

    return issues;
  }

  /**
   * Create an audit issue with auto-incremented ID
   *
   * @param data - Issue data without ID
   * @returns Complete audit issue
   */
  private createIssue(data: Omit<AuditIssue, 'id'>): AuditIssue {
    return {
      id: `pdf-table-${++this.issueCounter}`,
      ...data,
    };
  }

  /**
   * Calculate summary counts by severity
   *
   * @param issues - Array of issues
   * @returns Summary with counts
   */
  private calculateSummary(issues: AuditIssue[]): TableValidationResult['summary'] {
    return {
      critical: issues.filter(i => i.severity === 'critical').length,
      serious: issues.filter(i => i.severity === 'serious').length,
      moderate: issues.filter(i => i.severity === 'moderate').length,
      minor: issues.filter(i => i.severity === 'minor').length,
      total: issues.length,
    };
  }
}

export const pdfTableValidator = new PDFTableValidator();
