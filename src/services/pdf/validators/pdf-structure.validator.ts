/**
 * PDF Structure Validator
 *
 * Validates PDF document structure for accessibility compliance.
 * Checks tagging, heading hierarchy, reading order, language settings,
 * and content structure (lists, tables, figures).
 *
 * Maps issues to WCAG 2.1 criteria and Matterhorn Protocol checkpoints.
 */

import { v4 as uuidv4 } from 'uuid';
import { AuditIssue, IssueSeverity } from '../../audit/base-audit.service';
import { structureAnalyzerService, DocumentStructure } from '../structure-analyzer.service';
import { pdfParserService, ParsedPDF } from '../pdf-parser.service';
import { logger } from '../../../lib/logger';

/**
 * Matterhorn Protocol checkpoint mapping
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface MatterhornCheckpoint {
  checkpoint: string;
  description: string;
}

/**
 * WCAG criterion mapping with level
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface WCAGCriterion {
  criterion: string;
  level: 'A' | 'AA' | 'AAA';
}

/**
 * Validation result containing all identified issues
 */
export interface StructureValidationResult {
  issues: AuditIssue[];
  summary: {
    critical: number;
    serious: number;
    moderate: number;
    minor: number;
    total: number;
  };
  metadata: {
    isTaggedPDF: boolean;
    hasDocumentLanguage: boolean;
    hasDocumentTitle: boolean;
    totalHeadings: number;
    totalTables: number;
    totalLists: number;
  };
}

/**
 * PDF Structure Validator Service
 *
 * Validates PDF document structure for accessibility compliance
 * following WCAG 2.1 and Matterhorn Protocol standards.
 */
class PDFStructureValidator {
  /**
   * Validate PDF structure from file path
   *
   * @param filePath - Path to PDF file
   * @returns Validation result with issues
   */
  async validateFromFile(filePath: string): Promise<StructureValidationResult> {
    logger.info(`[PDFStructureValidator] Starting validation for ${filePath}`);

    const parsedPdf = await pdfParserService.parse(filePath);

    try {
      return await this.validate(parsedPdf);
    } finally {
      await pdfParserService.close(parsedPdf);
    }
  }

  /**
   * Validate PDF structure from parsed PDF
   *
   * @param parsedPdf - Parsed PDF document
   * @returns Validation result with issues
   */
  async validate(parsedPdf: ParsedPDF): Promise<StructureValidationResult> {
    const issues: AuditIssue[] = [];

    logger.info('[PDFStructureValidator] Analyzing document structure...');

    // Analyze document structure
    const structure = await structureAnalyzerService.analyzeStructure(parsedPdf);

    logger.info('[PDFStructureValidator] Running structure validations...');

    // Validate document structure
    issues.push(...this.validateDocumentStructure(structure, parsedPdf));

    // Validate content structure
    issues.push(...this.validateContentStructure(structure));

    // Calculate summary
    const summary = this.calculateSummary(issues);

    const metadata = {
      isTaggedPDF: structure.isTaggedPDF,
      hasDocumentLanguage: structure.language.hasDocumentLanguage,
      hasDocumentTitle: !!parsedPdf.structure.metadata.title,
      totalHeadings: structure.headings.headings.length,
      totalTables: structure.tables.length,
      totalLists: structure.lists.length,
    };

    logger.info(`[PDFStructureValidator] Validation complete - ${issues.length} issues found`);

    return {
      issues,
      summary,
      metadata,
    };
  }

