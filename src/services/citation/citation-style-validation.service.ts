import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { geminiService } from '../ai/gemini.service';
import { styleRulesService } from './style-rules.service';
import { AppError } from '../../utils/app-error';

export interface ValidationViolation {
  citationId: string;
  citationText: string;
  violationType: string;
  ruleReference: string;
  ruleName: string;
  explanation: string;
  originalText: string;
  suggestedFix: string;
  correctedCitation: string;
  severity: 'error' | 'warning' | 'info';
}

export interface ValidationResult {
  documentId: string;
  styleCode: string;
  styleName: string;
  summary: {
    totalCitations: number;
    validCitations: number;
    citationsWithErrors: number;
    citationsWithWarnings: number;
    errorCount: number;
    warningCount: number;
  };
  violations: ValidationViolation[];
}

class CitationStyleValidationService {
  async validateDocument(
    documentId: string,
    styleCode: string,
    tenantId: string
  ): Promise<ValidationResult> {
    const document = await prisma.editorialDocument.findFirst({
      where: { id: documentId, tenantId }
    });

    if (!document) {
      throw AppError.notFound('Document not found');
    }

    const citations = await prisma.citation.findMany({
      where: { documentId },
      include: {
        primaryComponent: true
      }
    });

    if (citations.length === 0) {
      return {
        documentId,
        styleCode,
        styleName: styleRulesService.getStyle(styleCode)?.name || styleCode,
        summary: {
          totalCitations: 0,
          validCitations: 0,
          citationsWithErrors: 0,
          citationsWithWarnings: 0,
          errorCount: 0,
          warningCount: 0
        },
        violations: []
      };
    }

    const style = styleRulesService.getStyle(styleCode);
    if (!style) {
      throw AppError.badRequest(`Unknown style code: ${styleCode}`);
    }

    await prisma.citationValidation.deleteMany({
      where: { documentId, styleCode }
    });

    const allViolations: ValidationViolation[] = [];

    for (const citation of citations) {
      const violations = await this.validateCitation(citation, styleCode);

      for (const violation of violations) {
        await prisma.citationValidation.create({
          data: {
            documentId,
            citationId: citation.id,
            styleCode,
            violationType: violation.violationType,
            ruleReference: violation.ruleReference,
            ruleName: violation.ruleName,
            explanation: violation.explanation,
            originalText: violation.originalText,
            suggestedFix: violation.suggestedFix,
            severity: violation.severity,
            status: 'pending'
          }
        });
      }

      allViolations.push(...violations);

      const hasErrors = violations.some(v => v.severity === 'error');
      const hasWarnings = violations.some(v => v.severity === 'warning');

      await prisma.citation.update({
        where: { id: citation.id },
        data: {
          validationStatus: hasErrors ? 'has_errors' : hasWarnings ? 'has_warnings' : 'valid',
          lastValidatedAt: new Date(),
          lastValidatedStyle: styleCode
        }
      });
    }

    const citationsWithErrors = new Set(
      allViolations.filter(v => v.severity === 'error').map(v => v.citationId)
    ).size;
    const citationsWithWarnings = new Set(
      allViolations.filter(v => v.severity === 'warning').map(v => v.citationId)
    ).size;

    return {
      documentId,
      styleCode,
      styleName: style.name,
      summary: {
        totalCitations: citations.length,
        validCitations: citations.length - citationsWithErrors - citationsWithWarnings,
        citationsWithErrors,
        citationsWithWarnings,
        errorCount: allViolations.filter(v => v.severity === 'error').length,
        warningCount: allViolations.filter(v => v.severity === 'warning').length
      },
      violations: allViolations
    };
  }

  private async validateCitation(
    citation: { id: string; rawText: string; citationType: string; detectedStyle?: string | null },
    styleCode: string
  ): Promise<ValidationViolation[]> {
    const style = styleRulesService.getStyle(styleCode);
    if (!style) return [];

    const rules = style.inTextRules;
    const rulesText = rules.map(r =>
      `- ${r.reference}: ${r.name} (${r.severity})\n  ${r.description}\n  Example: "${r.examples[0]?.incorrect}" → "${r.examples[0]?.correct}"`
    ).join('\n');

    const prompt = `You are an expert citation validator. Analyze this citation against ${style.name} rules.

CITATION TEXT:
"${citation.rawText}"

CITATION TYPE: ${citation.citationType}

${style.name} RULES TO CHECK:
${rulesText}

IMPORTANT CONTEXT:
- "n.d." is acceptable when no date is available
- "et al." usage depends on number of authors and citation occurrence
- Some variations may be acceptable - only flag clear violations

For each violation found, return a JSON array with objects containing:
- violationType: category (punctuation, capitalization, author_format, date_format, italics, order)
- ruleReference: the rule number (e.g., "APA 8.17")
- ruleName: brief rule name
- explanation: why this is a violation
- originalText: the specific problematic text
- suggestedFix: the corrected text
- correctedCitation: the full corrected citation
- severity: "error" or "warning"

Return an empty array [] if no violations found.
Return ONLY valid JSON array, no other text.`;

    try {
      const response = await geminiService.generateText(prompt, {
        temperature: 0.1,
        maxOutputTokens: 2048
      });

      // Strip markdown code blocks if present
      let jsonText = response.text.trim();
      if (jsonText.startsWith('```')) {
        jsonText = jsonText.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      }

      const violations = JSON.parse(jsonText);

      if (!Array.isArray(violations)) {
        return [];
      }

      return violations.map(v => ({
        citationId: citation.id,
        citationText: citation.rawText,
        violationType: v.violationType || 'unknown',
        ruleReference: v.ruleReference || '',
        ruleName: v.ruleName || '',
        explanation: v.explanation || '',
        originalText: v.originalText || '',
        suggestedFix: v.suggestedFix || '',
        correctedCitation: v.correctedCitation || citation.rawText,
        severity: v.severity === 'error' ? 'error' : 'warning'
      }));
    } catch (error) {
      logger.error('[Citation Validation] AI validation failed', error instanceof Error ? error : undefined);
      return [];
    }
  }

  async getValidations(
    documentId: string,
    tenantId: string,
    filters?: {
      status?: string;
      severity?: string;
      violationType?: string;
    }
  ) {
    const document = await prisma.editorialDocument.findFirst({
      where: { id: documentId, tenantId }
    });

    if (!document) {
      throw AppError.notFound('Document not found');
    }

    const where: Record<string, unknown> = { documentId };
    if (filters?.status) where.status = filters.status;
    if (filters?.severity) where.severity = filters.severity;
    if (filters?.violationType) where.violationType = filters.violationType;

    const validations = await prisma.citationValidation.findMany({
      where,
      include: {
        citation: true
      },
      orderBy: { createdAt: 'desc' }
    });

    return validations.map(v => ({
      ...v,
      citationText: v.citation?.rawText || v.originalText || '',
      correctedCitation: v.resolvedText || v.suggestedFix || v.originalText || ''
    }));
  }

  getAvailableStyles() {
    return styleRulesService.getAvailableStyles();
  }
}

export const citationStyleValidationService = new CitationStyleValidationService();
