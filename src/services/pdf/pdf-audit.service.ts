/**
 * PDF Audit Service
 *
 * Main orchestration service for PDF accessibility auditing.
 * Extends BaseAuditService and coordinates validators.
 *
 * Implements US-PDF-1.2 requirements
 */

import { logger } from '../../lib/logger';
import { BaseAuditService, AuditIssue, AuditReport } from '../audit/base-audit.service';
import {
  pdfComprehensiveParserService,
  PdfParseResult,
} from './pdf-comprehensive-parser.service';
import { pdfParserService } from './pdf-parser.service';
import { PdfContrastValidator } from './validators/pdf-contrast.validator';
import { pdfAltTextValidator } from './validators/pdf-alttext.validator';
import { pdfTableValidator } from './validators/pdf-table.validator';
import { pdfStructureValidator } from './validators/pdf-structure.validator';
import { ScanLevel, SCAN_LEVEL_CONFIGS, ValidatorType } from '../../types/scan-level.types';

/**
 * Matterhorn Protocol validation result
 */
export interface MatterhornCheckResult {
  checkpointId: string;
  passed: boolean;
  failureCount: number;
  description: string;
  wcagMapping?: string[];
}

/**
 * PDF validation result with categorized issues
 */
export interface PdfValidationResult {
  issues: AuditIssue[];
  structureIssues: AuditIssue[];
  altTextIssues: AuditIssue[];
  contrastIssues: AuditIssue[];
  tableIssues: AuditIssue[];
  matterhornResults: MatterhornCheckResult[];
  validatorErrors: Array<{
    validator: string;
    error: string;
  }>;
}

/**
 * Base validator interface
 */
interface PdfValidator {
  name: string;
  validate(parsed: PdfParseResult): Promise<AuditIssue[]>;
}

/**
 * Structure validator stub
 * TODO: Replace with actual implementation from feature/pdf-validators branch
 */
class PdfStructureValidatorStub implements PdfValidator {
  name = 'PdfStructureValidator';

  async validate(parsed: PdfParseResult): Promise<AuditIssue[]> {
    const issues: AuditIssue[] = [];

    // Check if PDF is tagged
    if (!parsed.isTagged) {
      issues.push({
        id: 'struct-001',
        source: 'structure-validator',
        severity: 'critical',
        code: 'PDF-UNTAGGED',
        message: 'PDF is not tagged. Tagged PDFs are required for accessibility.',
        wcagCriteria: ['1.3.1', '4.1.2'],
        category: 'structure',
      });
    }

    // Check for document language
    if (!parsed.metadata.language) {
      issues.push({
        id: 'struct-002',
        source: 'structure-validator',
        severity: 'serious',
        code: 'PDF-NO-LANGUAGE',
        message: 'PDF document does not specify a language.',
        wcagCriteria: ['3.1.1'],
        category: 'structure',
      });
    }

    // Check for title
    if (!parsed.metadata.title) {
      issues.push({
        id: 'struct-003',
        source: 'structure-validator',
        severity: 'serious',
        code: 'PDF-NO-TITLE',
        message: 'PDF document does not have a title.',
        wcagCriteria: ['2.4.2'],
        category: 'structure',
      });
    }

    return issues;
  }
}

/**
 * Alt text validator stub
 * TODO: Replace with actual implementation
 */
class PdfAltTextValidatorStub implements PdfValidator {
  name = 'PdfAltTextValidator';

  async validate(parsed: PdfParseResult): Promise<AuditIssue[]> {
    const issues: AuditIssue[] = [];

    // Check images for alt text
    for (const page of parsed.pages) {
      for (const image of page.images) {
        if (!image.hasAltText) {
          issues.push({
            id: `alt-${image.id}`,
            source: 'alt-text-validator',
            severity: 'critical',
            code: 'PDF-IMAGE-NO-ALT',
            message: `Image on page ${page.pageNumber} is missing alternative text.`,
            wcagCriteria: ['1.1.1'],
            location: `Page ${page.pageNumber}, Image ${image.id}`,
            category: 'alt-text',
            element: 'image',
            pageNumber: page.pageNumber,
          });
        }
      }
    }

    return issues;
  }
}

/**
 * Contrast validator stub - DEPRECATED
 * Replaced by PdfContrastValidator from validators/pdf-contrast.validator.ts
 */