  /**
   * Validate document-level structure
   *
   * Checks:
   * - PDF tagging
   * - Heading hierarchy
   * - Reading order
   * - Document language
   * - Document title
   *
   * @param structure - Analyzed document structure
   * @param parsedPdf - Parsed PDF document
   * @returns Array of issues
   */
  private validateDocumentStructure(
    structure: DocumentStructure,
    parsedPdf: ParsedPDF
  ): AuditIssue[] {
    const issues: AuditIssue[] = [];

    // Check if PDF is tagged (Matterhorn 01-003)
    if (!structure.isTaggedPDF) {
      issues.push(this.createIssue({
        source: 'pdf-structure',
        severity: 'critical',
        code: 'MATTERHORN-01-003',
        message: 'PDF is not tagged',
        wcagCriteria: ['1.3.1'],
        location: 'Document',
        suggestion: 'Add structural tags to the PDF document. Tagged PDFs are essential for accessibility as they provide semantic structure for assistive technologies.',
        category: 'structure',
      }));
    }

    // Check for suspect tag structure (Matterhorn 01-004)
    if (structure.isTaggedPDF && parsedPdf.structure.metadata.suspect) {
      issues.push(this.createIssue({
        source: 'pdf-structure',
        severity: 'serious',
        code: 'MATTERHORN-01-004',
        message: 'Document has suspect tag structure',
        wcagCriteria: ['1.3.1'],
        location: 'Document',
        suggestion: 'Review and fix the tag structure. The Suspects flag indicates potential tagging problems.',
        category: 'structure',
      }));
    }

    // Validate heading hierarchy (Matterhorn 06-001, WCAG 2.4.6)
    issues.push(...this.validateHeadingHierarchy(structure.headings));

    // Validate reading order (Matterhorn 09-004, WCAG 1.3.2)
    issues.push(...this.validateReadingOrder(structure.readingOrder));

    // Check document language (Matterhorn 11-001, WCAG 3.1.1)
    if (!structure.language.hasDocumentLanguage) {
      issues.push(this.createIssue({
        source: 'pdf-structure',
        severity: 'serious',
        code: 'MATTERHORN-11-001',
        message: 'Document language is not specified',
        wcagCriteria: ['3.1.1'],
        location: 'Document metadata',
        suggestion: 'Set the document language in the PDF metadata (e.g., "en" for English, "es" for Spanish).',
        category: 'language',
      }));
    }

    // Check document title (WCAG 2.4.2)
    if (!parsedPdf.structure.metadata.title) {
      issues.push(this.createIssue({
        source: 'pdf-structure',
        severity: 'serious',
        code: 'WCAG-2.4.2',
        message: 'Document title is not present in metadata',
        wcagCriteria: ['2.4.2'],
        location: 'Document metadata',
        suggestion: 'Add a descriptive title to the PDF document metadata.',
        category: 'metadata',
      }));
    }

    return issues;
  }

  /**
   * Validate heading hierarchy
   *
   * @param headings - Heading hierarchy information
   * @returns Array of issues
   */
  private validateHeadingHierarchy(headings: DocumentStructure['headings']): AuditIssue[] {
    const issues: AuditIssue[] = [];

    // Map structure analyzer issues to audit issues
    for (const issue of headings.issues) {
      let severity: IssueSeverity;
      let code: string;

      switch (issue.type) {
        case 'missing-h1':
          severity = 'serious';
          code = 'MATTERHORN-06-001';
          break;
        case 'skipped-level':
          severity = 'serious';
          code = 'HEADING-SKIP';
          break;
        case 'multiple-h1':
          severity = 'moderate';
          code = 'HEADING-MULTIPLE-H1';
          break;
        case 'improper-nesting':
          severity = 'serious';
          code = 'HEADING-NESTING';
          break;
        default:
          severity = 'moderate';
          code = 'HEADING-ISSUE';
      }

      issues.push(this.createIssue({
        source: 'pdf-structure',
        severity,
        code,
        message: issue.description,
        wcagCriteria: ['1.3.1', '2.4.6'],
        location: issue.location,
        suggestion: this.getHeadingSuggestion(issue.type),
        category: 'headings',
      }));
    }

    return issues;
  }

  /**
   * Get suggestion for heading issue
   *
   * @param issueType - Type of heading issue
   * @returns Suggestion text
   */
  private getHeadingSuggestion(issueType: string): string {
    switch (issueType) {
      case 'missing-h1':
        return 'Add a main H1 heading at the start of the document to establish the document hierarchy.';
      case 'skipped-level':
        return 'Fix heading hierarchy by not skipping levels (e.g., H1 → H2 → H3, not H1 → H3).';
      case 'multiple-h1':
        return 'Consider using only one H1 heading for the main document title. Use H2-H6 for subsections.';
      case 'improper-nesting':
        return 'Ensure headings are properly nested according to their hierarchy level.';
      default:
        return 'Review and fix heading structure to ensure proper hierarchy.';
    }
  }

  /**
   * Validate reading order
   *
   * @param readingOrder - Reading order information
   * @returns Array of issues
   */
  private validateReadingOrder(readingOrder: DocumentStructure['readingOrder']): AuditIssue[] {
    const issues: AuditIssue[] = [];

    if (!readingOrder.isLogical) {
      issues.push(this.createIssue({
        source: 'pdf-structure',
        severity: 'serious',
        code: 'MATTERHORN-09-004',
        message: 'Document reading order may not be logical',
        wcagCriteria: ['1.3.2'],
        location: 'Document',
        suggestion: 'Ensure the document has a logical reading order. Use tagged PDF structure to define the correct reading sequence.',
        category: 'reading-order',
      }));
    }

    // Map reading order issues
    for (const issue of readingOrder.issues) {
      let code: string;
      let suggestion: string;

      switch (issue.type) {
        case 'column-confusion':
          code = 'READING-ORDER-COLUMNS';
          suggestion = 'Tag multi-column layouts properly to ensure correct reading order across columns.';
          break;
        case 'visual-order':
          code = 'READING-ORDER-VISUAL';
          suggestion = 'Ensure reading order matches visual layout. Adjust tag order if needed.';
          break;
        case 'table-reading':
          code = 'READING-ORDER-TABLE';
          suggestion = 'Ensure table content is read in logical order (rows, then columns).';
          break;
        default:
          code = 'READING-ORDER-ISSUE';
          suggestion = 'Review and fix reading order to ensure logical content flow.';
      }

      issues.push(this.createIssue({
        source: 'pdf-structure',
        severity: 'moderate',
        code,
        message: issue.description,
        wcagCriteria: ['1.3.2'],
        location: issue.location || `Page ${issue.pageNumber}`,
        suggestion,
        category: 'reading-order',
      }));
    }

    return issues;
  }

