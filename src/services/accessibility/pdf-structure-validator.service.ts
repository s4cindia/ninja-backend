import { randomUUID } from 'crypto';
import path from 'path';
import { pdfParserService, ParsedPDF } from '../pdf/pdf-parser.service';
import { structureAnalyzerService } from '../pdf/structure-analyzer.service';
import {
  StructureValidationResult,
  AccessibilityIssue,
  HeadingInfo,
  ValidatorContext,
} from './types';
import { validateHeadingHierarchy } from './validators/heading-validator';
import { validateReadingOrder } from './validators/reading-order-validator';
import { validateLanguageDeclaration } from './validators/language-validator';

export interface StructureValidationOptions {
  validateHeadings?: boolean;
  validateReadingOrder?: boolean;
  validateLanguage?: boolean;
}

class PdfStructureValidatorService {
  async validateStructure(
    filePath: string,
    options: StructureValidationOptions = {}
  ): Promise<StructureValidationResult> {
    const startTime = Date.now();
    const documentId = randomUUID();

    const {
      validateHeadings = true,
      validateReadingOrder: validateOrder = true,
      validateLanguage = true,
    } = options;

    const allIssues: AccessibilityIssue[] = [];
    let totalChecks = 0;
    let passed = 0;
    let failed = 0;
    let warnings = 0;

    let parsedPdf: ParsedPDF | null = null;

    try {
      parsedPdf = await pdfParserService.parse(filePath);

      const isTaggedPdf = parsedPdf.structure.metadata.isTagged;
      const pageCount = parsedPdf.structure.pageCount;
      const documentLanguage = parsedPdf.structure.metadata.language;

      const context: ValidatorContext = {
        documentId,
        fileName: path.basename(filePath),
        isTaggedPdf,
        pageCount,
      };

      if (!isTaggedPdf) {
        allIssues.push({
          id: randomUUID(),
          wcagCriterion: '1.3.1',
          wcagLevel: 'A',
          severity: 'critical',
          title: 'Untagged PDF',
          description: 'This PDF does not have a tag structure. Tagged PDFs are required for accessibility as they define the document structure and reading order.',
          location: { page: 1 },
          remediation: 'Create a tagged PDF by using "Save as PDF" from an accessible source document or use PDF accessibility tools to add tags.',
        });
        totalChecks++;
        failed++;
      } else {
        totalChecks++;
        passed++;
      }

      if (validateHeadings) {
        totalChecks++;
        const structureResult = await structureAnalyzerService.analyzeStructure(parsedPdf, {
          analyzeHeadings: true,
          analyzeTables: false,
          analyzeLists: false,
          analyzeLinks: false,
          analyzeReadingOrder: false,
          analyzeLanguage: false,
        });

        const headings: HeadingInfo[] = (structureResult.headings?.headings || []).map(h => ({
          level: h.level,
          text: h.text,
          page: h.pageNumber || 1,
          isEmpty: !h.text || h.text.trim().length === 0,
        }));

        const headingResult = validateHeadingHierarchy(headings, context);
        allIssues.push(...headingResult.issues);

        if (headingResult.issues.filter(i => i.severity === 'critical' || i.severity === 'serious').length > 0) {
          failed++;
        } else if (headingResult.issues.length > 0) {
          warnings++;
        } else {
          passed++;
        }
      }

      if (validateOrder) {
        totalChecks++;
        try {
          const structureResultForOrder = await structureAnalyzerService.analyzeStructure(parsedPdf, {
            analyzeHeadings: false,
            analyzeTables: false,
            analyzeLists: false,
            analyzeLinks: false,
            analyzeReadingOrder: true,
            analyzeLanguage: false,
          });

          if (!structureResultForOrder.readingOrder) {
            allIssues.push({
              id: randomUUID(),
              wcagCriterion: '1.3.2',
              wcagLevel: 'A',
              severity: 'serious',
              title: 'Reading order analysis failed',
              description: 'Unable to analyze the reading order of this document. This may indicate a corrupted or unusual PDF structure.',
              location: { page: 1 },
              remediation: 'Ensure the PDF has a valid structure. Consider re-creating the PDF from the source document.',
            });
            failed++;
          } else {
            const orderResult = validateReadingOrder(structureResultForOrder.readingOrder, context);
            allIssues.push(...orderResult.issues);

            if (orderResult.issues.filter(i => i.severity === 'critical' || i.severity === 'serious').length > 0) {
              failed++;
            } else if (orderResult.issues.length > 0) {
              warnings++;
            } else {
              passed++;
            }
          }
        } catch (error) {
          console.warn('Error during reading order validation:', error);
          allIssues.push({
            id: randomUUID(),
            wcagCriterion: '1.3.2',
            wcagLevel: 'A',
            severity: 'serious',
            title: 'Reading order validation error',
            description: `An error occurred during reading order analysis: ${error instanceof Error ? error.message : 'Unknown error'}`,
            location: { page: 1 },
            remediation: 'Ensure the PDF is valid and try again. If the issue persists, manual review may be required.',
          });
          failed++;
        }
      }

      if (validateLanguage) {
        totalChecks++;
        const languageResult = validateLanguageDeclaration(
          documentLanguage,
          context
        );
        allIssues.push(...languageResult.issues);

        if (languageResult.issues.filter(i => i.severity === 'critical' || i.severity === 'serious').length > 0) {
          failed++;
        } else if (languageResult.issues.length > 0) {
          warnings++;
        } else {
          passed++;
        }
      }

      const score = this.calculateScore(allIssues, totalChecks, passed);
      const duration = Date.now() - startTime;

      console.log(`Structure validation completed in ${duration}ms - Score: ${score}/100`);

      return {
        isValid: failed === 0,
        score,
        issues: allIssues.sort((a, b) => {
          const severityOrder = { critical: 0, serious: 1, moderate: 2, minor: 3 };
          return severityOrder[a.severity] - severityOrder[b.severity];
        }),
        summary: {
          totalChecks,
          passed,
          failed,
          warnings,
        },
        metadata: {
          documentId,
          fileName: path.basename(filePath),
          validatedAt: new Date(),
          duration,
        },
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      allIssues.push({
        id: randomUUID(),
        wcagCriterion: 'N/A',
        wcagLevel: 'A',
        severity: 'critical',
        title: 'PDF Validation Error',
        description: `An error occurred during validation: ${errorMessage}`,
        location: { page: 1 },
        remediation: 'Ensure the PDF file is valid and not corrupted. Try re-saving the document.',
      });

      return {
        isValid: false,
        score: 0,
        issues: allIssues,
        summary: {
          totalChecks: 1,
          passed: 0,
          failed: 1,
          warnings: 0,
        },
        metadata: {
          documentId,
          validatedAt: new Date(),
          duration,
        },
      };
    } finally {
      if (parsedPdf) {
        await pdfParserService.close(parsedPdf);
      }
    }
  }

  private calculateScore(
    issues: AccessibilityIssue[],
    totalChecks: number,
    passed: number
  ): number {
    if (totalChecks === 0) return 100;

    const criticalCount = issues.filter(i => i.severity === 'critical').length;
    const seriousCount = issues.filter(i => i.severity === 'serious').length;
    const moderateCount = issues.filter(i => i.severity === 'moderate').length;
    const minorCount = issues.filter(i => i.severity === 'minor').length;

    const criticalPenalty = criticalCount * 25;
    const seriousPenalty = seriousCount * 15;
    const moderatePenalty = moderateCount * 5;
    const minorPenalty = minorCount * 2;

    const totalPenalty = criticalPenalty + seriousPenalty + moderatePenalty + minorPenalty;

    const baseScore = (passed / totalChecks) * 100;
    const score = Math.max(0, Math.min(100, baseScore - totalPenalty));

    return Math.round(score);
  }

  async validateByJobId(jobId: string): Promise<StructureValidationResult> {
    throw new Error('Job-based validation requires database integration - use validateStructure with file path instead');
  }
}

export const pdfStructureValidatorService = new PdfStructureValidatorService();