// class PdfContrastValidatorStub implements PdfValidator {
//   name = 'PdfContrastValidator';
//
//   async validate(_parsed: PdfParseResult): Promise<AuditIssue[]> {
//     // Stub implementation - actual color contrast validation requires
//     // extracting color information from PDF content streams
//     return [];
//   }
// }

/**
 * Table validator stub
 * TODO: Replace with actual implementation
 */
class PdfTableValidatorStub implements PdfValidator {
  name = 'PdfTableValidator';

  async validate(parsed: PdfParseResult): Promise<AuditIssue[]> {
    const issues: AuditIssue[] = [];

    // Check tables for accessibility
    for (const page of parsed.pages) {
      for (const table of page.tables) {
        if (!table.isAccessible) {
          issues.push({
            id: table.id,
            source: 'table-validator',
            severity: 'serious',
            code: 'PDF-TABLE-INACCESSIBLE',
            message: `Table on page ${page.pageNumber} is not properly structured for accessibility.`,
            wcagCriteria: ['1.3.1'],
            location: `Page ${page.pageNumber}, Table ${table.id}`,
            category: 'table',
            element: 'table',
            suggestion: table.issues.join('; '),
            pageNumber: page.pageNumber,
          });
        }
      }
    }

    return issues;
  }
}

/**
 * PDF Audit Service
 *
 * Orchestrates PDF accessibility audit workflow
 */
class PdfAuditService extends BaseAuditService<PdfParseResult, PdfValidationResult> {
  private validators: PdfValidator[];

  constructor() {
    super();
    this.validators = [
      new PdfStructureValidatorStub(),
      new PdfAltTextValidatorStub(),
      new PdfContrastValidator(),
      new PdfTableValidatorStub(),
    ];
  }

  /**
   * Parse PDF file
   *
   * @param filePath - Path to PDF file
   * @returns Parsed PDF result
   */
  protected async parse(filePath: string): Promise<PdfParseResult> {
    logger.info(`[PdfAudit] Parsing PDF: ${filePath}`);
    return await pdfComprehensiveParserService.parse(filePath);
  }