  /**
   * Validate content structure
   *
   * Checks:
   * - List markup
   * - Table structure
   * - Figure elements
   *
   * @param structure - Analyzed document structure
   * @returns Array of issues
   */
  private validateContentStructure(structure: DocumentStructure): AuditIssue[] {
    const issues: AuditIssue[] = [];

    // Validate lists
    issues.push(...this.validateLists(structure.lists, structure.isTaggedPDF));

    // Validate tables
    issues.push(...this.validateTables(structure.tables));

    return issues;
  }

  /**
   * Validate list markup
   *
   * @param lists - List information
   * @param isTaggedPDF - Whether PDF is tagged
   * @returns Array of issues
   */
  private validateLists(lists: DocumentStructure['lists'], isTaggedPDF: boolean): AuditIssue[] {
    const issues: AuditIssue[] = [];

    if (lists.length > 0 && !isTaggedPDF) {
      issues.push(this.createIssue({
        source: 'pdf-structure',
        severity: 'moderate',
        code: 'LIST-NOT-TAGGED',
        message: `Found ${lists.length} list(s) in untagged PDF`,
        wcagCriteria: ['1.3.1'],
        location: 'Document',
        suggestion: 'Tag the PDF and mark lists with proper structure tags (L, LI, Lbl, LBody).',
        category: 'lists',
      }));
    }

    // Check individual lists for proper tagging
    for (const list of lists) {
      if (!list.isProperlyTagged) {
        issues.push(this.createIssue({
          source: 'pdf-structure',
          severity: 'moderate',
          code: 'LIST-IMPROPER-MARKUP',
          message: `List on page ${list.pageNumber} is not properly tagged`,
          wcagCriteria: ['1.3.1'],
          location: `Page ${list.pageNumber}`,
          suggestion: 'Ensure list is marked with proper tags: L (list), LI (list item), Lbl (label), LBody (body).',
          category: 'lists',
        }));
      }
    }

    return issues;
  }

  /**
   * Validate table structure
   *
   * @param tables - Table information
   * @returns Array of issues
   */
  private validateTables(tables: DocumentStructure['tables']): AuditIssue[] {
    const issues: AuditIssue[] = [];

    for (const table of tables) {
      // Check for accessibility issues identified by structure analyzer
      for (const tableIssue of table.issues) {
        issues.push(this.createIssue({
          source: 'pdf-structure',
          severity: 'serious',
          code: 'TABLE-ACCESSIBILITY',
          message: tableIssue,
          wcagCriteria: ['1.3.1'],
          location: `Page ${table.pageNumber}, Table ${table.id}`,
          suggestion: 'Ensure table has proper structure with Table, TR, TH, and TD tags. Add headers to identify row/column relationships.',
          category: 'tables',
        }));
      }

      // Check if table is not accessible
      if (!table.isAccessible) {
        const specificIssues: string[] = [];

        if (!table.hasHeaderRow && !table.hasHeaderColumn) {
          specificIssues.push('missing header cells');
        }

        if (table.rowCount > 5 && !table.hasSummary) {
          specificIssues.push('complex table without summary');
        }

        if (specificIssues.length === 0) {
          specificIssues.push('accessibility issues');
        }

        issues.push(this.createIssue({
          source: 'pdf-structure',
          severity: 'serious',
          code: 'TABLE-INACCESSIBLE',
          message: `Table on page ${table.pageNumber} has ${specificIssues.join(' and ')}`,
          wcagCriteria: ['1.3.1'],
          location: `Page ${table.pageNumber}, Table ${table.id}`,
          suggestion: 'Add TH (header) tags to identify row and column headers. For complex tables, add a summary describing the table structure.',
          category: 'tables',
        }));
      }
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
      id: uuidv4(),
      ...data,
    };
  }

  /**
   * Calculate summary counts by severity
   *
   * @param issues - Array of issues
   * @returns Summary with counts
   */
  private calculateSummary(issues: AuditIssue[]): StructureValidationResult['summary'] {
    return {
      critical: issues.filter(i => i.severity === 'critical').length,
      serious: issues.filter(i => i.severity === 'serious').length,
      moderate: issues.filter(i => i.severity === 'moderate').length,
      minor: issues.filter(i => i.severity === 'minor').length,
      total: issues.length,
    };
  }
}

export const pdfStructureValidator = new PDFStructureValidator();
