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
import { PdfContrastValidator } from './validators/pdf-contrast.validator';

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
  protected async validate(parsed: PdfParseResult): Promise<PdfValidationResult> {
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

    // Run validators sequentially and handle partial failures
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
   * @returns Complete audit report
   */
  protected async generateReport(
    validation: PdfValidationResult,
    jobId: string,
    fileName: string
  ): Promise<AuditReport> {
    logger.info(`[PdfAudit] Generating report for ${fileName}...`);

    const scoreBreakdown = this.calculateScore(validation.issues);
    const wcagMappings = this.mapToWcag(validation.issues);
    const summary = this.calculateSummary(validation.issues);

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
        categorizedIssues: {
          structure: validation.structureIssues.length,
          altText: validation.altTextIssues.length,
          contrast: validation.contrastIssues.length,
          table: validation.tableIssues.length,
        },
        matterhornCheckpoints: validation.matterhornResults.length,
        matterhornPassed: validation.matterhornResults.filter(r => r.passed).length,
        matterhornFailed: validation.matterhornResults.filter(r => !r.passed).length,
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
    const untaggedIssues = validation.structureIssues.filter(i => i.code === 'PDF-UNTAGGED');
    results.push({
      checkpointId: '01',
      passed: untaggedIssues.length === 0,
      failureCount: untaggedIssues.length,
      description: 'The document is a Tagged PDF',
      wcagMapping: ['1.3.1', '4.1.2'],
    });

    // Matterhorn 07: Document metadata
    const titleIssues = validation.structureIssues.filter(i => i.code === 'PDF-NO-TITLE');
    results.push({
      checkpointId: '07',
      passed: titleIssues.length === 0,
      failureCount: titleIssues.length,
      description: 'Document has a title',
      wcagMapping: ['2.4.2'],
    });

    // Matterhorn 16: Natural language
    const languageIssues = validation.structureIssues.filter(i => i.code === 'PDF-NO-LANGUAGE');
    results.push({
      checkpointId: '16',
      passed: languageIssues.length === 0,
      failureCount: languageIssues.length,
      description: 'Natural language is specified',
      wcagMapping: ['3.1.1'],
    });

    // Matterhorn 09: Alternative text
    results.push({
      checkpointId: '09',
      passed: validation.altTextIssues.length === 0,
      failureCount: validation.altTextIssues.length,
      description: 'Alternative text is provided for images',
      wcagMapping: ['1.1.1'],
    });

    // Matterhorn 11: Tables
    results.push({
      checkpointId: '11',
      passed: validation.tableIssues.length === 0,
      failureCount: validation.tableIssues.length,
      description: 'Tables are properly structured',
      wcagMapping: ['1.3.1'],
    });

    return results;
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
   * @returns Audit report
   */
  async runAuditFromBuffer(
    buffer: Buffer,
    jobId: string,
    fileName: string
  ): Promise<AuditReport> {
    try {
      logger.info(`[PdfAudit] Starting audit from buffer: ${fileName} (job: ${jobId})`);

      // Reset issue counter
      this.issueCounter = 0;

      // Parse the buffer
      logger.info(`[PdfAudit] Parsing buffer...`);
      const parsed = await this.parseBuffer(buffer, fileName);
      logger.info(`[PdfAudit] Buffer parsed successfully`);

      // Validate
      logger.info(`[PdfAudit] Validating...`);
      const validation = await this.validate(parsed);
      logger.info(`[PdfAudit] Validation complete`);

      // Generate report
      logger.info(`[PdfAudit] Generating report...`);
      const report = await this.generateReport(validation, jobId, fileName);
      logger.info(`[PdfAudit] Audit complete - Score: ${report.score}, Issues: ${report.issues.length}`);

      return report;
    } catch (error) {
      logger.error(`[PdfAudit] Audit failed for ${fileName}:`, error);
      throw error;
    }
  }
}

export const pdfAuditService = new PdfAuditService();
export type { PdfValidationResult, MatterhornCheckResult };