  /**
   * Validate parsed PDF
   *
   * Runs all validators and aggregates results
   *
   * @param parsed - Parsed PDF
   * @returns Validation result with categorized issues
   */
  protected async validate(
    parsed: PdfParseResult,
    scanLevel: ScanLevel = 'basic',
    customValidators?: ValidatorType[]
  ): Promise<PdfValidationResult> {
    logger.info(`[PdfAudit] Running validators...`);

    const result: PdfValidationResult = {
      issues: [],
      structureIssues: [],
      altTextIssues: [],
      contrastIssues: [],
      tableIssues: [],
      matterhornResults: [],
      validatorErrors: [],
    };

    // Determine which validators to run based on scan level
    const config = SCAN_LEVEL_CONFIGS[scanLevel];
    const validatorsToRun = scanLevel === 'custom' && customValidators
      ? customValidators
      : config.validators;

    logger.info(`[PdfAudit] Scan level: ${scanLevel}, validators: ${validatorsToRun.join(', ')}`);

    // Use real validators if parsedPdf is available, otherwise use stubs
    if (parsed.parsedPdf) {
      logger.info('[PdfAudit] Using real validators with ParsedPDF');

      // 1. Structure Validator (includes headings, reading-order, lists, language, metadata)
      if (validatorsToRun.includes('structure') ||
          validatorsToRun.includes('headings') ||
          validatorsToRun.includes('reading-order') ||
          validatorsToRun.includes('lists') ||
          validatorsToRun.includes('language') ||
          validatorsToRun.includes('metadata')) {
        try {
          logger.info(`[PdfAudit] Running PdfStructureValidator...`);
          const structureResult = await pdfStructureValidator.validate(parsed.parsedPdf);
          result.structureIssues.push(...structureResult.issues);
          result.issues.push(...structureResult.issues);
          logger.info(`[PdfAudit] PdfStructureValidator found ${structureResult.issues.length} issues`);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          logger.error(`[PdfAudit] PdfStructureValidator failed:`, error);
          result.validatorErrors.push({ validator: 'PdfStructureValidator', error: errorMessage });
        }
      }

      // 2. Alt Text Validator
      if (validatorsToRun.includes('alt-text')) {
        try {
          logger.info(`[PdfAudit] Running PdfAltTextValidator...`);
          const altTextResult = await pdfAltTextValidator.validate(parsed.parsedPdf, true);
          result.altTextIssues.push(...altTextResult.issues);
          result.issues.push(...altTextResult.issues);
          logger.info(`[PdfAudit] PdfAltTextValidator found ${altTextResult.issues.length} issues`);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          logger.error(`[PdfAudit] PdfAltTextValidator failed:`, error);
          result.validatorErrors.push({ validator: 'PdfAltTextValidator', error: errorMessage });
        }
      }

      // 3. Contrast Validator
      if (validatorsToRun.includes('contrast')) {
        try {
          logger.info(`[PdfAudit] Running PdfContrastValidator...`);
          const contrastValidator = new PdfContrastValidator();
          const contrastIssues = await contrastValidator.validate(parsed);
          result.contrastIssues.push(...contrastIssues);
          result.issues.push(...contrastIssues);
          logger.info(`[PdfAudit] PdfContrastValidator found ${contrastIssues.length} issues`);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          logger.error(`[PdfAudit] PdfContrastValidator failed:`, error);
          result.validatorErrors.push({ validator: 'PdfContrastValidator', error: errorMessage });
        }
      }

      // 4. Table Validator
      if (validatorsToRun.includes('tables')) {
        try {
          logger.info(`[PdfAudit] Running PdfTableValidator...`);
          const tableResult = await pdfTableValidator.validate(parsed.parsedPdf);
          result.tableIssues.push(...tableResult.issues);
          result.issues.push(...tableResult.issues);
          logger.info(`[PdfAudit] PdfTableValidator found ${tableResult.issues.length} issues`);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          logger.error(`[PdfAudit] PdfTableValidator failed:`, error);
          result.validatorErrors.push({ validator: 'PdfTableValidator', error: errorMessage });
        }
      }
    } else {
      // Fallback to stub validators
      logger.info('[PdfAudit] Using stub validators with PdfParseResult');

      for (const validator of this.validators) {
        try {
          logger.info(`[PdfAudit] Running ${validator.name}...`);
          const issues = await validator.validate(parsed);

          // Categorize issues by validator
          if (validator.name === 'PdfStructureValidator') {
            result.structureIssues.push(...issues);
          } else if (validator.name === 'PdfAltTextValidator') {
            result.altTextIssues.push(...issues);
          } else if (validator.name === 'PdfContrastValidator') {
            result.contrastIssues.push(...issues);
          } else if (validator.name === 'PdfTableValidator') {
            result.tableIssues.push(...issues);
          }

          // Add to combined issues
          result.issues.push(...issues);

          logger.info(`[PdfAudit] ${validator.name} found ${issues.length} issues`);
        } catch (error) {
          // Log error but continue with other validators
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          logger.error(`[PdfAudit] ${validator.name} failed:`, error);

          result.validatorErrors.push({
            validator: validator.name,
            error: errorMessage,
          });
        }
      }
    }

    // Generate Matterhorn results from structure issues
    result.matterhornResults = this.generateMatterhornResults(result);

    // Deduplicate combined issues
    result.issues = this.deduplicateIssues(result.issues);

    logger.info(
      `[PdfAudit] Validation complete: ${result.issues.length} total issues ` +
      `(structure: ${result.structureIssues.length}, alt-text: ${result.altTextIssues.length}, ` +
      `contrast: ${result.contrastIssues.length}, table: ${result.tableIssues.length})`
    );

    return result;
  }

