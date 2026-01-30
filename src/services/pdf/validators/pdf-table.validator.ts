/**
 * PDF Table Validator
 *
 * Validates table accessibility in PDF documents.
 * Checks table structure, headers, summaries, and identifies layout tables.
 *
 * Maps issues to WCAG 1.3.1, 1.3.2 and Matterhorn Protocol checkpoints.
 */

import { AuditIssue, IssueSeverity } from '../../audit/base-audit.service';
import { structureAnalyzerService, DocumentStructure, TableInfo } from '../structure-analyzer.service';
import { pdfParserService, ParsedPDF } from '../pdf-parser.service';
import { logger } from '../../../lib/logger';

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
   * @returns Validation result with issues
   */
  async validate(parsedPdf: ParsedPDF): Promise<TableValidationResult> {
    this.issueCounter = 0;
    const issues: AuditIssue[] = [];

    logger.info('[PDFTableValidator] Analyzing document structure...');

    // Analyze document structure to get table information
    const structure = await structureAnalyzerService.analyzeStructure(parsedPdf, {
      analyzeTables: true,
    });

    logger.info(`[PDFTableValidator] Found ${structure.tables.length} tables`);

    // Validate each table
    let layoutTableCount = 0;
    let dataTableCount = 0;

    for (const table of structure.tables) {
      // Detect if this is a layout table
      const layoutDetection = this.detectLayoutTable(table);

      if (layoutDetection.isLayoutTable) {
        layoutTableCount++;
        issues.push(...this.validateLayoutTable(table, parsedPdf.structure.metadata.isTagged, layoutDetection));
      } else {
        dataTableCount++;
        issues.push(...this.validateDataTable(table, parsedPdf.structure.metadata.isTagged));
      }
    }

    // Calculate summary
    const summary = this.calculateSummary(issues);

    const metadata = {
      totalTables: structure.tables.length,
      tablesWithHeaders: structure.tables.filter(t => t.hasHeaderRow || t.hasHeaderColumn).length,
      tablesWithoutHeaders: structure.tables.filter(t => !t.hasHeaderRow && !t.hasHeaderColumn).length,
      tablesWithSummary: structure.tables.filter(t => t.hasSummary).length,
      layoutTables: layoutTableCount,
      dataTables: dataTableCount,
    };

    logger.info(`[PDFTableValidator] Validation complete - ${issues.length} issues found`);

    return {
      issues,
      summary,
      metadata,
    };
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
  private validateDataTable(table: TableInfo, isTaggedPDF: boolean): AuditIssue[] {
    const issues: AuditIssue[] = [];
    const tableDimensions = `${table.rowCount}×${table.columnCount}`;
    const location = `Page ${table.pageNumber}, Table ${table.id}`;

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
        }));
      }
    }

    // Check for scope attribute (moderate issue if missing on headers)
    // Note: This is inferred from the structure analyzer's hasHeaderRow/Column
    // In a real implementation, we'd need to check the actual scope attributes
    if (isTaggedPDF && (table.hasHeaderRow || table.hasHeaderColumn)) {
      // This check is simplified - in production, you'd inspect the actual TH elements
      const needsScopeCheck = table.rowCount > 3 || table.columnCount > 3;
      if (needsScopeCheck) {
        issues.push(this.createIssue({
          source: 'pdf-table',
          severity: 'moderate',
          code: 'MATTERHORN-15-004',
          message: `Table on page ${table.pageNumber} headers may need scope attribute (${tableDimensions})`,
          wcagCriteria: ['1.3.1'],
          location,
          suggestion: 'Ensure TH (header) elements have scope attribute set to "row" or "col" to indicate what cells they apply to.',
          category: 'table-headers',
          element: table.id,
          context: `Table dimensions: ${tableDimensions}`,
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
    layoutDetection: LayoutTableDetection
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
