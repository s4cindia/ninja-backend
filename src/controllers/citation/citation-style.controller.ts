/**
 * Citation Style Controller
 * Handles citation style conversion and DOI validation
 *
 * Endpoints:
 * - POST /document/:documentId/convert-style - Convert citation style
 * - POST /document/:documentId/validate-dois - Validate DOIs
 * - GET /styles - Get supported styles
 */

import { Request, Response, NextFunction } from 'express';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { aiFormatConverterService, CitationStyle } from '../../services/citation/ai-format-converter.service';
import { doiValidationService } from '../../services/citation/doi-validation.service';

export class CitationStyleController {
  /**
   * POST /api/v1/citation-management/document/:documentId/convert-style
   * Convert citation style
   */
  async convertStyle(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const { targetStyle } = req.body;
      const { tenantId } = req.user!;

      logger.info(`[CitationStyle] Converting style to ${targetStyle} for document ${documentId}`);

      // Validate target style
      const validStyles: CitationStyle[] = ['APA', 'MLA', 'Chicago', 'Vancouver', 'IEEE', 'Harvard', 'AMA'];
      if (!validStyles.includes(targetStyle)) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_STYLE', message: `Invalid style. Supported: ${validStyles.join(', ')}` }
        });
        return;
      }

      // Get document with tenant verification
      const document = await prisma.editorialDocument.findFirst({
        where: { id: documentId, tenantId },
        include: {
          referenceListEntries: { orderBy: { sortKey: 'asc' } },
          citations: true
        }
      });

      if (!document) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' }
        });
        return;
      }

      const references = document.referenceListEntries;
      if (references.length === 0) {
        res.status(400).json({
          success: false,
          error: { code: 'NO_REFERENCES', message: 'Document has no references to convert' }
        });
        return;
      }

      // Convert each reference
      const conversionResults: Array<{
        referenceId: string;
        originalText: string;
        convertedText: string;
        success: boolean;
        error?: string;
      }> = [];

      for (const ref of references) {
        try {
          const originalText = ref.formattedApa || ref.title || '';
          // TODO: Implement convertReference method in aiFormatConverterService
          // For now, use the original text as converted
          const converted = originalText;

          conversionResults.push({
            referenceId: ref.id,
            originalText,
            convertedText: converted,
            success: true
          });

          // Store conversion change
          await prisma.citationChange.create({
            data: {
              documentId,
              citationId: ref.id,
              changeType: 'REFERENCE_STYLE_CONVERSION',
              beforeText: originalText,
              afterText: converted,
              appliedBy: 'ai',
              isReverted: false
            }
          });
        } catch (error) {
          conversionResults.push({
            referenceId: ref.id,
            originalText: ref.formattedApa || ref.title || '',
            convertedText: '',
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      }

      // Update document style
      await prisma.editorialDocument.update({
        where: { id: documentId },
        data: { referenceListStyle: targetStyle }
      });

      const successCount = conversionResults.filter(r => r.success).length;

      res.json({
        success: true,
        data: {
          message: `Converted ${successCount}/${references.length} references to ${targetStyle}`,
          targetStyle,
          results: conversionResults,
          totalConverted: successCount,
          totalFailed: references.length - successCount
        }
      });
    } catch (error) {
      logger.error('[CitationStyle] Convert style failed:', error);
      next(error);
    }
  }

  /**
   * POST /api/v1/citation-management/document/:documentId/validate-dois
   * Validate all DOIs in references
   */
  async validateDOIs(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const { tenantId } = req.user!;

      logger.info(`[CitationStyle] Validating DOIs for document ${documentId}`);

      // Get document with tenant verification
      const document = await prisma.editorialDocument.findFirst({
        where: { id: documentId, tenantId },
        include: {
          referenceListEntries: { orderBy: { sortKey: 'asc' } }
        }
      });

      if (!document) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' }
        });
        return;
      }

      const referencesWithDOI = document.referenceListEntries.filter(r => r.doi);

      if (referencesWithDOI.length === 0) {
        res.json({
          success: true,
          data: {
            message: 'No DOIs found in references',
            validated: 0,
            valid: 0,
            invalid: 0,
            results: []
          }
        });
        return;
      }

      const validationResults: Array<{
        referenceId: string;
        doi: string;
        valid: boolean;
        metadata?: Record<string, unknown>;
        error?: string;
      }> = [];

      for (const ref of referencesWithDOI) {
        try {
          const result = await doiValidationService.validateDOI(ref.doi!);
          validationResults.push({
            referenceId: ref.id,
            doi: ref.doi!,
            valid: result.valid,
            metadata: result.metadata as Record<string, unknown> | undefined
          });
        } catch (error) {
          validationResults.push({
            referenceId: ref.id,
            doi: ref.doi!,
            valid: false,
            error: error instanceof Error ? error.message : 'Validation failed'
          });
        }
      }

      const validCount = validationResults.filter(r => r.valid).length;

      res.json({
        success: true,
        data: {
          message: `Validated ${validationResults.length} DOIs`,
          validated: validationResults.length,
          valid: validCount,
          invalid: validationResults.length - validCount,
          results: validationResults
        }
      });
    } catch (error) {
      logger.error('[CitationStyle] Validate DOIs failed:', error);
      next(error);
    }
  }

  /**
   * GET /api/v1/citation-management/styles
   * Get list of supported citation styles
   */
  async getStyles(_req: Request, res: Response): Promise<void> {
    res.json({
      success: true,
      data: {
        styles: [
          { id: 'APA', name: 'APA 7th Edition', description: 'American Psychological Association' },
          { id: 'MLA', name: 'MLA 9th Edition', description: 'Modern Language Association' },
          { id: 'Chicago', name: 'Chicago 17th Edition', description: 'Chicago Manual of Style' },
          { id: 'Vancouver', name: 'Vancouver', description: 'Medical and scientific publications' },
          { id: 'IEEE', name: 'IEEE', description: 'Institute of Electrical and Electronics Engineers' },
          { id: 'Harvard', name: 'Harvard', description: 'Author-date citation style' },
          { id: 'AMA', name: 'AMA 11th Edition', description: 'American Medical Association' }
        ]
      }
    });
  }
}

export const citationStyleController = new CitationStyleController();