  /**
   * Generate audit report
   *
   * @param validation - Validation result
   * @param jobId - Job ID
   * @param fileName - File name
   * @param parsed - Parsed PDF data (optional)
   * @returns Complete audit report
   */
  protected async generateReport(
    validation: PdfValidationResult,
    jobId: string,
    fileName: string,
    parsed?: PdfParseResult
  ): Promise<AuditReport> {
    logger.info(`[PdfAudit] Generating report for ${fileName}...`);

    const scoreBreakdown = this.calculateScore(validation.issues);
    const wcagMappings = this.mapToWcag(validation.issues);
    const summary = this.calculateSummary(validation.issues);
    const matterhornSummary = this.generateMatterhornSummary(validation.matterhornResults);

    // Debug: Check if pageNumber is present in issues
    const sampleAltTextIssue = validation.issues.find(i => i.source === 'pdf-alttext');
    if (sampleAltTextIssue) {
      logger.debug(`[DEBUG] Sample alt-text issue BEFORE report creation: ${JSON.stringify(sampleAltTextIssue, null, 2)}`);
    }

    const report: AuditReport = {
      jobId,
      fileName,
      score: scoreBreakdown.score,
      scoreBreakdown,
      issues: validation.issues,
      summary,
      wcagMappings,
      metadata: {
        validator: 'PDF Accessibility Audit',
        pageCount: parsed?.metadata.pageCount || 1,
        categorizedIssues: {
          structure: validation.structureIssues.length,
          altText: validation.altTextIssues.length,
          contrast: validation.contrastIssues.length,
          table: validation.tableIssues.length,
        },
        matterhornCheckpoints: validation.matterhornResults.length,
        matterhornPassed: validation.matterhornResults.filter(r => r.passed).length,
        matterhornFailed: validation.matterhornResults.filter(r => !r.passed).length,
        matterhornSummary,
        validatorErrors: validation.validatorErrors,
      },
      auditedAt: new Date(),
    };

    logger.info(
      `[PdfAudit] Report generated: Score ${report.score}, ` +
      `${report.issues.length} issues, ${report.wcagMappings.length} WCAG mappings`
    );

    return report;
  }

  /**
   * Generate Matterhorn Protocol results from validation issues
   *
   * Maps validation issues to Matterhorn checkpoints
   *
   * @param validation - Validation result
   * @returns Matterhorn check results
   */
  private generateMatterhornResults(validation: PdfValidationResult): MatterhornCheckResult[] {
    const results: MatterhornCheckResult[] = [];

    // Matterhorn 01: Tagged PDF
    const untaggedIssues = validation.structureIssues.filter(
      i => i.code === 'MATTERHORN-01-003' || i.code === 'MATTERHORN-01-004' || i.code === 'PDF-UNTAGGED'
    );
    const isTagged = untaggedIssues.length === 0;
    results.push({
      checkpointId: '01',
      passed: isTagged,
      failureCount: untaggedIssues.length,
      description: isTagged ? 'Document is tagged' : 'Document is not tagged',
      wcagMapping: ['1.3.1', '4.1.2'],
    });

    // Matterhorn 07: Document metadata
    const titleIssues = validation.structureIssues.filter(i => i.code === 'WCAG-2.4.2' || i.code === 'PDF-NO-TITLE');
    const hasTitle = titleIssues.length === 0;
    results.push({
      checkpointId: '07',
      passed: hasTitle,
      failureCount: titleIssues.length,
      description: hasTitle ? 'Document has a title' : 'Document title is missing',
      wcagMapping: ['2.4.2'],
    });

    // Matterhorn 16: Natural language
    const languageIssues = validation.structureIssues.filter(i => i.code === 'MATTERHORN-11-001' || i.code === 'PDF-NO-LANGUAGE');
    const hasLanguage = languageIssues.length === 0;
    results.push({
      checkpointId: '16',
      passed: hasLanguage,
      failureCount: languageIssues.length,
      description: hasLanguage ? 'Natural language is specified' : 'Natural language is not specified',
      wcagMapping: ['3.1.1'],
    });

    // Matterhorn 11: Tables
    const tablesStructured = validation.tableIssues.length === 0;
    results.push({
      checkpointId: '11',
      passed: tablesStructured,
      failureCount: validation.tableIssues.length,
      description: tablesStructured ? 'Tables are properly structured' : 'Tables lack proper structure',
      wcagMapping: ['1.3.1'],
    });

    // Matterhorn 06: Heading hierarchy (structure issues)
    const headingIssues = validation.structureIssues.filter(
      i => i.category === 'headings' || i.code?.includes('HEADING')
    );
    const hasProperHeadings = headingIssues.length === 0;
    results.push({
      checkpointId: '06',
      passed: hasProperHeadings,
      failureCount: headingIssues.length,
      description: hasProperHeadings ? 'Heading hierarchy is proper' : 'Heading hierarchy issues detected',
      wcagMapping: ['1.3.1', '2.4.6'],
    });

    // Matterhorn 09: Reading order (structure issues)
    const readingOrderIssues = validation.structureIssues.filter(
      i => i.category === 'reading-order' || i.code?.includes('READING-ORDER')
    );
    const hasLogicalOrder = readingOrderIssues.length === 0;
    results.push({
      checkpointId: '09',
      passed: hasLogicalOrder,
      failureCount: readingOrderIssues.length,
      description: hasLogicalOrder ? 'Reading order is logical' : 'Reading order issues detected',
      wcagMapping: ['1.3.2'],
    });

    // Matterhorn 13: Alternative text
    const hasAltText = validation.altTextIssues.length === 0;
    results.push({
      checkpointId: '13',
      passed: hasAltText,
      failureCount: validation.altTextIssues.length,
      description: hasAltText ? 'All images have alternative text' : 'Images missing alternative text',
      wcagMapping: ['1.1.1'],
    });

    // Matterhorn 04: Lists (structure issues)
    const listIssues = validation.structureIssues.filter(
      i => i.category === 'lists' || i.code?.includes('LIST')
    );
    const hasProperLists = listIssues.length === 0;
    results.push({
      checkpointId: '04',
      passed: hasProperLists,
      failureCount: listIssues.length,
      description: hasProperLists ? 'Lists are properly tagged' : 'List structure issues detected',
      wcagMapping: ['1.3.1'],
    });

    return results;
  }

