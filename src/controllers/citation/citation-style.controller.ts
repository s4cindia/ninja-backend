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
import { CitationStyle, aiFormatConverterService } from '../../services/citation/ai-format-converter.service';
import { ReferenceEntry, InTextCitation } from '../../services/citation/ai-citation-detector.service';
import { doiValidationService } from '../../services/citation/doi-validation.service';
import { resolveDocumentSimple } from './document-resolver';
import { buildRefIdToNumberMap, getRefNumber } from '../../utils/citation.utils';

export class CitationStyleController {
  /**
   * POST /api/v1/citation-management/document/:documentId/convert-style
   * Convert citation style
   *
   * NOTE: The :documentId param can be either a document ID or a job ID.
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

      // Resolve document (handles both document ID and job ID)
      const baseDoc = await resolveDocumentSimple(documentId, tenantId);

      if (!baseDoc) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' }
        });
        return;
      }

      // Get document with full relations using resolved ID
      const document = await prisma.editorialDocument.findFirst({
        where: { id: baseDoc.id, tenantId },
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

      // Map Prisma references to service format
      const serviceReferences: ReferenceEntry[] = references.map((ref, index) => ({
        id: ref.id,
        number: index + 1,
        rawText: ref.formattedApa || ref.title || '',
        components: {
          authors: ref.authors as string[] | undefined,
          year: ref.year ?? undefined,
          title: ref.title ?? undefined,
          journal: ref.journalName ?? undefined,
          volume: ref.volume ?? undefined,
          issue: ref.issue ?? undefined,
          pages: ref.pages ?? undefined,
          doi: ref.doi ?? undefined,
          url: ref.url ?? undefined,
          publisher: ref.publisher ?? undefined
        },
        detectedStyle: document.referenceListStyle as CitationStyle | undefined,
        citedBy: []
      }));

      // Map Prisma citations to service format
      const serviceCitations: InTextCitation[] = document.citations.map(cit => {
        // Map Prisma citationType to service type
        const typeMap: Record<string, 'numeric' | 'author-year' | 'superscript' | 'footnote'> = {
          'NUMERIC': 'numeric',
          'PARENTHETICAL': 'author-year',
          'NARRATIVE': 'author-year',
          'FOOTNOTE': 'footnote',
          'ENDNOTE': 'footnote',
          'REFERENCE': 'numeric',
          'UNKNOWN': 'numeric'
        };

        // Infer format from citation text
        let format: 'bracket' | 'parenthesis' | 'superscript' = 'parenthesis';
        if (cit.rawText.includes('[')) {
          format = 'bracket';
        } else if (/[⁰¹²³⁴⁵⁶⁷⁸⁹]/.test(cit.rawText)) {
          format = 'superscript';
        }

        // Extract reference numbers from citation text
        const numberMatches = cit.rawText.match(/\d+/g);
        const numbers = numberMatches ? numberMatches.map(n => parseInt(n, 10)) : [];

        return {
          id: cit.id,
          text: cit.rawText,
          type: typeMap[cit.citationType] || 'numeric',
          format,
          numbers,
          position: {
            paragraph: cit.paragraphIndex ?? 0,
            sentence: 0,
            startChar: cit.startOffset,
            endChar: cit.endOffset
          },
          context: '' // Context not stored in Prisma Citation model
        };
      });

      // Call the AI format converter service
      const conversionResult = await aiFormatConverterService.convertStyle(
        serviceReferences,
        serviceCitations,
        targetStyle
      );

      // Build conversion results for response
      const conversionResults: Array<{
        referenceId: string;
        originalText: string;
        convertedText: string;
        success: boolean;
        error?: string;
      }> = [];

      // Update references in database and track changes
      for (const change of conversionResult.changes) {
        const originalRef = references.find(r => r.id === change.referenceId);
        if (!originalRef) continue;

        try {
          // Update the reference with converted text
          await prisma.referenceListEntry.update({
            where: { id: change.referenceId },
            data: {
              formattedApa: change.newFormat
            }
          });

          conversionResults.push({
            referenceId: change.referenceId,
            originalText: change.oldFormat,
            convertedText: change.newFormat,
            success: true
          });

          // Store conversion change for track changes
          // Use document.id (the resolved actual document ID) not documentId (which may be a job ID)
          await prisma.citationChange.create({
            data: {
              documentId: document.id,
              citationId: change.referenceId,
              changeType: 'REFERENCE_STYLE_CONVERSION',
              beforeText: change.oldFormat,
              afterText: change.newFormat,
              appliedBy: 'ai',
              isReverted: false
            }
          });
        } catch (error) {
          conversionResults.push({
            referenceId: change.referenceId,
            originalText: change.oldFormat,
            convertedText: '',
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      }

      // Store in-text citation conversions for track changes
      // Use document.id (the resolved actual document ID) not documentId (which may be a job ID)
      for (const citConversion of conversionResult.citationConversions) {
        await prisma.citationChange.create({
          data: {
            documentId: document.id,
            changeType: 'INTEXT_STYLE_CONVERSION',
            beforeText: citConversion.oldText,
            afterText: citConversion.newText,
            appliedBy: 'ai',
            isReverted: false
          }
        });
      }

      // Update document style
      // Use document.id (the resolved actual document ID) not documentId (which may be a job ID)
      await prisma.editorialDocument.update({
        where: { id: document.id },
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
          totalFailed: references.length - successCount,
          inTextCitationChanges: conversionResult.citationConversions.length,
          citationConversions: conversionResult.citationConversions
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
   *
   * NOTE: The :documentId param can be either a document ID or a job ID.
   */
  async validateDOIs(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const { tenantId } = req.user!;

      logger.info(`[CitationStyle] Validating DOIs for document ${documentId}`);

      // Resolve document (handles both document ID and job ID)
      const baseDoc = await resolveDocumentSimple(documentId, tenantId);

      if (!baseDoc) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' }
        });
        return;
      }

      // Get document with full relations using resolved ID
      const document = await prisma.editorialDocument.findFirst({
        where: { id: baseDoc.id, tenantId },
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

      // Build reference number map using shared utility
      const refIdToNumber = buildRefIdToNumberMap(document.referenceListEntries);

      // Convert to ReferenceEntry format for validateReferences (which has rate limiting)
      const referenceEntries: ReferenceEntry[] = referencesWithDOI.map((ref, index) => ({
        id: ref.id,
        number: getRefNumber(refIdToNumber, ref.id) ?? index + 1,
        rawText: ref.formattedApa || ref.title,
        components: {
          authors: Array.isArray(ref.authors) ? ref.authors as string[] : [],
          year: ref.year ?? undefined,
          title: ref.title,
          journal: ref.journalName ?? undefined,
          volume: ref.volume ?? undefined,
          issue: ref.issue ?? undefined,
          pages: ref.pages ?? undefined,
          doi: ref.doi ?? undefined,
          url: ref.url ?? undefined
        },
        detectedStyle: 'APA',
        citedBy: []
      }));

      // Use validateReferences which has rate limiting (global + per-tenant)
      const serviceResults = await doiValidationService.validateReferences(referenceEntries, tenantId);

      // Build validation results with discrepancies
      const validationResults = serviceResults.map((result, index) => {
        const ref = referencesWithDOI[index];
        const refNumber = getRefNumber(refIdToNumber, ref.id);

        // Build discrepancies from service result
        const discrepancies: Array<{ field: string; referenceValue: string; crossrefValue: string }> = [];

        if (result.hasValidDOI && result.metadata) {
          const meta = result.metadata;

          // Compare title
          if (ref.title && meta.title) {
            const refTitle = ref.title.toLowerCase().trim();
            const metaTitle = meta.title.toLowerCase().trim();
            if (refTitle !== metaTitle && !refTitle.includes(metaTitle) && !metaTitle.includes(refTitle)) {
              discrepancies.push({
                field: 'title',
                referenceValue: ref.title,
                crossrefValue: meta.title
              });
            }
          }

          // Compare year
          if (ref.year && meta.year) {
            if (ref.year !== meta.year) {
              discrepancies.push({
                field: 'year',
                referenceValue: ref.year,
                crossrefValue: meta.year
              });
            }
          }

          // Compare journal
          if (ref.journalName && meta.journal) {
            const refJournal = ref.journalName.toLowerCase().trim();
            const metaJournal = meta.journal.toLowerCase().trim();
            if (refJournal !== metaJournal && !refJournal.includes(metaJournal) && !metaJournal.includes(refJournal)) {
              discrepancies.push({
                field: 'journal',
                referenceValue: ref.journalName,
                crossrefValue: meta.journal
              });
            }
          }

          // Compare volume
          if (ref.volume && meta.volume) {
            if (ref.volume !== meta.volume) {
              discrepancies.push({
                field: 'volume',
                referenceValue: ref.volume,
                crossrefValue: meta.volume
              });
            }
          }

          // Compare pages
          if (ref.pages && meta.pages) {
            const refPages = ref.pages.replace(/[–—]/g, '-').trim();
            const metaPages = meta.pages.replace(/[–—]/g, '-').trim();
            if (refPages !== metaPages) {
              discrepancies.push({
                field: 'pages',
                referenceValue: ref.pages,
                crossrefValue: meta.pages
              });
            }
          }
        }

        return {
          referenceId: ref.id,
          referenceNumber: refNumber,
          doi: ref.doi!,
          valid: result.hasValidDOI,
          metadata: result.metadata as Record<string, unknown> | undefined,
          discrepancies: discrepancies.length > 0 ? discrepancies : undefined,
          error: result.suggestions?.[0]
        };
      });

      const validCount = validationResults.filter(r => r.valid).length;
      const withDiscrepancies = validationResults.filter(r => r.discrepancies && r.discrepancies.length > 0).length;

      res.json({
        success: true,
        data: {
          message: `Validated ${validationResults.length} DOIs`,
          validated: validationResults.length,
          valid: validCount,
          invalid: validationResults.length - validCount,
          withDiscrepancies,
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