  /**
   * Generate Matterhorn summary from checkpoint results
   *
   * @param results - Matterhorn checkpoint results
   * @returns Matterhorn summary object
   */
  private generateMatterhornSummary(results: MatterhornCheckResult[]): unknown {
    // Category mapping for Matterhorn checkpoints
    const categoryMap: Record<string, string> = {
      '01': 'Document',
      '04': 'Lists',
      '06': 'Headings',
      '07': 'Metadata',
      '09': 'Reading Order',
      '11': 'Tables',
      '13': 'Alternative Text',
      '16': 'Natural Language',
    };

    // Detailed explanations for each checkpoint
    const getCheckpointDetails = (result: MatterhornCheckResult): string => {
      const checkpointId = result.checkpointId;

      if (result.passed) {
        switch (checkpointId) {
          case '01':
            return '✓ Document is properly tagged with PDF/UA structure tags, enabling screen readers and assistive technologies to navigate the content correctly.';
          case '04':
            return '✓ Lists are properly tagged with list structure elements, allowing screen readers to announce list boundaries and item counts.';
          case '06':
            return '✓ Heading hierarchy is logical and properly structured, enabling users to navigate by headings and understand document structure.';
          case '07':
            return '✓ Document metadata includes a title field, helping users identify the document when viewing multiple files.';
          case '09':
            return '✓ Reading order is logical and follows the intended content flow, ensuring assistive technologies present content in the correct sequence.';
          case '11':
            return '✓ Tables are properly structured with headers, allowing screen readers to convey relationships between data cells.';
          case '13':
            return '✓ All images have appropriate alternative text descriptions for users who cannot see visual content.';
          case '16':
            return '✓ Natural language is specified in the document metadata, enabling proper text-to-speech pronunciation.';
          default:
            return '✓ This checkpoint passed validation.';
        }
      } else {
        switch (checkpointId) {
          case '01':
            return `✗ Document is not tagged. PDF/UA requires structure tags (headings, paragraphs, lists) so assistive technologies can navigate the content. ${result.failureCount} issue(s) found.`;
          case '04':
            return `✗ ${result.failureCount} list structure issue(s) found. Lists need proper markup (L, LI, Lbl, LBody tags) so screen readers can announce list boundaries and item counts.`;
          case '06':
            return `✗ ${result.failureCount} heading hierarchy issue(s) found. Headings must follow logical hierarchy (H1→H2→H3) without skipping levels to maintain document structure.`;
          case '07':
            return `✗ Document title is missing from metadata. This makes it harder for users to identify the document when viewing multiple files or in document lists. ${result.failureCount} issue(s) found.`;
          case '09':
            return `✗ ${result.failureCount} reading order issue(s) found. Content must flow in a logical sequence so assistive technologies present information in the correct order.`;
          case '11':
            return `✗ ${result.failureCount} table(s) lack proper structure. Tables need header cells and proper markup so screen readers can convey relationships between data.`;
          case '13':
            return `✗ ${result.failureCount} image(s) missing alternative text. Screen reader users cannot access visual information without text descriptions.`;
          case '16':
            return `✗ Natural language is not specified. This prevents text-to-speech engines from using the correct pronunciation rules. ${result.failureCount} issue(s) found.`;
          default:
            return `✗ This checkpoint failed validation. ${result.failureCount} issue(s) found.`;
        }
      }
    };

    // Group checkpoints by category
    const categoriesMap = new Map<string, {
      id: string;
      name: string;
      checkpoints: Array<{
        id: string;
        description: string;
        status: 'passed' | 'failed' | 'not-applicable';
        issueCount: number;
        details: string;
        wcagMapping?: string[];
      }>;
    }>();

    results.forEach(result => {
      const categoryId = result.checkpointId.split('-')[0] || result.checkpointId;

      if (!categoriesMap.has(categoryId)) {
        categoriesMap.set(categoryId, {
          id: categoryId,
          name: categoryMap[categoryId] || `Category ${categoryId}`,
          checkpoints: [],
        });
      }

      const category = categoriesMap.get(categoryId)!;
      category.checkpoints.push({
        id: `${categoryId}-${String(category.checkpoints.length + 1).padStart(3, '0')}`,
        description: result.description,
        status: result.passed ? 'passed' : 'failed',
        issueCount: result.failureCount,
        details: getCheckpointDetails(result),
        wcagMapping: result.wcagMapping,
      });
    });

    const categories = Array.from(categoriesMap.values());
    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;

    return {
      totalCheckpoints: results.length,
      passed,
      failed,
      notApplicable: 0,
      categories,
    };
  }

  /**
   * Parse PDF from buffer
   *
   * @param buffer - PDF buffer
   * @param fileName - File name
   * @returns Parsed PDF result
   */
  async parseBuffer(buffer: Buffer, fileName: string): Promise<PdfParseResult> {
    logger.info(`[PdfAudit] Parsing PDF buffer: ${fileName}`);
    return await pdfComprehensiveParserService.parseBuffer(buffer, fileName);
  }

  /**
   * Run audit from buffer
   *
   * @param buffer - PDF buffer
   * @param jobId - Job ID
   * @param fileName - File name
   * @param scanLevel - Scan level (basic, comprehensive, custom)
   * @param customValidators - Custom validators (only used when scanLevel is 'custom')
   * @returns Audit report
   */
  async runAuditFromBuffer(
    buffer: Buffer,
    jobId: string,
    fileName: string,
    scanLevel: ScanLevel = 'basic',
    customValidators?: ValidatorType[]
  ): Promise<AuditReport> {
    let parsed: PdfParseResult | null = null;

    try {
      logger.info(`[PdfAudit] Starting audit from buffer: ${fileName} (job: ${jobId}, scan: ${scanLevel})`);

      // Reset issue counter
      this.issueCounter = 0;

      // Parse the buffer
      logger.info(`[PdfAudit] Parsing buffer...`);
      parsed = await this.parseBuffer(buffer, fileName);
      logger.info(`[PdfAudit] Buffer parsed successfully`);

      // Validate
      logger.info(`[PdfAudit] Validating with ${scanLevel} scan level...`);
      const validation = await this.validate(parsed, scanLevel, customValidators);
      logger.info(`[PdfAudit] Validation complete`);

      // Generate report
      logger.info(`[PdfAudit] Generating report...`);
      const report = await this.generateReport(validation, jobId, fileName, parsed);
      logger.info(`[PdfAudit] Audit complete - Score: ${report.score}, Issues: ${report.issues.length}`);

      return report;
    } catch (error) {
      logger.error(`[PdfAudit] Audit failed for ${fileName}:`, error);
      throw error;
    } finally {
      // Cleanup parsedPdf handle after validation
      if (parsed?.parsedPdf) {
        try {
          await pdfParserService.close(parsed.parsedPdf);
          logger.info('[PdfAudit] Closed parsedPdf handle');
        } catch (closeError) {
          logger.warn('[PdfAudit] Failed to close parsedPdf handle:', closeError);
        }
      }
    }
  }
}

export const pdfAuditService = new PdfAuditService();
