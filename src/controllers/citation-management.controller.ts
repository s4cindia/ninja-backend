/**
 * Citation Management Controller
 * Comprehensive citation tool with AI-powered detection, reordering, format conversion
 */

import { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import { logger } from '../lib/logger';
import { aiCitationDetectorService } from '../services/citation/ai-citation-detector.service';
import { referenceReorderingService } from '../services/citation/reference-reordering.service';
import { aiFormatConverterService, CitationStyle } from '../services/citation/ai-format-converter.service';
import { doiValidationService } from '../services/citation/doi-validation.service';
import { docxProcessorService, ReferenceEntry } from '../services/citation/docx-processor.service';

export class CitationManagementController {
  /**
   * POST /api/v1/citation/upload
   * Upload and analyze DOCX document
   */
  async upload(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { tenantId, id: userId } = req.user!;
      const file = req.file;

      if (!file) {
        res.status(400).json({
          success: false,
          error: { code: 'NO_FILE', message: 'No file uploaded' }
        });
        return;
      }

      logger.info(`[Citation Management] Upload: ${file.originalname}`);

      // Validate DOCX
      const validation = await docxProcessorService.validateDOCX(file.buffer);
      if (!validation.valid) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_DOCX', message: validation.error }
        });
        return;
      }

      // Extract text
      const content = await docxProcessorService.extractText(file.buffer);
      const stats = await docxProcessorService.getStatistics(file.buffer);

      // Create Job first (required for foreign key constraint)
      const job = await prisma.job.create({
        data: {
          tenantId,
          userId,
          type: 'CITATION_DETECTION',
          status: 'PROCESSING',
          input: {
            filename: file.originalname,
            fileSize: file.size,
            mimeType: file.mimetype
          },
          output: {},
          priority: 1
        }
      });

      // Save original DOCX file to disk (we need it for export)
      const fs = await import('fs/promises');
      const path = await import('path');
      const uploadDir = path.join(process.cwd(), 'uploads', 'citation-management', tenantId);
      await fs.mkdir(uploadDir, { recursive: true });

      // Sanitize filename to prevent path traversal attacks
      const sanitizedOriginalName = file.originalname
        .replace(/\0/g, '') // Remove null bytes
        .replace(/[/\\]/g, '_') // Replace path separators
        .replace(/\.\./g, '_') // Remove parent directory references
        .slice(0, 200); // Limit length
      const filename = `${Date.now()}-${sanitizedOriginalName}`;
      const storagePath = path.join(uploadDir, filename);
      await fs.writeFile(storagePath, file.buffer);

      logger.info(`[Citation Management] Saved original DOCX to ${storagePath}`);

      // Create document record with job reference
      const document = await prisma.editorialDocument.create({
        data: {
          tenantId,
          jobId: job.id,
          originalName: file.originalname,
          fileName: filename,
          mimeType: file.mimetype,
          fileSize: file.size,
          storagePath: `citation-management/${tenantId}/${filename}`,
          storageType: 'LOCAL',
          fullText: content.text,
          fullHtml: content.html,
          wordCount: stats.wordCount,
          pageCount: stats.pageCount,
          status: 'ANALYZING'
        }
      });

      // Run AI analysis and WAIT for it to complete
      logger.info(`[Citation Management] Starting analysis for ${document.id}`);
      await this.analyzeDocument(document.id, content.text);
      logger.info(`[Citation Management] Analysis completed for ${document.id}`);

      // Get final counts after analysis
      const finalDoc = await prisma.editorialDocument.findUnique({
        where: { id: document.id },
        include: { citations: true }
      });

      const finalRefs = await prisma.referenceListEntry.count({
        where: { documentId: document.id }
      });

      res.json({
        success: true,
        data: {
          documentId: document.id,
          status: 'COMPLETED',
          filename: file.originalname,
          statistics: {
            ...stats,
            citationsFound: finalDoc?.citations?.length || 0,
            referencesFound: finalRefs
          }
        }
      });
    } catch (error) {
      logger.error('[Citation Management] Upload failed:', error);
      next(error);
    }
  }

  /**
   * POST /api/v1/citation-management/document/:documentId/reanalyze
   * Re-analyze document with auto-resequencing (for testing/fixing existing documents)
   */
  async reanalyze(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;

      const document = await prisma.editorialDocument.findUnique({
        where: { id: documentId },
        select: { id: true, fullText: true, originalName: true }
      });

      if (!document) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' }
        });
        return;
      }

      if (!document.fullText) {
        res.status(400).json({
          success: false,
          error: { code: 'NO_TEXT', message: 'Document has no text content' }
        });
        return;
      }

      logger.info(`[Citation Management] Re-analyzing document ${documentId}`);

      // Delete existing citations, references, AND change records
      await prisma.citation.deleteMany({ where: { documentId } });
      await prisma.referenceListEntry.deleteMany({ where: { documentId } });
      await prisma.citationChange.deleteMany({ where: { documentId } });

      logger.info(`[Citation Management] Cleared existing citations, references, and change records`);

      // Re-run analysis with auto-resequencing
      await this.analyzeDocument(documentId, document.fullText);

      // Get updated counts
      const citations = await prisma.citation.count({ where: { documentId } });
      const references = await prisma.referenceListEntry.count({ where: { documentId } });

      logger.info(`[Citation Management] Re-analysis complete: ${citations} citations, ${references} references`);

      res.json({
        success: true,
        data: {
          documentId,
          message: 'Document re-analyzed with auto-resequencing',
          citationsFound: citations,
          referencesFound: references
        }
      });
    } catch (error) {
      logger.error('[Citation Management] Re-analyze failed:', error);
      next(error);
    }
  }

  /**
   * GET /api/v1/citation/document/:documentId/analysis
   * Get complete citation analysis
   */
  async getAnalysis(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const { tenantId } = req.user!;

      const document = await prisma.editorialDocument.findFirst({
        where: { id: documentId, tenantId },
        include: {
          citations: {
            include: {
              reference: true
            }
          },
          job: true
        }
      });

      if (!document) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' }
        });
        return;
      }

      // Get reference list entries for this document
      const references = await prisma.referenceListEntry.findMany({
        where: { documentId },
        orderBy: { sortKey: 'asc' }
      });

      // Get stored REFERENCE_STYLE_CONVERSION changes to display converted reference text
      // The citationId field stores the reference ID for these changes
      const refStyleConversions = await prisma.citationChange.findMany({
        where: {
          documentId,
          changeType: 'REFERENCE_STYLE_CONVERSION',
          isReverted: false
        }
      });

      // Build a map of reference ID to converted text
      const refIdToConvertedText = new Map<string, string>();
      for (const change of refStyleConversions) {
        if (change.citationId && change.afterText) {
          refIdToConvertedText.set(change.citationId, change.afterText);
        }
      }
      logger.info(`[Citation Management] Found ${refIdToConvertedText.size} reference style conversions for display`);

      // Create a map of citation ID to reference number for quick lookup
      const citationToRefMap = new Map<string, number>();
      references.forEach((ref, index) => {
        // Parse the reference number from sortKey (e.g., "0001" -> 1)
        const refNumber = parseInt(ref.sortKey) || (index + 1);
        ref.citationIds.forEach(citationId => {
          citationToRefMap.set(citationId, refNumber);
        });
      });

      // Debug: Check citations data
      logger.info(`[Citation Management] getAnalysis - Document ${documentId}:`);
      logger.info(`[Citation Management] Total citations: ${document.citations?.length || 0}`);

      const citationsWithText = document.citations?.filter(c => c.rawText && c.rawText.trim() !== '') || [];
      logger.info(`[Citation Management] Citations with rawText: ${citationsWithText.length}`);

      if (citationsWithText.length < (document.citations?.length || 0)) {
        logger.warn(`[Citation Management] Some citations missing rawText! (${citationsWithText.length}/${document.citations?.length})`);
      }

      // Log sample citation
      if (document.citations && document.citations.length > 0) {
        logger.info(`[Citation Management] Sample citation:`, {
          id: document.citations[0].id,
          rawText: document.citations[0].rawText,
          startOffset: document.citations[0].startOffset,
          endOffset: document.citations[0].endOffset
        });
      }

      res.json({
        success: true,
        data: {
          document: {
            id: document.id,
            filename: document.originalName,
            status: document.status,
            wordCount: document.wordCount,
            pageCount: document.pageCount,
            fullText: document.fullText, // Include document text
            fullHtml: document.fullHtml, // Include HTML version
            statistics: {
              totalCitations: document.citations?.length || 0,
              totalReferences: references.length
            }
          },
          citations: (document.citations || []).map(c => {
            const referenceNumber = citationToRefMap.get(c.id) || null;
            // For author-year styles (APA, MLA, Chicago), citations don't have numeric referenceNumber
            // They're linked by author/year, so don't mark them as orphaned just because referenceNumber is null
            const isAuthorYearStyleByField = document.referenceListStyle &&
              ['apa', 'mla', 'chicago', 'harvard'].some(style =>
                document.referenceListStyle!.toLowerCase().includes(style));

            // Also detect author-year by citation content (fallback if referenceListStyle not set)
            // Author-year citations contain patterns like "Author, YYYY" or "Author et al., YYYY"
            const looksLikeAuthorYear = c.rawText && /[A-Z][a-z]+.*\d{4}/.test(c.rawText) &&
              !/^\s*[\(\[]\d+[\)\]]/.test(c.rawText); // Not a numeric citation like (1) or [1]

            const isAuthorYearStyle = isAuthorYearStyleByField || looksLikeAuthorYear;
            const isOrphaned = isAuthorYearStyle ? false : !referenceNumber;

            return {
              ...c,
              referenceNumber,
              isOrphaned // Only mark as orphaned for numeric citation styles
            };
          }),
          references: references.map((r, index) => {
            const refNumber = parseInt(r.sortKey) || (index + 1);
            // Use converted text if available (from style conversion), otherwise fall back to formattedApa or construct from fields
            const convertedText = refIdToConvertedText.get(r.id);
            const displayText = convertedText || r.formattedApa || `${(r.authors as string[])?.join(', ') || 'Unknown'} (${r.year || 'n.d.'}). ${r.title || 'Untitled'}`;
            return {
              id: r.id,
              position: refNumber,
              number: refNumber,
              rawText: displayText,
              authors: r.authors,
              year: r.year,
              title: r.title,
              journal: r.journalName,
              volume: r.volume,
              issue: r.issue,
              pages: r.pages,
              doi: r.doi,
              url: r.url,
              publisher: r.publisher,
              citationCount: r.citationIds.length // How many times this reference is cited
            };
          }),
          detectedStyle: document.referenceListStyle || 'APA'
        }
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/v1/citation/document/:documentId/reorder
   * Reorder references and update in-text citations
   */
  async reorderReferences(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const { referenceId, newPosition, sortBy } = req.body;
      const { tenantId } = req.user!;

      logger.info(`[Citation Management] Reordering references for ${documentId}`);

      // Get current references and citations with tenant verification
      const document = await prisma.editorialDocument.findFirst({
        where: { id: documentId, tenantId },
        include: {
          citations: true,
          referenceListEntries: {
            orderBy: { sortKey: 'asc' }
          }
        }
      });

      if (!document) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' }
        });
        return;
      }

      // Convert to service format
      const references = document.referenceListEntries.map((r, index) => ({
        id: r.id,
        number: index + 1, // Use index as position
        rawText: r.formattedApa || `${JSON.stringify(r.authors)} (${r.year}). ${r.title}`,
        components: {
          authors: r.authors as string[],
          year: r.year || undefined,
          title: r.title || undefined,
          journal: r.journalName || undefined,
          volume: r.volume || undefined,
          issue: r.issue || undefined,
          pages: r.pages || undefined,
          doi: r.doi || undefined
        },
        citedBy: []
      }));

      const citations = document.citations.map(c => ({
        id: c.id,
        text: c.rawText,
        position: {
          paragraph: c.paragraphIndex || 0,
          sentence: 0,
          startChar: c.startOffset,
          endChar: c.endOffset
        },
        type: 'numeric' as const,
        format: 'bracket' as const,
        numbers: [], // Citation numbers managed by reference list
        context: c.rawText // No separate context fields in schema
      }));

      // Perform reordering
      let result;
      if (sortBy === 'alphabetical') {
        result = await referenceReorderingService.sortAlphabetically(references, citations);
      } else if (sortBy === 'year') {
        result = await referenceReorderingService.sortByYear(references, citations);
      } else if (sortBy === 'appearance') {
        result = await referenceReorderingService.sortByAppearance(references, citations);
      } else if (referenceId && newPosition) {
        result = await referenceReorderingService.reorderReference(
          references,
          citations,
          referenceId,
          newPosition
        );
      } else {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_REQUEST', message: 'Invalid reordering parameters' }
        });
        return;
      }

      // Build old-to-new number mapping from changes
      const oldToNewNumber = new Map<number, number>();
      for (const change of result.changes) {
        oldToNewNumber.set(change.oldNumber, change.newNumber);
      }
      // Also include unchanged references (old = new)
      for (let i = 0; i < references.length; i++) {
        const oldNum = i + 1;
        if (!oldToNewNumber.has(oldNum)) {
          const ref = result.updatedReferences.find(r => r.id === references[i].id);
          if (ref) {
            oldToNewNumber.set(oldNum, ref.number!);
          }
        }
      }

      logger.debug(`[Citation Management] Reorder mapping: ${[...oldToNewNumber.entries()].map(([o, n]) => `${o}→${n}`).join(', ')}`);

      // Update database - use transaction for better performance
      await prisma.$transaction(
        result.updatedReferences.map(ref =>
          prisma.referenceListEntry.update({
            where: { id: ref.id },
            data: { sortKey: String(ref.number).padStart(4, '0') }
          })
        )
      );

      // Update citation rawText with new numbers
      const citationUpdates: { id: string; newRawText: string; oldRawText: string }[] = [];

      for (const citation of document.citations) {
        // Handle both 'NUMERIC' and 'FOOTNOTE'/'ENDNOTE' (Chicago superscript) citation types
        // Note: Database stores citationType in UPPERCASE
        if (citation.citationType !== 'NUMERIC' && citation.citationType !== 'FOOTNOTE' && citation.citationType !== 'ENDNOTE') continue;

        const newRawText = this.updateCitationNumbers(citation.rawText, oldToNewNumber);
        if (newRawText !== citation.rawText) {
          citationUpdates.push({
            id: citation.id,
            oldRawText: citation.rawText,
            newRawText
          });
        }
      }

      // Apply citation updates
      if (citationUpdates.length > 0) {
        await prisma.$transaction(
          citationUpdates.map(update =>
            prisma.citation.update({
              where: { id: update.id },
              data: { rawText: update.newRawText }
            })
          )
        );

        logger.info(`[Citation Management] Updated ${citationUpdates.length} citations after reordering`);

        // Store RENUMBER changes for export tracking
        // Group by unique text changes to avoid duplicates
        const uniqueTextChanges = new Map<string, string>();
        for (const update of citationUpdates) {
          if (!uniqueTextChanges.has(update.oldRawText)) {
            uniqueTextChanges.set(update.oldRawText, update.newRawText);
          }
        }

        // Delete any existing RENUMBER changes for this document (fresh start on each reorder)
        await prisma.citationChange.deleteMany({
          where: {
            documentId,
            changeType: 'RENUMBER',
            isReverted: false
          }
        });

        // Create RENUMBER change records
        const renumberChanges = [...uniqueTextChanges.entries()].map(([oldText, newText]) => ({
          documentId,
          citationId: null,
          changeType: 'RENUMBER' as const,
          beforeText: oldText,
          afterText: newText,
          appliedBy: 'system',
          isReverted: false
        }));

        if (renumberChanges.length > 0) {
          await prisma.citationChange.createMany({
            data: renumberChanges
          });
          logger.info(`[Citation Management] Stored ${renumberChanges.length} RENUMBER changes: ${renumberChanges.map(c => `"${c.beforeText}"→"${c.afterText}"`).join(', ')}`);
        }
      }

      // Fetch updated data with all fields
      const updatedDocument = await prisma.editorialDocument.findUnique({
        where: { id: documentId },
        include: {
          citations: true,
          referenceListEntries: {
            orderBy: { sortKey: 'asc' }
          }
        }
      });

      // Fetch REFERENCE_STYLE_CONVERSION changes to use converted text
      const refStyleConversions = await prisma.citationChange.findMany({
        where: {
          documentId,
          changeType: 'REFERENCE_STYLE_CONVERSION',
          isReverted: false
        }
      });
      const refIdToConvertedText = new Map<string, string>();
      for (const change of refStyleConversions) {
        if (change.citationId && change.afterText) {
          refIdToConvertedText.set(change.citationId, change.afterText);
        }
      }

      // Build citation-to-reference mapping
      const citationToRefMap = new Map<string, number>();
      updatedDocument!.referenceListEntries.forEach((ref, index) => {
        const refNumber = parseInt(ref.sortKey) || (index + 1);
        ref.citationIds.forEach(citationId => {
          citationToRefMap.set(citationId, refNumber);
        });
      });

      res.json({
        success: true,
        data: {
          message: 'References reordered successfully',
          changes: result.changes,
          updatedCount: result.changes.length,
          citationsUpdated: citationUpdates.length,
          citationChanges: citationUpdates.map(u => ({
            citationId: u.id,
            before: u.oldRawText,
            after: u.newRawText
          })),
          references: updatedDocument!.referenceListEntries.map((r, index) => {
            const refNumber = parseInt(r.sortKey) || (index + 1);
            const convertedText = refIdToConvertedText.get(r.id);
            return {
              id: r.id,
              position: refNumber,
              number: refNumber,
              rawText: convertedText || r.formattedApa || `${(r.authors as string[])?.join(', ') || 'Unknown'} (${r.year || 'n.d.'}). ${r.title || 'Untitled'}`,
              authors: r.authors as string[],
              year: r.year || undefined,
              title: r.title || undefined,
              journal: r.journalName || undefined,
              volume: r.volume || undefined,
              issue: r.issue || undefined,
              pages: r.pages || undefined,
              doi: r.doi || undefined,
              url: r.url || undefined,
              publisher: r.publisher || undefined,
              citationCount: r.citationIds.length
            };
          }),
          citations: updatedDocument!.citations.map(c => ({
            id: c.id,
            rawText: c.rawText,
            citationType: c.citationType,
            paragraphIndex: c.paragraphIndex,
            startOffset: c.startOffset,
            endOffset: c.endOffset,
            referenceNumber: citationToRefMap.get(c.id) || null
          }))
        }
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /api/v1/citation/document/:documentId/reference/:referenceId
   * Delete a reference and renumber remaining references and citations
   */
  async deleteReference(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId, referenceId } = req.params;
      const { tenantId } = req.user!;

      logger.info(`[Citation Management] Deleting reference ${referenceId} from document ${documentId}`);

      // Get the reference to delete with all references and verify tenant ownership
      const referenceToDelete = await prisma.referenceListEntry.findUnique({
        where: { id: referenceId },
        include: { document: { include: {
          referenceListEntries: { orderBy: { sortKey: 'asc' } },
          citations: true
        } } }
      });

      if (!referenceToDelete) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Reference not found' }
        });
        return;
      }

      // Verify tenant ownership
      if (referenceToDelete.document.tenantId !== tenantId) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Reference not found' }
        });
        return;
      }

      const allReferences = referenceToDelete.document.referenceListEntries;
      const deletedPosition = parseInt(referenceToDelete.sortKey) || 0;
      const affectedCitationIds = referenceToDelete.citationIds;

      logger.info(`[Citation Management] Deleting reference at position ${deletedPosition}, affects ${affectedCitationIds.length} citations`);

      // Create old-to-new number mapping (deleted number maps to null, higher numbers shift down)
      // IMPORTANT: Use actual sortKey values, not array indices, in case there are gaps
      const oldToNewNumber = new Map<number, number | null>();
      let newPosition = 0;

      for (let i = 0; i < allReferences.length; i++) {
        // Use actual sortKey position, not array index, to handle gaps correctly
        const oldPosition = parseInt(allReferences[i].sortKey) || (i + 1);
        if (allReferences[i].id === referenceId) {
          oldToNewNumber.set(oldPosition, null); // Deleted reference
          logger.info(`[Citation Management] Marking reference at position ${oldPosition} (sortKey ${allReferences[i].sortKey}) as DELETED`);
        } else {
          newPosition++;
          oldToNewNumber.set(oldPosition, newPosition);
        }
      }

      logger.info(`[Citation Management] Number mapping after deletion: ${[...oldToNewNumber.entries()].map(([o, n]) => `${o}→${n ?? 'deleted'}`).join(', ')}`);
      logger.info(`[Citation Management] Total references before deletion: ${allReferences.length}, will have ${newPosition} after deletion`);

      // DEBUG: Log all sortKey values to verify ordering
      logger.info(`[Citation Management] Reference sortKeys: ${allReferences.map((r, i) => `[${i}]=${r.sortKey}`).join(', ')}`);

      // Delete the reference
      await prisma.referenceListEntry.delete({
        where: { id: referenceId }
      });

      // Get remaining references
      const remainingReferences = await prisma.referenceListEntry.findMany({
        where: { documentId },
        orderBy: { sortKey: 'asc' }
      });

      // Renumber remaining references (close the gap)
      await prisma.$transaction(
        remainingReferences.map((ref, index) => {
          const newPos = index + 1;
          return prisma.referenceListEntry.update({
            where: { id: ref.id },
            data: { sortKey: String(newPos).padStart(4, '0') }
          });
        })
      );

      // Update citation rawText with new numbers (remove deleted, renumber remaining)
      const citationUpdates: { id: string; newRawText: string; oldRawText: string }[] = [];
      const allCitations = referenceToDelete.document.citations;

      // DEBUG: Log all citation types
      logger.debug(`[Citation Management] Total citations: ${allCitations.length}`);
      allCitations.forEach((c, i) => {
        logger.debug(`[Citation Management] Citation[${i}]: type="${c.citationType}", rawText="${c.rawText}"`);
      });

      for (const citation of allCitations) {
        // Handle numeric citations: NUMERIC, FOOTNOTE/ENDNOTE (Chicago superscript),
        // and PARENTHETICAL citations that contain numeric patterns like [1,2], [3-5]
        // Note: Database stores citationType in UPPERCASE
        const isNumericType = citation.citationType === 'NUMERIC' ||
                             citation.citationType === 'FOOTNOTE' ||
                             citation.citationType === 'ENDNOTE';

        // Check if PARENTHETICAL citation contains numeric patterns (Vancouver style)
        // Pattern: brackets or parentheses with numbers, commas, and dashes
        const hasNumericPattern = /[\[(]\d+(?:\s*[-–—,]\s*\d+)*[\])]/.test(citation.rawText);

        if (!isNumericType && !hasNumericPattern) continue;

        logger.debug(`[Citation Management] Processing citation: type="${citation.citationType}", rawText="${citation.rawText}", isNumericType=${isNumericType}, hasNumericPattern=${hasNumericPattern}`);
        const newRawText = this.updateCitationNumbersWithDeletion(citation.rawText, oldToNewNumber);
        logger.debug(`[Citation Management] After update: "${citation.rawText}" -> "${newRawText}"`);
        if (newRawText !== citation.rawText) {
          citationUpdates.push({
            id: citation.id,
            oldRawText: citation.rawText,
            newRawText
          });
        }
      }

      // Apply citation updates
      if (citationUpdates.length > 0) {
        await prisma.$transaction(
          citationUpdates.map(update =>
            prisma.citation.update({
              where: { id: update.id },
              data: { rawText: update.newRawText }
            })
          )
        );

        logger.info(`[Citation Management] Updated ${citationUpdates.length} citations after deletion`);

        // IMPORTANT: Also store CitationChange records for numeric/footnote citations
        // This is needed for export to show track changes in the DOCX
        for (const update of citationUpdates) {
          await prisma.citationChange.create({
            data: {
              documentId,
              citationId: update.id,
              changeType: 'RENUMBER',
              beforeText: update.oldRawText,
              afterText: update.newRawText,
              appliedBy: 'system',
              appliedAt: new Date()
            }
          });
          logger.info(`[Citation Management] Stored renumber change: "${update.oldRawText}" -> "${update.newRawText}"`);
        }
      }

      // Store deletion record for the orphaned citations (citations that pointed to deleted reference)
      // For numeric/footnote documents, the citation text itself may become orphaned
      // Note: Database stores citationType in UPPERCASE
      const orphanedNumericCitations = allCitations.filter(
        c => affectedCitationIds.includes(c.id) && (c.citationType === 'NUMERIC' || c.citationType === 'FOOTNOTE' || c.citationType === 'ENDNOTE')
      );

      if (orphanedNumericCitations.length > 0) {
        logger.info(`[Citation Management] Found ${orphanedNumericCitations.length} orphaned numeric/footnote citations`);
        for (const citation of orphanedNumericCitations) {
          // Check if citation was completely orphaned (all its numbers were deleted)
          const wasOrphaned = !citationUpdates.some(u => u.id === citation.id);
          if (wasOrphaned) {
            await prisma.citationChange.create({
              data: {
                documentId,
                citationId: citation.id,
                changeType: 'REFERENCE_DELETE',
                beforeText: citation.rawText,
                afterText: '',
                appliedBy: 'system',
                appliedAt: new Date()
              }
            });
            logger.info(`[Citation Management] Stored orphan record for numeric citation: "${citation.rawText}"`);
          }
        }
      }

      // For author-year citations linked to the deleted reference, store deletion records
      // These will be applied during export to mark the citations as deleted (strikethrough)
      // Note: 'FOOTNOTE'/'ENDNOTE' type is numeric (Chicago superscript), not author-year
      // Database stores citationType in UPPERCASE
      const authorYearCitationsToDelete = allCitations.filter(
        c => affectedCitationIds.includes(c.id) && c.citationType !== 'NUMERIC' && c.citationType !== 'FOOTNOTE' && c.citationType !== 'ENDNOTE'
      );

      if (authorYearCitationsToDelete.length > 0) {
        logger.info(`[Citation Management] Storing ${authorYearCitationsToDelete.length} author-year citation deletions`);

        for (const citation of authorYearCitationsToDelete) {
          // Check if there's already a deletion record for this citation
          const existingDeletion = await prisma.citationChange.findFirst({
            where: {
              documentId,
              citationId: citation.id,
              changeType: 'REFERENCE_DELETE',
              isReverted: false
            }
          });

          if (!existingDeletion) {
            await prisma.citationChange.create({
              data: {
                documentId,
                citationId: citation.id,
                changeType: 'REFERENCE_DELETE',
                beforeText: citation.rawText,
                afterText: '', // Empty - citation should be removed/struck through
                appliedBy: 'system',
                appliedAt: new Date()
              }
            });
            logger.info(`[Citation Management] Stored deletion for author-year citation: "${citation.rawText}"`);
          }
        }
      }

      // ============================================
      // UPDATE fullText and fullHtml with new citation numbers
      // This is CRITICAL for the preview to show correct citations
      // ============================================
      const currentDoc = await prisma.editorialDocument.findUnique({
        where: { id: documentId },
        select: { fullText: true, fullHtml: true }
      });

      logger.info(`[Citation Management] Post-deletion update check: citationUpdates=${citationUpdates.length}, affectedCitationIds=${affectedCitationIds.length}`);

      // If no renumbering but there are affected citations, they're orphaned
      if (citationUpdates.length === 0 && affectedCitationIds.length > 0) {
        logger.info(`[Citation Management] Reference deletion created ${affectedCitationIds.length} orphaned citation(s) - no renumbering needed (last reference deleted)`);
      }

      if (currentDoc && citationUpdates.length > 0) {
        let updatedFullText = currentDoc.fullText || '';
        let updatedFullHtml = currentDoc.fullHtml || '';

        // Apply citation changes to fullText and fullHtml
        // Sort by oldRawText length descending to avoid partial matches
        const sortedUpdates = [...citationUpdates].sort(
          (a, b) => b.oldRawText.length - a.oldRawText.length
        );

        for (const update of sortedUpdates) {
          // Replace old citation text with new in fullText
          if (updatedFullText.includes(update.oldRawText)) {
            updatedFullText = updatedFullText.split(update.oldRawText).join(update.newRawText);
            logger.info(`[Citation Management] Updated fullText: "${update.oldRawText}" → "${update.newRawText}"`);
          }

          // Replace old citation text with new in fullHtml
          // Handle HTML entities like &amp;
          const htmlVariants = [
            update.oldRawText,
            update.oldRawText.replace(/&/g, '&amp;'),
            update.oldRawText.replace(/–/g, '&#8211;'),
            update.oldRawText.replace(/–/g, '&ndash;')
          ];

          for (const variant of htmlVariants) {
            if (updatedFullHtml.includes(variant)) {
              updatedFullHtml = updatedFullHtml.split(variant).join(update.newRawText);
              logger.info(`[Citation Management] Updated fullHtml: "${variant}" → "${update.newRawText}"`);
              break;
            }
          }
        }

        // Save updated text
        await prisma.editorialDocument.update({
          where: { id: documentId },
          data: {
            fullText: updatedFullText,
            fullHtml: updatedFullHtml
          }
        });

        logger.info(`[Citation Management] Updated fullText and fullHtml with ${citationUpdates.length} citation changes`);
      }

      // Fetch updated data
      const updatedDocument = await prisma.editorialDocument.findUnique({
        where: { id: documentId },
        include: {
          citations: true,
          referenceListEntries: { orderBy: { sortKey: 'asc' } }
        }
      });

      // Fetch REFERENCE_STYLE_CONVERSION changes to use converted text
      const refStyleConversions = await prisma.citationChange.findMany({
        where: {
          documentId,
          changeType: 'REFERENCE_STYLE_CONVERSION',
          isReverted: false
        }
      });
      const refIdToConvertedText = new Map<string, string>();
      for (const change of refStyleConversions) {
        if (change.citationId && change.afterText) {
          refIdToConvertedText.set(change.citationId, change.afterText);
        }
      }

      // Build citation-to-reference mapping
      const citationToRefMap = new Map<string, number>();
      updatedDocument!.referenceListEntries.forEach((ref, index) => {
        const refNumber = parseInt(ref.sortKey) || (index + 1);
        ref.citationIds.forEach(citationId => {
          citationToRefMap.set(citationId, refNumber);
        });
      });

      res.json({
        success: true,
        data: {
          message: 'Reference deleted successfully',
          deletedReferenceId: referenceId,
          affectedCitationIds,
          citationsUpdated: citationUpdates.length,
          changes: citationUpdates.map(u => ({
            citationId: u.id,
            before: u.oldRawText,
            after: u.newRawText
          })),
          references: updatedDocument!.referenceListEntries.map((r, index) => {
            const refNumber = parseInt(r.sortKey) || (index + 1);
            const convertedText = refIdToConvertedText.get(r.id);
            return {
              id: r.id,
              position: refNumber,
              number: refNumber,
              rawText: convertedText || r.formattedApa || `${(r.authors as string[])?.join(', ') || 'Unknown'} (${r.year || 'n.d.'}). ${r.title || 'Untitled'}`,
              authors: r.authors as string[],
              year: r.year || undefined,
              title: r.title || undefined,
              journal: r.journalName || undefined,
              volume: r.volume || undefined,
              issue: r.issue || undefined,
              pages: r.pages || undefined,
              doi: r.doi || undefined,
              url: r.url || undefined,
              publisher: r.publisher || undefined,
              citationCount: r.citationIds.length
            };
          }),
          citations: updatedDocument!.citations.map(c => {
            const refNum = citationToRefMap.get(c.id) || null;
            const isOrphan = affectedCitationIds.includes(c.id) && !citationToRefMap.has(c.id);
            if (isOrphan) {
              logger.info(`[Citation Management] Citation "${c.rawText}" is ORPHANED (was linked to deleted reference)`);
            }
            return {
              id: c.id,
              rawText: c.rawText,
              citationType: c.citationType,
              paragraphIndex: c.paragraphIndex,
              startOffset: c.startOffset,
              endOffset: c.endOffset,
              referenceNumber: refNum,
              isOrphaned: isOrphan
            };
          })
        }
      });
    } catch (error) {
      logger.error('[Citation Management] Delete reference failed:', error);
      next(error);
    }
  }

  /**
   * PATCH /api/v1/citation-management/document/:documentId/reference/:referenceId
   * Edit a reference (author, year, title, etc.)
   * For author-year citations: Updates inline citations when author/year changes
   */
  async editReference(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId, referenceId } = req.params;
      const updates = req.body;
      const { tenantId } = req.user!;

      logger.info(`[Citation Management] Editing reference ${referenceId} in document ${documentId}`);
      logger.info(`[Citation Management] Updates: ${JSON.stringify(updates)}`);

      // Get the reference with its linked citations
      const reference = await prisma.referenceListEntry.findUnique({
        where: { id: referenceId },
        include: {
          document: {
            include: {
              citations: true
            }
          }
        }
      });

      if (!reference) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Reference not found' }
        });
        return;
      }

      // Verify tenant ownership
      if (reference.document.tenantId !== tenantId) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Reference not found' }
        });
        return;
      }

      if (reference.documentId !== documentId) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_DOCUMENT', message: 'Reference does not belong to this document' }
        });
        return;
      }

      const document = reference.document;
      const oldAuthors = reference.authors || [];
      const oldYear = reference.year;
      const newAuthors = updates.authors || oldAuthors;
      const newYear = updates.year || oldYear;

      // Check if this is an author-year style document
      const isAuthorYearStyle = document.referenceListStyle &&
        ['apa', 'mla', 'chicago', 'harvard'].some(style =>
          document.referenceListStyle!.toLowerCase().includes(style));

      // Track if author or year changed (for inline citation updates)
      const authorChanged = JSON.stringify(oldAuthors) !== JSON.stringify(newAuthors);
      const yearChanged = oldYear !== newYear;
      const needsCitationUpdate = isAuthorYearStyle && (authorChanged || yearChanged);

      logger.info(`[Citation Management] Author changed: ${authorChanged}, Year changed: ${yearChanged}, Needs citation update: ${needsCitationUpdate}`);

      // Update the reference in database
      const updatedReference = await prisma.referenceListEntry.update({
        where: { id: referenceId },
        data: {
          authors: newAuthors,
          year: newYear,
          title: updates.title ?? reference.title,
          journalName: updates.journalName ?? reference.journalName,
          volume: updates.volume ?? reference.volume,
          issue: updates.issue ?? reference.issue,
          pages: updates.pages ?? reference.pages,
          doi: updates.doi ?? reference.doi,
          url: updates.url ?? reference.url,
          publisher: updates.publisher ?? reference.publisher,
          isEdited: true,
          editedAt: new Date()
        }
      });

      // For author-year documents, update inline citations if author/year changed
      const citationUpdates: Array<{ citationId: string; oldText: string; newText: string }> = [];

      if (needsCitationUpdate && reference.citationIds.length > 0) {
        // Get old and new author names for citation text
        const oldFirstAuthor = this.extractLastName(oldAuthors[0] || '');
        const newFirstAuthor = this.extractLastName(newAuthors[0] || '');

        logger.info(`[Citation Management] Updating citations: "${oldFirstAuthor}" -> "${newFirstAuthor}", "${oldYear}" -> "${newYear}"`);

        // Find and update linked citations
        for (const citationId of reference.citationIds) {
          const citation = document.citations.find(c => c.id === citationId);
          if (!citation || !citation.rawText) continue;

          let newRawText = citation.rawText;

          // Replace author name if changed
          if (authorChanged && oldFirstAuthor && newFirstAuthor) {
            // Handle various formats: "Author", "Author et al.", "Author & Author2"
            const authorPattern = new RegExp(`\\b${this.escapeRegex(oldFirstAuthor)}\\b`, 'gi');
            newRawText = newRawText.replace(authorPattern, newFirstAuthor);
          }

          // Replace year if changed
          if (yearChanged && oldYear && newYear) {
            newRawText = newRawText.replace(new RegExp(`\\b${oldYear}\\b`, 'g'), newYear);
          }

          if (newRawText !== citation.rawText) {
            citationUpdates.push({
              citationId: citation.id,
              oldText: citation.rawText,
              newText: newRawText
            });

            // Update citation in database
            await prisma.citation.update({
              where: { id: citationId },
              data: { rawText: newRawText }
            });

            logger.info(`[Citation Management] Updated citation: "${citation.rawText}" -> "${newRawText}"`);
          }
        }

        // Store citation changes in CitationChange table for export
        // IMPORTANT: Handle chained edits - if there's an existing REFERENCE_EDIT for this citation,
        // we need to update it to chain: original -> new (not intermediate -> new)
        if (citationUpdates.length > 0) {
          for (const update of citationUpdates) {
            // Check if there's an existing REFERENCE_EDIT for this citation
            const existingChange = await prisma.citationChange.findFirst({
              where: {
                documentId,
                citationId: update.citationId,
                changeType: 'REFERENCE_EDIT',
                isReverted: false
              },
              orderBy: { appliedAt: 'desc' }
            });

            if (existingChange) {
              // Chain the edits: keep original beforeText, update afterText
              // Original: "(Smith, 2019)" -> "(Smith, 2020)"
              // New edit: "(Smith, 2020)" -> "(Smith, 2021)"
              // Result: "(Smith, 2019)" -> "(Smith, 2021)" (chains to original)
              await prisma.citationChange.update({
                where: { id: existingChange.id },
                data: {
                  afterText: update.newText,
                  appliedAt: new Date()
                }
              });
              logger.info(`[Citation Management] Chained CitationChange: "${existingChange.beforeText}" -> "${update.newText}" (was -> "${existingChange.afterText}")`);
            } else {
              // Create new CitationChange record
              await prisma.citationChange.create({
                data: {
                  documentId,
                  citationId: update.citationId,
                  changeType: 'REFERENCE_EDIT',
                  beforeText: update.oldText,
                  afterText: update.newText,
                  appliedBy: 'system',
                  appliedAt: new Date()
                }
              });
              logger.info(`[Citation Management] Stored CitationChange: "${update.oldText}" -> "${update.newText}"`);
            }
          }
        }

        // Update document fullText and fullHtml with new citation texts
        if (citationUpdates.length > 0) {
          let updatedFullText = document.fullText || '';
          let updatedFullHtml = document.fullHtml || '';

          for (const update of citationUpdates) {
            // Replace in fullText
            updatedFullText = updatedFullText.replace(update.oldText, update.newText);

            // Replace in fullHtml (handle HTML-encoded text)
            const oldHtmlEncoded = update.oldText.replace(/&/g, '&amp;');
            const newHtmlEncoded = update.newText.replace(/&/g, '&amp;');
            updatedFullHtml = updatedFullHtml.replace(oldHtmlEncoded, newHtmlEncoded);
            updatedFullHtml = updatedFullHtml.replace(update.oldText, update.newText);
          }

          await prisma.editorialDocument.update({
            where: { id: documentId },
            data: {
              fullText: updatedFullText,
              fullHtml: updatedFullHtml
            }
          });

          logger.info(`[Citation Management] Updated document text with ${citationUpdates.length} citation changes`);
        }
      }

      // Get updated document state
      const finalDocument = await prisma.editorialDocument.findUnique({
        where: { id: documentId },
        include: {
          citations: true,
          referenceListEntries: { orderBy: { sortKey: 'asc' } }
        }
      });

      // Build citation-to-reference mapping
      const citationToRefMap = new Map<string, number>();
      finalDocument!.referenceListEntries.forEach((ref, index) => {
        const refNumber = index + 1;
        ref.citationIds.forEach(citationId => {
          citationToRefMap.set(citationId, refNumber);
        });
      });

      res.json({
        success: true,
        data: {
          message: 'Reference updated successfully',
          referenceId,
          citationUpdates: citationUpdates.map(u => ({
            citationId: u.citationId,
            before: u.oldText,
            after: u.newText
          })),
          reference: {
            id: updatedReference.id,
            authors: updatedReference.authors,
            year: updatedReference.year,
            title: updatedReference.title,
            journalName: updatedReference.journalName,
            volume: updatedReference.volume,
            issue: updatedReference.issue,
            pages: updatedReference.pages,
            doi: updatedReference.doi,
            citationCount: updatedReference.citationIds.length
          },
          references: finalDocument!.referenceListEntries.map((r, index) => ({
            id: r.id,
            position: index + 1,
            number: index + 1,
            authors: r.authors,
            year: r.year,
            title: r.title,
            journalName: r.journalName,
            volume: r.volume,
            issue: r.issue,
            pages: r.pages,
            doi: r.doi,
            citationCount: r.citationIds.length
          })),
          citations: finalDocument!.citations.map(c => ({
            id: c.id,
            rawText: c.rawText,
            citationType: c.citationType,
            paragraphIndex: c.paragraphIndex,
            startOffset: c.startOffset,
            endOffset: c.endOffset,
            referenceNumber: citationToRefMap.get(c.id) || null
          })),
          document: {
            fullText: finalDocument!.fullText,
            fullHtml: finalDocument!.fullHtml
          }
        }
      });
    } catch (error) {
      logger.error('[Citation Management] Edit reference failed:', error);
      next(error);
    }
  }

  /**
   * Helper: Escape special regex characters
   */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Helper: Update citation numbers with deletion support
   * Handles deletion (null mapping) and renumbering
   */
  private updateCitationNumbersWithDeletion(rawText: string, oldToNewMap: Map<number, number | null>): string {
    // Handle bracket format: [1], [1,2], [1-3], [3–5] (en-dash), [3—5] (em-dash)
    // Support hyphen (-), en-dash (–), and em-dash (—) for ranges
    let updated = rawText.replace(/\[(\d+(?:\s*[-–—,]\s*\d+)*)\]/g, (match, nums) => {
      const newNums = this.remapNumbersWithDeletion(nums, oldToNewMap);
      if (newNums.length === 0) return '[orphaned]'; // All numbers deleted
      return `[${this.formatNumberList(newNums)}]`;
    });

    // Handle parenthesis format: (1), (1,2), (1-3), (3–5) (en-dash), (3—5) (em-dash)
    updated = updated.replace(/\((\d+(?:\s*[-–—,]\s*\d+)*)\)/g, (match, nums) => {
      const newNums = this.remapNumbersWithDeletion(nums, oldToNewMap);
      if (newNums.length === 0) return '(orphaned)'; // All numbers deleted
      return `(${this.formatNumberList(newNums)})`;
    });

    // Handle superscript format
    const superscriptMap: Record<string, string> = {
      '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4',
      '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9'
    };
    const reverseSuperscriptMap: Record<string, string> = {
      '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
      '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹'
    };

    updated = updated.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+/g, (match) => {
      const num = parseInt(match.split('').map(c => superscriptMap[c] || c).join(''));
      const newNum = oldToNewMap.get(num);
      if (newNum === null) return ''; // Deleted
      if (newNum === undefined) return match; // Not mapped
      return newNum.toString().split('').map(d => reverseSuperscriptMap[d] || d).join('');
    });

    return updated;
  }

  /**
   * Helper: Remap numbers with deletion support, returns array of new numbers
   */
  private remapNumbersWithDeletion(numStr: string, oldToNewMap: Map<number, number | null>): number[] {
    const result: number[] = [];

    // Handle ranges like "1-3", "3–5" (en-dash), "3—5" (em-dash)
    // Check for any dash character (hyphen, en-dash, or em-dash)
    const hasDash = /[-–—]/.test(numStr);

    if (hasDash && !numStr.includes(',')) {
      // Pure range like [3-5] or [3–5]
      const parts = numStr.split(/[-–—]/).map(n => parseInt(n.trim()));
      for (let i = parts[0]; i <= parts[1]; i++) {
        const newNum = oldToNewMap.get(i);
        if (newNum !== null && newNum !== undefined) {
          result.push(newNum);
        }
      }
      return result;
    }

    // Handle comma-separated like "1,2,3" or mixed like "1,3-5"
    const parts = numStr.split(',').map(p => p.trim());
    for (const part of parts) {
      if (/[-–—]/.test(part)) {
        // Range within comma-separated: expand 3-5 to 3,4,5
        const rangeParts = part.split(/[-–—]/).map(n => parseInt(n.trim()));
        for (let i = rangeParts[0]; i <= rangeParts[1]; i++) {
          const newNum = oldToNewMap.get(i);
          if (newNum !== null && newNum !== undefined) {
            result.push(newNum);
          }
        }
      } else {
        // Single number
        const num = parseInt(part);
        const newNum = oldToNewMap.get(num);
        if (newNum !== null && newNum !== undefined) {
          result.push(newNum);
        }
      }
    }

    return result;
  }

  /**
   * POST /api/v1/citation/document/:documentId/resequence
   * Resequence references by first appearance in text and update all in-text citations
   * This ensures citation numbers match the order they appear in the document
   */
  async resequenceByAppearance(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const { tenantId } = req.user!;

      logger.info(`[Citation Management] Resequencing references by appearance for ${documentId}`);

      // Get document with citations and references with tenant verification
      const document = await prisma.editorialDocument.findFirst({
        where: { id: documentId, tenantId },
        include: {
          citations: {
            orderBy: [
              { paragraphIndex: 'asc' },
              { startOffset: 'asc' }
            ]
          },
          referenceListEntries: {
            orderBy: { sortKey: 'asc' }
          }
        }
      });

      if (!document) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' }
        });
        return;
      }

      const totalReferences = document.referenceListEntries.length;
      logger.info(`[Citation Management] Document has ${totalReferences} references and ${document.citations.length} citations`);

      // IMPORTANT: Find citations in the actual document text to get correct order
      // The database startOffset might not reflect the true document position
      const fullText = document.fullText || '';
      logger.info(`[Citation Management] Document fullText length: ${fullText.length}`);

      // Find all numeric citations in the fullText to determine actual appearance order
      const citationPattern = /\((\d+)\)|\[(\d+)\]/g;
      const textCitationOrder: { num: number; position: number }[] = [];
      let match;
      while ((match = citationPattern.exec(fullText)) !== null) {
        const num = parseInt(match[1] || match[2]);
        if (num >= 1 && num <= totalReferences) {
          textCitationOrder.push({ num, position: match.index });
        }
      }

      logger.info(`[Citation Management] Citations found in fullText (in order):`);
      for (const tc of textCitationOrder) {
        logger.info(`  Position ${tc.position}: reference number ${tc.num}`);
      }

      // Log database citations for comparison (debug only)
      logger.debug(`[Citation Management] Citations in database order: ${document.citations.length} total`);

      // Use fullText order to determine first appearance of each reference number
      const numberFirstAppearance = new Map<number, { order: number; position: number }>();
      let appearanceOrder = 0;

      // Use textCitationOrder (from actual document text) instead of database order
      for (const tc of textCitationOrder) {
        if (!numberFirstAppearance.has(tc.num)) {
          appearanceOrder++;
          numberFirstAppearance.set(tc.num, {
            order: appearanceOrder,
            position: tc.position
          });
          logger.info(`[Citation Management] Reference ${tc.num} first appears at order ${appearanceOrder} (position ${tc.position} in text)`);
        }
      }

      // Add any reference numbers that weren't cited (put them at the end)
      for (let num = 1; num <= totalReferences; num++) {
        if (!numberFirstAppearance.has(num)) {
          appearanceOrder++;
          numberFirstAppearance.set(num, { order: appearanceOrder, position: -1 });
          logger.info(`[Citation Management] Reference ${num} not cited, putting at end (order ${appearanceOrder})`);
        }
      }

      // Create old number to new number mapping based on appearance order
      // Sort by appearance order to get the new numbering
      const sortedByAppearance = [...numberFirstAppearance.entries()]
        .sort((a, b) => a[1].order - b[1].order);

      const oldToNewNumber = new Map<number, number>();
      sortedByAppearance.forEach(([oldNum], newIndex) => {
        const newNum = newIndex + 1;
        oldToNewNumber.set(oldNum, newNum);
      });

      logger.debug(`[Citation Management] Number mapping: ${[...oldToNewNumber.entries()].sort((a, b) => a[0] - b[0]).map(([o, n]) => `${o}→${n}`).join(', ')}`);

      // Reorder references: reference at old position N moves to new position based on mapping
      // Create array of references in their new order
      const reorderedReferences: typeof document.referenceListEntries = [];
      for (let newPos = 1; newPos <= totalReferences; newPos++) {
        // Find which old position maps to this new position
        const oldPos = [...oldToNewNumber.entries()].find(([_, n]) => n === newPos)?.[0];
        if (oldPos !== undefined) {
          // Reference at old position (0-indexed: oldPos - 1)
          reorderedReferences.push(document.referenceListEntries[oldPos - 1]);
        }
      }

      // Update references in database with new sort order
      await prisma.$transaction(
        reorderedReferences.map((ref, index) => {
          const newPosition = index + 1;
          return prisma.referenceListEntry.update({
            where: { id: ref.id },
            data: { sortKey: String(newPosition).padStart(4, '0') }
          });
        })
      );

      logger.info(`[Citation Management] Reordered ${reorderedReferences.length} references`);

      // Update citation rawText with new numbers
      const citationUpdates: { id: string; newRawText: string; oldRawText: string }[] = [];

      for (const citation of document.citations) {
        // Handle both 'NUMERIC' and 'FOOTNOTE'/'ENDNOTE' (Chicago superscript) citation types
        // Note: Database stores citationType in UPPERCASE
        if (citation.citationType !== 'NUMERIC' && citation.citationType !== 'FOOTNOTE' && citation.citationType !== 'ENDNOTE') continue;

        const newRawText = this.updateCitationNumbers(citation.rawText, oldToNewNumber);
        if (newRawText !== citation.rawText) {
          citationUpdates.push({
            id: citation.id,
            oldRawText: citation.rawText,
            newRawText
          });
        }
      }

      // Apply citation updates
      if (citationUpdates.length > 0) {
        await prisma.$transaction(
          citationUpdates.map(update =>
            prisma.citation.update({
              where: { id: update.id },
              data: { rawText: update.newRawText }
            })
          )
        );

        logger.info(`[Citation Management] Updated ${citationUpdates.length} citations with new numbers`);
      }

      // Fetch updated data
      const updatedDocument = await prisma.editorialDocument.findUnique({
        where: { id: documentId },
        include: {
          citations: {
            orderBy: [
              { paragraphIndex: 'asc' },
              { startOffset: 'asc' }
            ]
          },
          referenceListEntries: {
            orderBy: { sortKey: 'asc' }
          }
        }
      });

      // Fetch REFERENCE_STYLE_CONVERSION changes to use converted text
      const refStyleConversions = await prisma.citationChange.findMany({
        where: {
          documentId,
          changeType: 'REFERENCE_STYLE_CONVERSION',
          isReverted: false
        }
      });
      const refIdToConvertedText = new Map<string, string>();
      for (const change of refStyleConversions) {
        if (change.citationId && change.afterText) {
          refIdToConvertedText.set(change.citationId, change.afterText);
        }
      }

      // Build updated citation-to-reference mapping
      const citationToRefMap = new Map<string, number>();
      updatedDocument!.referenceListEntries.forEach((ref, index) => {
        const refNumber = index + 1;
        ref.citationIds.forEach(citationId => {
          citationToRefMap.set(citationId, refNumber);
        });
      });

      res.json({
        success: true,
        data: {
          message: 'References resequenced by appearance order',
          numberMapping: Object.fromEntries(oldToNewNumber),
          citationsUpdated: citationUpdates.length,
          changes: citationUpdates.map(u => ({
            citationId: u.id,
            before: u.oldRawText,
            after: u.newRawText
          })),
          references: updatedDocument!.referenceListEntries.map((r, index) => {
            const refNumber = index + 1;
            const convertedText = refIdToConvertedText.get(r.id);
            return {
              id: r.id,
              position: refNumber,
              number: refNumber,
              rawText: convertedText || r.formattedApa || `${(r.authors as string[])?.join(', ') || 'Unknown'} (${r.year || 'n.d.'}). ${r.title || 'Untitled'}`,
              authors: r.authors as string[],
              year: r.year || undefined,
              title: r.title || undefined,
              journal: r.journalName || undefined,
              volume: r.volume || undefined,
              issue: r.issue || undefined,
              pages: r.pages || undefined,
              doi: r.doi || undefined,
              url: r.url || undefined,
              publisher: r.publisher || undefined,
              citationCount: r.citationIds.length
            };
          }),
          citations: updatedDocument!.citations.map(c => ({
            id: c.id,
            rawText: c.rawText,
            citationType: c.citationType,
            paragraphIndex: c.paragraphIndex,
            startOffset: c.startOffset,
            endOffset: c.endOffset,
            referenceNumber: citationToRefMap.get(c.id) || null
          }))
        }
      });
    } catch (error) {
      logger.error('[Citation Management] Resequence failed:', error);
      next(error);
    }
  }

  /**
   * Helper: Update citation numbers in rawText based on mapping
   * Handles formats: (1), [1], (1,2,3), [1-3], superscript ¹²³
   */
  private updateCitationNumbers(rawText: string, oldToNewMap: Map<number, number>): string {
    // Handle bracket format: [1], [1,2], [1-3]
    let updated = rawText.replace(/\[(\d+(?:[-,]\d+)*)\]/g, (match, nums) => {
      const newNums = this.remapNumbers(nums, oldToNewMap);
      return `[${newNums}]`;
    });

    // Handle parenthesis format: (1), (1,2), (1-3)
    updated = updated.replace(/\((\d+(?:[-,]\d+)*)\)/g, (match, nums) => {
      const newNums = this.remapNumbers(nums, oldToNewMap);
      return `(${newNums})`;
    });

    // Handle superscript format
    const superscriptMap: Record<string, string> = {
      '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4',
      '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9'
    };
    const reverseSuperscriptMap: Record<string, string> = {
      '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
      '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹'
    };

    updated = updated.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+/g, (match) => {
      const num = parseInt(match.split('').map(c => superscriptMap[c] || c).join(''));
      const newNum = oldToNewMap.get(num) || num;
      return newNum.toString().split('').map(d => reverseSuperscriptMap[d] || d).join('');
    });

    return updated;
  }

  /**
   * Helper: Remap number string (e.g., "1,2,3" or "1-3") to new numbers
   */
  private remapNumbers(numStr: string, oldToNewMap: Map<number, number>): string {
    // Handle ranges like "1-3"
    if (numStr.includes('-')) {
      const parts = numStr.split('-').map(n => parseInt(n.trim()));
      const newParts = parts.map(n => oldToNewMap.get(n) || n);
      // If still consecutive, keep as range
      if (newParts.length === 2 && newParts[1] - newParts[0] === parts[1] - parts[0]) {
        return `${newParts[0]}-${newParts[1]}`;
      }
      // Otherwise expand to comma-separated
      const expanded: number[] = [];
      for (let i = parts[0]; i <= parts[1]; i++) {
        expanded.push(oldToNewMap.get(i) || i);
      }
      return this.formatNumberList(expanded);
    }

    // Handle comma-separated like "1,2,3"
    const nums = numStr.split(',').map(n => parseInt(n.trim()));
    const newNums = nums.map(n => oldToNewMap.get(n) || n);
    return this.formatNumberList(newNums);
  }

  /**
   * Helper: Format number list, converting consecutive numbers to ranges
   * - Use comma (,) for exactly 2 consecutive numbers: [3,4]
   * - Use dash (-) for 3 or more consecutive numbers: [3-5]
   */
  private formatNumberList(nums: number[]): string {
    if (nums.length === 0) return '';
    if (nums.length === 1) return nums[0].toString();

    const sorted = [...nums].sort((a, b) => a - b);
    const ranges: string[] = [];
    let start = sorted[0];
    let end = sorted[0];

    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] === end + 1) {
        end = sorted[i];
      } else {
        // Format the current range
        const rangeLength = end - start + 1;
        if (rangeLength === 1) {
          ranges.push(`${start}`);
        } else if (rangeLength === 2) {
          // Use comma for exactly 2 consecutive numbers
          ranges.push(`${start},${end}`);
        } else {
          // Use dash for 3+ consecutive numbers
          ranges.push(`${start}-${end}`);
        }
        start = sorted[i];
        end = sorted[i];
      }
    }
    // Format the final range
    const rangeLength = end - start + 1;
    if (rangeLength === 1) {
      ranges.push(`${start}`);
    } else if (rangeLength === 2) {
      // Use comma for exactly 2 consecutive numbers
      ranges.push(`${start},${end}`);
    } else {
      // Use dash for 3+ consecutive numbers
      ranges.push(`${start}-${end}`);
    }

    return ranges.join(',');
  }

  /**
   * Helper: Extract all numbers from a citation text
   * Handles formats like "(1)", "(1,2)", "[3-5]", "[3–5]" (en-dash), "¹²³"
   */
  private extractNumbersFromCitation(rawText: string): number[] {
    const numbers: number[] = [];

    // Handle bracket format: [1], [1,2], [1-3], [3–5] (en-dash), [3—5] (em-dash)
    const bracketMatches = rawText.matchAll(/\[(\d+(?:\s*[-–—,]\s*\d+)*)\]/g);
    for (const match of bracketMatches) {
      numbers.push(...this.parseNumberString(match[1]));
    }

    // Handle parenthesis format: (1), (1,2), (1-3), (3–5) (en-dash), (3—5) (em-dash)
    const parenMatches = rawText.matchAll(/\((\d+(?:\s*[-–—,]\s*\d+)*)\)/g);
    for (const match of parenMatches) {
      numbers.push(...this.parseNumberString(match[1]));
    }

    // Handle superscript format
    const superscriptMap: Record<string, string> = {
      '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4',
      '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9'
    };
    const superscriptMatches = rawText.matchAll(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+/g);
    for (const match of superscriptMatches) {
      const num = parseInt(match[0].split('').map(c => superscriptMap[c] || c).join(''));
      if (!isNaN(num)) {
        numbers.push(num);
      }
    }

    return numbers;
  }

  /**
   * Helper: Parse a number string like "1,2,3" or "1-3" or "3–5" (en-dash) into array of numbers
   */
  private parseNumberString(numStr: string): number[] {
    const result: number[] = [];

    // Handle ranges like "1-3", "3–5" (en-dash), "3—5" (em-dash)
    // Check for any dash character (hyphen, en-dash, or em-dash)
    const hasDash = /[-–—]/.test(numStr);

    if (hasDash && !numStr.includes(',')) {
      // Pure range like 3-5 or 3–5
      const parts = numStr.split(/[-–—]/).map(n => parseInt(n.trim()));
      if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
        for (let i = parts[0]; i <= parts[1]; i++) {
          result.push(i);
        }
      }
      return result;
    }

    // Handle comma-separated like "1,2,3" or mixed like "1,3-5"
    const parts = numStr.split(',').map(p => p.trim());
    for (const part of parts) {
      if (/[-–—]/.test(part)) {
        // Range within comma-separated: expand 3-5 to 3,4,5
        const rangeParts = part.split(/[-–—]/).map(n => parseInt(n.trim()));
        if (rangeParts.length === 2 && !isNaN(rangeParts[0]) && !isNaN(rangeParts[1])) {
          for (let i = rangeParts[0]; i <= rangeParts[1]; i++) {
            result.push(i);
          }
        }
      } else {
        // Single number
        const num = parseInt(part);
        if (!isNaN(num)) {
          result.push(num);
        }
      }
    }

    return result;
  }

  /**
   * POST /api/v1/citation/document/:documentId/convert-style
   * Convert citation style
   */
  async convertStyle(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const { targetStyle } = req.body;

      if (!aiFormatConverterService.isStyleSupported(targetStyle)) {
        res.status(400).json({
          success: false,
          error: { code: 'UNSUPPORTED_STYLE', message: `Style ${targetStyle} is not supported` }
        });
        return;
      }

      logger.info(`[Citation Management] Converting ${documentId} to ${targetStyle}`);

      const document = await prisma.editorialDocument.findUnique({
        where: { id: documentId },
        include: {
          citations: true,
          referenceListEntries: true
        }
      });

      if (!document) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' }
        });
        return;
      }

      // Convert format
      const references = document.referenceListEntries.map((r, index) => {
        const authors = Array.isArray(r.authors) ? r.authors as string[] : [];
        logger.info(`[Citation Management] Reference ${index + 1}: authors=${JSON.stringify(authors)}, year=${r.year}`);
        return {
          id: r.id,
          number: index + 1,
          rawText: r.formattedApa || `${authors.join(', ')} (${r.year}). ${r.title}`,
          components: {
            authors: authors,
            year: r.year || undefined,
            title: r.title || undefined,
            journal: r.journalName || undefined,
            volume: r.volume || undefined,
            issue: r.issue || undefined,
            pages: r.pages || undefined,
            doi: r.doi || undefined
          },
          citedBy: []
        };
      });

      logger.info(`[Citation Management] Converting ${references.length} references and ${document.citations.length} citations to ${targetStyle}`);

      // Log what we're sending to the AI
      references.forEach((ref, idx) => {
        logger.info(`[Citation Management] Input ref ${idx + 1} (id: ${ref.id}): "${(ref.rawText || '').substring(0, 100)}"`);
      });

      const citations = document.citations.map(c => {
        // Extract and expand numbers from citation text (handles ranges like [3-5] → [3,4,5])
        const numbers = this.extractNumbersFromCitation(c.rawText || '');
        logger.info(`[Citation Management] Citation: "${c.rawText}" → expanded numbers: [${numbers.join(', ')}]`);
        return {
          id: c.id,
          text: c.rawText,
          position: { paragraph: c.paragraphIndex || 0, sentence: 0, startChar: c.startOffset, endChar: c.endOffset },
          type: 'numeric' as const,
          format: 'bracket' as const,
          numbers: numbers, // Pre-extract numbers from citation text (with range expansion)
          context: c.rawText
        };
      });

      const result = await aiFormatConverterService.convertStyle(
        references,
        citations,
        targetStyle as CitationStyle
      );

      logger.info(`[Citation Management] Conversion result: ${result.convertedReferences.length} references, ${result.citationConversions.length} in-text citation changes`);
      result.citationConversions.forEach((c, i) => {
        logger.info(`[Citation Management] Citation conversion ${i + 1}: "${c.oldText}" → "${c.newText}"`);
      });

      // Update database - references and track changes for preview
      logger.info(`[Citation Management] Updating ${result.convertedReferences.length} references in database`);

      // Collect reference changes for storage
      const referenceChanges: Array<{ refId: string; beforeText: string; afterText: string }> = [];

      for (let i = 0; i < result.convertedReferences.length; i++) {
        const ref = result.convertedReferences[i];
        const originalRef = references[i]; // The input we sent to AI

        logger.info(`[Citation Management] Updating ref ${ref.id}: "${(ref.rawText || '').substring(0, 80)}..."`);
        try {
          await prisma.referenceListEntry.update({
            where: { id: ref.id },
            data: { formattedApa: ref.rawText }
          });
          logger.info(`[Citation Management] Successfully updated ref ${ref.id}`);

          // Track the change if text actually changed
          if (originalRef && originalRef.rawText !== ref.rawText) {
            referenceChanges.push({
              refId: ref.id,
              beforeText: originalRef.rawText,
              afterText: ref.rawText
            });
          }
        } catch (updateError: unknown) {
          const errorMessage = updateError instanceof Error ? updateError.message : 'Unknown error';
          logger.error(`[Citation Management] Failed to update ref ${ref.id}: ${errorMessage}`);
        }
      }

      // Update document with style
      await prisma.editorialDocument.update({
        where: { id: documentId },
        data: { referenceListStyle: targetStyle }
      });

      // Store citation conversions as CitationChange records for use during export
      // First, delete any existing style conversion changes for this document
      await prisma.citationChange.deleteMany({
        where: {
          documentId,
          changeType: { in: ['STYLE_CONVERSION', 'REFERENCE_STYLE_CONVERSION'] }
        }
      });

      // Create new citation change records for in-text citation conversions
      if (result.citationConversions.length > 0) {
        await prisma.citationChange.createMany({
          data: result.citationConversions.map(conversion => ({
            documentId,
            changeType: 'STYLE_CONVERSION',
            beforeText: conversion.oldText,
            afterText: conversion.newText,
            appliedBy: 'SYSTEM'
          }))
        });
        logger.info(`[Citation Management] Stored ${result.citationConversions.length} citation conversions in database`);

        // CRITICAL: Actually update the citation rawText in the database
        // Without this, the citations still show the old format
        const citationUpdatePromises: Promise<{ id: string; rawText: string }>[] = [];
        for (const conversion of result.citationConversions) {
          // Find all citations with the old text and update them
          const citationsToUpdate = document.citations.filter(c => c.rawText === conversion.oldText);
          for (const citation of citationsToUpdate) {
            citationUpdatePromises.push(
              prisma.citation.update({
                where: { id: citation.id },
                data: { rawText: conversion.newText }
              })
            );
            logger.info(`[Citation Management] Updating citation ${citation.id}: "${conversion.oldText}" → "${conversion.newText}"`);
          }
        }
        if (citationUpdatePromises.length > 0) {
          await Promise.all(citationUpdatePromises);
          logger.info(`[Citation Management] Updated ${citationUpdatePromises.length} citation rawText values`);
        }
      }

      // Create new citation change records for reference style conversions
      // Note: Using citationId field to store the reference ID
      if (referenceChanges.length > 0) {
        await prisma.citationChange.createMany({
          data: referenceChanges.map(change => ({
            documentId,
            changeType: 'REFERENCE_STYLE_CONVERSION',
            beforeText: change.beforeText,
            afterText: change.afterText,
            citationId: change.refId, // Store reference ID in citationId field
            appliedBy: 'SYSTEM'
          }))
        });
        logger.info(`[Citation Management] Stored ${referenceChanges.length} reference style conversions in database`);
      }

      logger.info(`[Citation Management] Style conversion complete: ${result.changes.length} references, ${result.citationConversions.length} in-text citations`);

      // Fetch updated references to return to frontend
      const updatedRefs = await prisma.referenceListEntry.findMany({
        where: { documentId },
        orderBy: { sortKey: 'asc' }
      });

      // Build a map of reference ID to converted text from the changes we just made
      const refIdToConvertedText = new Map<string, string>();
      for (const change of referenceChanges) {
        if (change.refId && change.afterText) {
          refIdToConvertedText.set(change.refId, change.afterText);
        }
      }

      res.json({
        success: true,
        data: {
          message: `Converted to ${targetStyle} style`,
          targetStyle,
          referenceChangesCount: result.changes.length,
          citationChangesCount: result.citationConversions.length,
          citationConversions: result.citationConversions,
          // Return updated references so frontend can update display immediately
          references: updatedRefs.map((r, index) => {
            const convertedText = refIdToConvertedText.get(r.id);
            return {
              id: r.id,
              position: index + 1,
              number: index + 1,
              rawText: convertedText || r.formattedApa || `${(r.authors as string[])?.join(', ') || 'Unknown'} (${r.year || 'n.d.'}). ${r.title || 'Untitled'}`,
              authors: r.authors as string[],
              year: r.year,
              title: r.title,
              journal: r.journalName,
              volume: r.volume,
              issue: r.issue,
              pages: r.pages,
              doi: r.doi,
              citationCount: r.citationIds.length
            };
          }),
          // Return reference changes for display
          referenceChanges: result.changes.map(c => ({
            referenceId: c.referenceId,
            oldFormat: c.oldFormat,
            newFormat: c.newFormat
          }))
        }
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/v1/citation/document/:documentId/validate-dois
   * Validate all DOIs in references
   */
  async validateDOIs(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;

      const document = await prisma.editorialDocument.findUnique({
        where: { id: documentId },
        include: { referenceListEntries: true }
      });

      if (!document) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' }
        });
        return;
      }

      // Fetch REFERENCE_STYLE_CONVERSION changes to use converted text
      const refStyleConversions = await prisma.citationChange.findMany({
        where: {
          documentId,
          changeType: 'REFERENCE_STYLE_CONVERSION',
          isReverted: false
        }
      });
      const refIdToConvertedText = new Map<string, string>();
      for (const change of refStyleConversions) {
        if (change.citationId && change.afterText) {
          refIdToConvertedText.set(change.citationId, change.afterText);
        }
      }

      const references = document.referenceListEntries.map((r, index) => {
        const convertedText = refIdToConvertedText.get(r.id);
        return {
          id: r.id,
          number: index + 1,
          rawText: convertedText || r.formattedApa || `${(r.authors as string[])?.join(', ') || 'Unknown'} (${r.year || 'n.d.'}). ${r.title || 'Untitled'}`,
          components: {
            authors: r.authors as string[],
            year: r.year || undefined,
            title: r.title || undefined,
            journal: r.journalName || undefined,
            doi: r.doi || undefined
          },
          citedBy: []
        };
      });

      const validations = await doiValidationService.validateReferences(references);

      res.json({
        success: true,
        data: {
          validations,
          summary: {
            total: validations.length,
            valid: validations.filter(v => v.hasValidDOI).length,
            invalid: validations.filter(v => !v.hasValidDOI).length,
            withDiscrepancies: validations.filter(v => v.discrepancies && v.discrepancies.length > 0).length
          }
        }
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/v1/citation/document/:documentId/export
   * Export modified DOCX with updated citation numbers
   *
   * WORKING VERSION - 2026-02-14
   * Fixed: Orphan handling, RESEQUENCE+RENUMBER chaining, validFinalRefs protection
   * Key fixes:
   * - Step 3: Track usedRenumberBeforeTexts during RESEQUENCE+RENUMBER chaining
   * - Step 4: Look up original DOCX text from RESEQUENCE for orphan detection
   * - Step 4: Use validFinalRefs (includes current DB texts) to prevent orphan collision
   * - Correctly chains ORIGINAL → DB_UPLOAD → CURRENT for track changes
   */
  async exportDocument(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const acceptChanges = req.query.acceptChanges === 'true';

      logger.info(`[Citation Management] Exporting document ${documentId} (acceptChanges: ${acceptChanges})`);

      // Get document with citations and references
      const document = await prisma.editorialDocument.findUnique({
        where: { id: documentId },
        include: {
          citations: true,
          referenceListEntries: {
            orderBy: { sortKey: 'asc' }
          }
        }
      });

      if (!document) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' }
        });
        return;
      }

      // DEBUG: Log reference data
      logger.info(`[Citation Management] Found ${document.referenceListEntries.length} references and ${document.citations.length} citations`);
      document.referenceListEntries.forEach((ref, index) => {
        logger.info(`[Citation Management] Ref ${index}: sortKey=${ref.sortKey}, citationIds count=${ref.citationIds?.length || 0}, citationIds=${JSON.stringify(ref.citationIds)}`);
      });

      // Check if this is an author-year style document
      // IMPORTANT: Don't rely solely on style name - check actual citation types AND content
      // Chicago can be either:
      //   - Chicago Author-Date (author-year citations like "(Smith, 2020)")
      //   - Chicago Notes-Bibliography (numeric superscript citations like ¹, ², ³)
      // We determine this by checking the citationType of citations in the document
      // NOTE: Database stores citationType in UPPERCASE (NUMERIC, PARENTHETICAL, NARRATIVE, FOOTNOTE, ENDNOTE)

      // Pattern to detect numeric-looking citations: (1), (2), [1], [1,2], [1-3], (1, 2), etc.
      // These should be treated as numeric even if citationType is PARENTHETICAL
      const numericCitationPattern = /^[\[\(]\s*\d+(?:\s*[-–,]\s*\d+)*\s*[\]\)]$/;

      const hasNumericCitations = document.citations.some(
        c => c.citationType === 'NUMERIC' || c.citationType === 'FOOTNOTE' || c.citationType === 'ENDNOTE'
      );

      // Check if PARENTHETICAL/NARRATIVE citations are actually numeric-looking
      // This catches cases where AI misclassifies (1), (2) as PARENTHETICAL instead of NUMERIC
      const hasNumericLookingCitations = document.citations.some(
        c => (c.citationType === 'PARENTHETICAL' || c.citationType === 'NARRATIVE') &&
             c.rawText && numericCitationPattern.test(c.rawText.trim())
      );

      const hasAuthorYearCitations = document.citations.some(
        c => (c.citationType === 'PARENTHETICAL' || c.citationType === 'NARRATIVE') &&
             c.rawText && !numericCitationPattern.test(c.rawText.trim())
      );

      // If document has numeric/footnote citations OR numeric-looking citations, treat as numeric document
      // even if style name contains 'chicago'
      const isAuthorYearDocument = hasAuthorYearCitations && !hasNumericCitations && !hasNumericLookingCitations;

      logger.info(`[Citation Management] Document style: ${document.referenceListStyle}, hasNumericCitations: ${hasNumericCitations}, hasNumericLookingCitations: ${hasNumericLookingCitations}, hasAuthorYearCitations: ${hasAuthorYearCitations}, isAuthorYear: ${isAuthorYearDocument}`);

      // Build citation-to-reference number mapping
      // Strategy: Map each citation to its current reference position based on sortKey order
      const citationToRefMap = new Map<string, number>();

      // First, try using citationIds array (preferred method)
      document.referenceListEntries.forEach((ref, index) => {
        // Use index+1 as the new reference number (1-based position after sorting by sortKey)
        const refNumber = index + 1;
        if (ref.citationIds && ref.citationIds.length > 0) {
          ref.citationIds.forEach(citationId => {
            citationToRefMap.set(citationId, refNumber);
            logger.info(`[Citation Management] Mapped citation ${citationId} to ref number ${refNumber}`);
          });
        }
      });

      logger.info(`[Citation Management] Built citationToRefMap with ${citationToRefMap.size} entries from citationIds`);

      // Fallback: If citationIds are empty, match by original citation number to new position
      if (citationToRefMap.size === 0) {
        logger.warn('[Citation Management] citationIds arrays are empty, using fallback matching by number');

        // The references are already ordered by sortKey.
        // We need to map: original citation number -> new position
        // Since we don't know the original number of each reference after reordering,
        // we need a different approach: match citation rawText to reference position

        // For each citation, find which reference it belongs to based on original number
        // Then use that reference's current position
        document.citations.forEach(citation => {
          if (citation.rawText) {
            const numberMatch = citation.rawText.match(/\d+/);
            if (numberMatch) {
              const originalNumber = parseInt(numberMatch[0]);
              // Find the reference at current position (index+1) and use that
              // This fallback assumes references maintain their original order - not correct after reordering
              // We need to track original numbers somehow

              // For now, just map citation to its original number's position
              // This won't work correctly after reordering without tracking original numbers
              if (originalNumber <= document.referenceListEntries.length) {
                citationToRefMap.set(citation.id, originalNumber);
                logger.info(`[Citation Management] Fallback: Citation "${citation.rawText}" mapped to position ${originalNumber}`);
              }
            }
          }
        });

        logger.info(`[Citation Management] Fallback method mapped ${citationToRefMap.size} citations`);
      }

      // Build a complete mapping of OLD reference numbers to NEW reference numbers
      // This is needed to properly handle multi-number citations like (4, 5) or ranges (4-7)
      // NOTE: This is ONLY for numeric citation documents. Skip for author-year documents.
      const oldToNewNumberMap = new Map<number, number>();
      const deletedNumbers = new Set<number>();

      // Initialize citation change arrays (these will be populated for numeric docs, empty for author-year)
      const changedCitations: Array<{ oldText: string; newText: string }> = [];
      const orphanedCitations: string[] = [];

      // Only build number mapping for NUMERIC documents, not author-year
      if (!isAuthorYearDocument) {
        // DEBUG: Log all reference entries with their sortKeys and citationIds
        logger.info(`[Citation Management] === Building oldToNewNumberMap (NUMERIC document) ===`);
      document.referenceListEntries.forEach((ref, index) => {
        const linkedCitations = document.citations.filter(c => ref.citationIds.includes(c.id));
        const citationTexts = linkedCitations.map(c => c.rawText).join(', ');
        logger.info(`[Citation Management] Ref[${index}]: sortKey=${ref.sortKey}, newPos=${index + 1}, authors=${JSON.stringify(ref.authors)}, linkedCitations=[${citationTexts}]`);
      });

      // PASS 1: Build mapping from SINGLE-NUMBER citations only (most reliable)
      // These give us definitive mappings like "(4)" → old number was 4
      document.referenceListEntries.forEach((ref, index) => {
        const newNumber = index + 1;

        if (ref.citationIds && ref.citationIds.length > 0) {
          const linkedCitations = document.citations.filter(c => ref.citationIds.includes(c.id));

          // First, look for single-number citations
          for (const citation of linkedCitations) {
            if (citation.rawText) {
              // Use extractNumbersFromCitation to properly expand ranges like [3-5] → [3,4,5]
              const numbers = this.extractNumbersFromCitation(citation.rawText);
              if (numbers.length === 1) {
                // Single number citation - definitive mapping
                const oldNum = numbers[0];
                if (!oldToNewNumberMap.has(oldNum)) {
                  oldToNewNumberMap.set(oldNum, newNumber);
                  logger.info(`[Citation Management] Mapped (single): ${oldNum} → ${newNumber} (from ref with authors: ${JSON.stringify(ref.authors)})`);
                }
              }
            }
          }
        }
      });

      // PASS 2: For references without single-number citations, use multi-number citations
      // We need to figure out which number in "(4, 5)" belongs to which reference
      document.referenceListEntries.forEach((ref, index) => {
        const newNumber = index + 1;

        // Skip if this reference's old number is already mapped
        const alreadyMapped = [...oldToNewNumberMap.entries()].some(([_, newNum]) => newNum === newNumber);
        if (alreadyMapped) return;

        if (ref.citationIds && ref.citationIds.length > 0) {
          const linkedCitations = document.citations.filter(c => ref.citationIds.includes(c.id));

          for (const citation of linkedCitations) {
            if (citation.rawText) {
              // Use extractNumbersFromCitation to properly expand ranges like [3-5] → [3,4,5]
              const numbers = this.extractNumbersFromCitation(citation.rawText);
              // Find the first number that hasn't been mapped yet
              for (const oldNum of numbers) {
                if (!oldToNewNumberMap.has(oldNum)) {
                  oldToNewNumberMap.set(oldNum, newNumber);
                  logger.info(`[Citation Management] Mapped (multi): ${oldNum} → ${newNumber} (from "${citation.rawText}")`);
                  break;
                }
              }
            }
          }
        }
      });

      // Find orphaned/deleted numbers from ALL citations
      // A number is deleted if it's NOT in oldToNewNumberMap (meaning its reference was removed)
      // This handles multi-number citations like "(1, 2)" where only "1" was deleted
      // Also handles ranges like [3-5] by expanding to [3,4,5]
      document.citations.forEach(citation => {
        if (citation.rawText) {
          // Use extractNumbersFromCitation to properly expand ranges like [3-5] → [3,4,5]
          const numbers = this.extractNumbersFromCitation(citation.rawText);
          numbers.forEach(oldNum => {
            // If this specific number has no mapping, the reference was deleted
            if (!oldToNewNumberMap.has(oldNum)) {
              deletedNumbers.add(oldNum);
              logger.info(`[Citation Management] Deleted number detected: ${oldNum} (from "${citation.rawText}")`);
            }
          });
        }
      });

      // Log the number mapping for debugging
      logger.info(`[Citation Management] === Final Number Mapping ===`);
      logger.debug(`[Citation Management] Number mapping: ${[...oldToNewNumberMap.entries()].sort((a, b) => a[0] - b[0]).map(([o, n]) => `${o}→${n}`).join(', ')}`);
      logger.info(`[Citation Management] Deleted numbers: ${[...deletedNumbers].join(', ')}`);

      // Debug: Show which numbers need to change
      for (const [oldNum, newNum] of oldToNewNumberMap) {
        if (oldNum !== newNum) {
          logger.info(`[Citation Management] CHANGE NEEDED: (${oldNum}) → (${newNum})`);
        }
      }

      // Build list of changed and orphaned citations (uses arrays declared above)
      const processedTexts = new Set<string>(); // To avoid duplicates

      document.citations.forEach(citation => {
        if (!citation.rawText || processedTexts.has(citation.rawText)) {
          return;
        }
        processedTexts.add(citation.rawText);

        const rawText = citation.rawText;
        // Use extractNumbersFromCitation to properly expand ranges like [3-5] → [3,4,5]
        const numbers = this.extractNumbersFromCitation(rawText);

        if (numbers.length === 0) return;

        // Categorize each number
        const deletedNums: number[] = [];
        const survivingNums: { oldNum: number; newNum: number }[] = [];

        for (const oldNum of numbers) {
          if (deletedNumbers.has(oldNum)) {
            deletedNums.push(oldNum);
          } else {
            const newNum = oldToNewNumberMap.get(oldNum) || oldNum;
            survivingNums.push({ oldNum, newNum });
          }
        }

        logger.info(`[Citation Management] Citation "${rawText}": deleted=[${deletedNums.join(',')}], surviving=[${survivingNums.map(s => `${s.oldNum}→${s.newNum}`).join(',')}]`);

        // Case 1: ALL numbers are deleted - entire citation is orphaned
        if (survivingNums.length === 0) {
          orphanedCitations.push(rawText);
          logger.info(`[Citation Management] Orphaned: "${rawText}" (all references deleted)`);
          return;
        }

        // Case 2: SOME numbers are deleted (partial deletion) - rebuild citation with only surviving numbers
        // Case 3: NO numbers deleted, but some might need renumbering

        // Check if any changes are needed (either deletions or number changes)
        const hasDeletedNumber = deletedNums.length > 0;
        const hasRenumbering = survivingNums.some(s => s.oldNum !== s.newNum);

        if (!hasDeletedNumber && !hasRenumbering) {
          // No changes needed
          return;
        }

        // Build newText:
        // For partial deletions, we create a new citation with only the surviving numbers (renumbered)
        // For simple renumbering, we replace numbers in place

        if (hasDeletedNumber) {
          // Partial deletion case: build new citation with only surviving numbers
          // Extract the format pattern (parentheses, brackets, etc.)
          const formatMatch = rawText.match(/^(\s*[\(\[\{]?).*?([\)\]\}]?\s*)$/);
          const prefix = formatMatch ? formatMatch[1] : '(';
          const suffix = formatMatch ? formatMatch[2] : ')';

          // Build the new number list with proper formatting
          const newNumbers = survivingNums.map(s => String(s.newNum));

          // Detect separator style from original
          const separatorMatch = rawText.match(/\d+(\s*[,;]\s*)\d+/);
          const separator = separatorMatch ? separatorMatch[1] : ', ';

          const newText = prefix + newNumbers.join(separator) + suffix;

          changedCitations.push({ oldText: rawText, newText });
          logger.info(`[Citation Management] Partial deletion: "${rawText}" → "${newText}" (removed: ${deletedNums.join(',')})`);
        } else {
          // Simple renumbering case (no deletions)
          let newText = rawText;

          // Sort numbers by length descending to avoid partial replacements (e.g., "19" before "1")
          const sortedSurviving = [...survivingNums].sort((a, b) =>
            String(b.oldNum).length - String(a.oldNum).length || b.oldNum - a.oldNum
          );

          // Phase 1: Replace all numbers with placeholders
          const placeholderMap = new Map<string, number>();
          for (const { oldNum, newNum } of sortedSurviving) {
            if (newNum !== oldNum) {
              const placeholder = `__NUM_${oldNum}__`;
              placeholderMap.set(placeholder, newNum);
              const regex = new RegExp(`\\b${oldNum}\\b`, 'g');
              newText = newText.replace(regex, placeholder);
            }
          }

          // Phase 2: Replace placeholders with actual new numbers
          for (const [placeholder, newNum] of placeholderMap) {
            newText = newText.replace(new RegExp(placeholder, 'g'), String(newNum));
          }

          changedCitations.push({ oldText: rawText, newText });
          logger.info(`[Citation Management] Renumbered: "${rawText}" → "${newText}"`);
        }
      });
      } else {
        // Author-year documents: Skip numeric renumbering entirely
        logger.info(`[Citation Management] === Skipping numeric renumbering (AUTHOR-YEAR document: ${document.referenceListStyle}) ===`);
      }

      logger.info(`[Citation Management] Changes: ${changedCitations.length} changed, ${orphanedCitations.length} orphaned`);

      // For author-year documents, also detect orphaned citations by checking which citations
      // are not linked to any remaining references (handles deletions made before tracking was added)
      if (isAuthorYearDocument) {
        // Build set of all citation IDs linked to remaining references
        const linkedCitationIds = new Set<string>();
        document.referenceListEntries.forEach(ref => {
          if (ref.citationIds) {
            ref.citationIds.forEach(id => linkedCitationIds.add(id));
          }
        });

        // Find citations that are not linked to any reference (orphaned)
        // Note: Database stores citationType in UPPERCASE
        const orphanedAuthorYearCitations = document.citations.filter(
          c => !linkedCitationIds.has(c.id) && c.citationType !== 'NUMERIC' && c.citationType !== 'FOOTNOTE' && c.citationType !== 'ENDNOTE'
        );

        if (orphanedAuthorYearCitations.length > 0) {
          logger.info(`[Citation Management] Found ${orphanedAuthorYearCitations.length} orphaned author-year citations (not linked to any reference)`);
          for (const citation of orphanedAuthorYearCitations) {
            if (citation.rawText && !orphanedCitations.includes(citation.rawText)) {
              orphanedCitations.push(citation.rawText);
              logger.info(`[Citation Management] Adding orphaned author-year citation: "${citation.rawText}"`);
            }
          }
        }
      }

      // Load original DOCX file
      const fs = await import('fs/promises');
      const path = await import('path');
      const filePath = path.join(process.cwd(), 'uploads', document.storagePath);

      const originalBuffer = await fs.readFile(filePath);
      logger.info(`[Citation Management] Loaded original DOCX from ${filePath}`);

      // Prepare reference entries for updating References section
      // Check if style conversion was applied (formattedApa will have the converted text)
      const hasStyleConversion = document.referenceListStyle &&
        document.referenceListEntries.some(ref => ref.formattedApa);

      logger.info(`[Citation Management] Export - Style check: referenceListStyle="${document.referenceListStyle}", hasFormattedApa=${document.referenceListEntries.some(ref => ref.formattedApa)}, hasStyleConversion=${hasStyleConversion}`);

      // Log each reference's formattedApa content
      document.referenceListEntries.forEach((ref, idx) => {
        logger.info(`[Citation Management] Export - Ref ${idx + 1}: formattedApa="${(ref.formattedApa || '').substring(0, 100)}..."`);
      });

      const currentReferences: ReferenceEntry[] = document.referenceListEntries.map(ref => ({
        id: ref.id,
        authors: Array.isArray(ref.authors) ? ref.authors as string[] : [],
        title: ref.title || undefined,
        sortKey: ref.sortKey,
        // Include converted text for style conversion (if style was changed)
        convertedText: hasStyleConversion ? ref.formattedApa || undefined : undefined,
        // Include bibliographic details for building complete citations
        year: ref.year || undefined,
        journalName: ref.journalName || undefined,
        volume: ref.volume || undefined,
        issue: ref.issue || undefined,
        pages: ref.pages || undefined,
        doi: ref.doi || undefined
      }));

      if (hasStyleConversion) {
        logger.info(`[Citation Management] Style conversion will be applied: ${document.referenceListStyle}`);
        currentReferences.forEach((ref, idx) => {
          logger.info(`[Citation Management] Export - Ref ${idx + 1} convertedText: "${(ref.convertedText || 'NONE').substring(0, 100)}..."`);
        });
      } else {
        logger.warn(`[Citation Management] Export - NO style conversion detected (referenceListStyle=${document.referenceListStyle})`);
      }

      // Get stored citation conversions from CitationChange table (for in-text citation style conversion)
      const storedCitationConversions = await prisma.citationChange.findMany({
        where: {
          documentId,
          changeType: 'STYLE_CONVERSION',
          isReverted: false
        }
      });

      // Get stored resequence changes from CitationChange table (for auto-resequencing during upload)
      const storedResequenceChanges = await prisma.citationChange.findMany({
        where: {
          documentId,
          changeType: 'RESEQUENCE',
          isReverted: false
        }
      });

      // Get stored renumber changes (from reference deletion/reordering)
      const storedRenumberChanges = await prisma.citationChange.findMany({
        where: {
          documentId,
          changeType: 'RENUMBER',
          isReverted: false
        }
      });

      if (storedRenumberChanges.length > 0) {
        logger.info(`[Citation Management] Found ${storedRenumberChanges.length} renumber changes from deletion/reordering`);
      }

      // Get stored reference edit changes (for author-year citation edits)
      const storedReferenceEditChanges = await prisma.citationChange.findMany({
        where: {
          documentId,
          changeType: 'REFERENCE_EDIT',
          isReverted: false
        }
      });

      if (storedReferenceEditChanges.length > 0) {
        logger.info(`[Citation Management] Found ${storedReferenceEditChanges.length} reference edit changes (author-year edits)`);
      }

      // Create typed array for changes with changeType support
      let changedCitationsWithType: Array<{ oldText: string; newText: string; changeType?: 'renumber' | 'style_conversion' | 'orphaned' }> =
        changedCitations.map(c => ({ ...c, changeType: 'renumber' as const }));

      // Add resequence changes (these are the primary changes from auto-resequencing during upload)
      // IMPORTANT: RESEQUENCE changes map ORIGINAL DOCX text → DB text AT UPLOAD
      // RENUMBER changes map OLD_DB text → NEW_DB text (from reorder operations)
      // We need to CHAIN them: ORIGINAL → NEW_DB

      // Track which RENUMBER changes are used during initial chaining (to skip later)
      const usedRenumberBeforeTexts = new Set<string>();

      if (storedResequenceChanges.length > 0) {
        logger.info(`[Citation Management] Found ${storedResequenceChanges.length} resequence changes from auto-resequencing`);

        // Check if there are stored RENUMBER changes (from reorder operations)
        // These should be used INSTEAD of computing dynamic changes from current DB state
        const renumberChangesForChaining = storedRenumberChanges.filter(
          c => !c.afterText.toLowerCase().includes('orphaned')
        );

        if (renumberChangesForChaining.length > 0) {
          // Use stored RENUMBER changes for chaining (OLD_DB → NEW_DB)
          const renumberMap = new Map<string, string>();
          for (const change of renumberChangesForChaining) {
            renumberMap.set(change.beforeText, change.afterText);
          }
          logger.debug(`[Citation Management] Using stored RENUMBER changes for chaining: ${[...renumberMap.entries()].map(([o, n]) => `"${o}"→"${n}"`).join(', ')}`);

          // Chain: RESEQUENCE (original→oldDB) + RENUMBER (oldDB→newDB) = (original→newDB)
          const chainedChanges: Array<{ oldText: string; newText: string; changeType?: 'renumber' | 'style_conversion' | 'orphaned' }> = [];

          for (const reseq of storedResequenceChanges) {
            const originalText = reseq.beforeText;  // e.g., "(2)" in original DOCX
            const oldDbText = reseq.afterText;      // e.g., "(1)" in DB at upload time

            // Check if there's a RENUMBER change for the old DB text
            const newDbText = renumberMap.get(oldDbText);
            if (newDbText !== undefined) {
              // Mark this RENUMBER as used
              usedRenumberBeforeTexts.add(oldDbText);
              // Chain: original → newDB
              if (originalText !== newDbText) {
                chainedChanges.push({
                  oldText: originalText,
                  newText: newDbText,
                  changeType: 'renumber' as const
                });
                logger.info(`[Citation Management] Chained (RESEQUENCE+RENUMBER): "${originalText}" → "${oldDbText}" → "${newDbText}" = "${originalText}" → "${newDbText}"`);
              } else {
                logger.info(`[Citation Management] Chained: "${originalText}" → "${oldDbText}" → "${newDbText}" = NO CHANGE (same)`);
              }
              renumberMap.delete(oldDbText);
            } else {
              // No RENUMBER change for this text - check if RESEQUENCE alone makes a change
              if (originalText !== oldDbText) {
                chainedChanges.push({
                  oldText: originalText,
                  newText: oldDbText,
                  changeType: 'renumber' as const
                });
                logger.info(`[Citation Management] RESEQUENCE only: "${originalText}" → "${oldDbText}"`);
              }
            }
          }

          // Add any remaining RENUMBER changes that weren't chained (texts not in RESEQUENCE)
          for (const [oldText, newText] of renumberMap) {
            usedRenumberBeforeTexts.add(oldText);
            if (oldText !== newText) {
              chainedChanges.push({ oldText, newText, changeType: 'renumber' as const });
              logger.info(`[Citation Management] RENUMBER only (no RESEQUENCE): "${oldText}" → "${newText}"`);
            }
          }

          changedCitationsWithType = chainedChanges;
          logger.debug(`[Citation Management] Final chained changes: ${changedCitationsWithType.map(c => `"${c.oldText}"→"${c.newText}"`).join(', ')}`);
          logger.info(`[Citation Management] Used RENUMBER beforeTexts: ${[...usedRenumberBeforeTexts].join(', ')}`);
        } else {
          // No non-orphaned RENUMBER changes - use RESEQUENCE changes directly
          // This handles deletion scenarios where only orphaned RENUMBER changes exist
          // Build set of current valid DB texts to check which RESEQUENCE entries are still valid
          const currentDbTexts = new Set<string>();
          document.citations.forEach(c => {
            if (c.rawText) currentDbTexts.add(c.rawText);
          });
          logger.info(`[Citation Management] Current DB texts: ${[...currentDbTexts].join(', ')}`);

          const chainedChanges: Array<{ oldText: string; newText: string; changeType?: 'renumber' | 'style_conversion' | 'orphaned' }> = [];

          for (const reseq of storedResequenceChanges) {
            const originalText = reseq.beforeText;
            const dbTextAtUpload = reseq.afterText;

            // Check if the DB text at upload is still valid in current DB
            if (currentDbTexts.has(dbTextAtUpload)) {
              // Still valid - use RESEQUENCE directly
              if (originalText !== dbTextAtUpload) {
                chainedChanges.push({
                  oldText: originalText,
                  newText: dbTextAtUpload,
                  changeType: 'renumber' as const
                });
                logger.info(`[Citation Management] RESEQUENCE (valid): "${originalText}" → "${dbTextAtUpload}"`);
              }
            } else {
              // DB text at upload is no longer valid - citation was deleted/orphaned
              // Add original text to orphanedCitations
              if (!orphanedCitations.includes(originalText)) {
                orphanedCitations.push(originalText);
                logger.info(`[Citation Management] RESEQUENCE (orphaned): "${originalText}" → "${dbTextAtUpload}" (no longer in DB) - marking "${originalText}" as orphaned`);
              }
            }
          }

          changedCitationsWithType = chainedChanges;
          logger.debug(`[Citation Management] Final RESEQUENCE-only changes: ${changedCitationsWithType.map(c => `"${c.oldText}"→"${c.newText}"`).join(', ')}`);
        }

        // SKIP dynamic changes path since we've handled all cases above
        if (false) {
          // CHAIN: RESEQUENCE (original→current) + dynamic (current→final) = (original→final)
          // This path is for when there are dynamically computed changes (e.g., from deletion)
          const dynamicMap = new Map<string, string>();
          for (const change of changedCitationsWithType) {
            dynamicMap.set(change.oldText, change.newText);
          }
          logger.debug(`[Citation Management] Dynamic changes to chain: ${[...dynamicMap.entries()].map(([o, n]) => `"${o}"→"${n}"`).join(', ')}`);

          const chainedChanges: Array<{ oldText: string; newText: string; changeType?: 'renumber' | 'style_conversion' | 'orphaned' }> = [];

          for (const reseq of storedResequenceChanges) {
            const originalText = reseq.beforeText;
            const currentText = reseq.afterText;

            const finalText = dynamicMap.get(currentText);
            if (finalText !== undefined) {
              if (originalText !== finalText) {
                chainedChanges.push({
                  oldText: originalText,
                  newText: finalText,
                  changeType: 'renumber' as const
                });
                logger.info(`[Citation Management] Chained: "${originalText}" → "${currentText}" → "${finalText}" = "${originalText}" → "${finalText}"`);
              }
              dynamicMap.delete(currentText);
            } else {
              if (originalText !== currentText) {
                chainedChanges.push({
                  oldText: originalText,
                  newText: currentText,
                  changeType: 'renumber' as const
                });
                logger.info(`[Citation Management] RESEQUENCE only: "${originalText}" → "${currentText}"`);
              }
            }
          }

          for (const [oldText, newText] of dynamicMap) {
            if (oldText !== newText) {
              chainedChanges.push({ oldText, newText, changeType: 'renumber' as const });
              logger.warn(`[Citation Management] Unchained dynamic change: "${oldText}" → "${newText}"`);
            }
          }

          changedCitationsWithType = chainedChanges;
          logger.debug(`[Citation Management] Final chained changes: ${changedCitationsWithType.map(c => `"${c.oldText}"→"${c.newText}"`).join(', ')}`);
        }
      }

      // Add renumber changes from deletion/reordering operations
      // IMPORTANT: RENUMBER changes with "orphaned" text take precedence over RESEQUENCE changes
      // because deletion happens AFTER initial resequencing
      // NOTE: Skip RENUMBER changes that were already used in RESEQUENCE+RENUMBER chaining above
      if (storedRenumberChanges.length > 0) {
        for (const change of storedRenumberChanges) {
          // Skip if this RENUMBER was already used during initial chaining
          if (usedRenumberBeforeTexts.has(change.beforeText)) {
            logger.info(`[Citation Management] Skipping already-chained RENUMBER: "${change.beforeText}" → "${change.afterText}"`);
            continue;
          }

          // Check if this is actually an orphaned citation (afterText contains "orphaned")
          // This happens when all reference numbers in a citation were deleted
          if (change.afterText.toLowerCase().includes('orphaned')) {
            // Treat as deletion, not renumber
            // Also REMOVE any existing entry for this citation from changedCitationsWithType
            // (e.g., from RESEQUENCE changes that are now obsolete after deletion)
            // FIX: Check c.newText (current text) against change.beforeText (also current text)
            const existingIndex = changedCitationsWithType.findIndex(c => c.newText === change.beforeText);
            if (existingIndex >= 0) {
              // FIX: Add ORIGINAL text (oldText) to orphanedCitations, not current text
              // Because we need to show the original DOCX text as orphaned in the export
              const originalText = changedCitationsWithType[existingIndex].oldText;
              logger.info(`[Citation Management] Removing obsolete change for orphaned citation: "${change.beforeText}" (original: "${originalText}")`);
              changedCitationsWithType.splice(existingIndex, 1);
              if (!orphanedCitations.includes(originalText)) {
                orphanedCitations.push(originalText);
                logger.info(`[Citation Management] Orphaned citation (original text): "${originalText}"`);
              }
            } else {
              // No RESEQUENCE entry, use current text directly (no swap happened for this citation)
              if (!orphanedCitations.includes(change.beforeText)) {
                orphanedCitations.push(change.beforeText);
                logger.info(`[Citation Management] Orphaned citation from RENUMBER change: "${change.beforeText}"`);
              }
            }
          } else {
            // Regular renumber change
            // FIX: Check c.newText (current text) against change.beforeText (also current text)
            const existingIndex = changedCitationsWithType.findIndex(c => c.newText === change.beforeText);
            if (existingIndex >= 0) {
              // Chain the changes: original → current → final
              // Existing: oldText=original, newText=current
              // RENUMBER: beforeText=current, afterText=final
              // Result: oldText=original, newText=final
              const existing = changedCitationsWithType[existingIndex];
              logger.info(`[Citation Management] Chaining RENUMBER: "${existing.oldText}" → "${change.beforeText}" → "${change.afterText}"`);
              existing.newText = change.afterText;
            } else {
              // No existing change for this citation, add new entry
              changedCitationsWithType.push({
                oldText: change.beforeText,
                newText: change.afterText,
                changeType: 'renumber' as const
              });
              logger.info(`[Citation Management] Adding renumber change: "${change.beforeText}" → "${change.afterText}"`);
            }
          }
        }
      }

      // IMPORTANT: Chain orphaned citations through renumber changes
      // If renumbering says "(1)" → "(4)" but "(4)" is orphaned (deleted),
      // then "(1)" should also be orphaned, not changed to "(4)"
      // This handles the case where a resequenced citation's target reference was later deleted
      // NOTE: Use a snapshot of orphanedCitations to avoid cascading chains
      // We only want to chain directly to deleted references, not through intermediate changes
      // FIX: Build set of valid final reference numbers to avoid collision
      // where orphaned "(1)" (original text) collides with valid current "(1)" (DB text)
      const validFinalRefs = new Set<string>();
      // Add non-orphan RENUMBER afterTexts
      for (const change of storedRenumberChanges) {
        if (!change.afterText.toLowerCase().includes('orphaned')) {
          validFinalRefs.add(change.afterText);
        }
      }
      // CRITICAL: Also add current DB citation texts as valid
      // This prevents collision when original orphaned text matches a valid current DB text
      document.citations.forEach(c => {
        if (c.rawText && !c.rawText.toLowerCase().includes('orphaned')) {
          validFinalRefs.add(c.rawText);
        }
      });
      logger.info(`[Citation Management] validFinalRefs: ${[...validFinalRefs].join(', ')}`);
      const originalOrphanedSet = new Set(orphanedCitations);
      for (let i = changedCitationsWithType.length - 1; i >= 0; i--) {
        const change = changedCitationsWithType[i];
        // Only chain if newText is orphaned AND NOT a valid final reference number
        // This prevents collision where "(1)" is both orphaned (old ref 1) and valid final (new ref 1)
        if (originalOrphanedSet.has(change.newText) && !validFinalRefs.has(change.newText)) {
          logger.info(`[Citation Management] Chaining orphan: "${change.oldText}" → "${change.newText}" (orphaned) → treating "${change.oldText}" as orphaned`);
          // Remove from changedCitationsWithType
          changedCitationsWithType.splice(i, 1);
          // Add oldText to orphanedCitations
          if (!orphanedCitations.includes(change.oldText)) {
            orphanedCitations.push(change.oldText);
          }
        }
      }

      // Merge style conversion changes with renumbering changes
      // IMPORTANT: Chain renumbering with style conversion
      // If renumbering says "(4)" → "(2)" and style says "(2)" → "(Author, Year)"
      // Then we need "(4)" → "(Author, Year)" directly
      if (storedCitationConversions.length > 0) {
        logger.info(`[Citation Management] Found ${storedCitationConversions.length} in-text citation style conversions`);

        // Build a map of new number → author-year format
        const styleMap = new Map<string, string>();
        for (const conversion of storedCitationConversions) {
          styleMap.set(conversion.beforeText, conversion.afterText);
          logger.info(`[Citation Management] Style map: "${conversion.beforeText}" → "${conversion.afterText}"`);
        }

        // Update renumbering changes to chain with style conversion
        // Check BOTH oldText and newText for style conversion matches
        for (let i = 0; i < changedCitationsWithType.length; i++) {
          const change = changedCitationsWithType[i];
          // First try newText (for chained: renumber then style)
          let styleConversion = styleMap.get(change.newText);
          let matchedKey = change.newText;

          // Also try oldText (for direct style conversion match)
          if (!styleConversion) {
            styleConversion = styleMap.get(change.oldText);
            matchedKey = change.oldText;
          }

          if (styleConversion) {
            logger.info(`[Citation Management] Chaining via "${matchedKey}": "${change.oldText}" → "${styleConversion}"`);
            changedCitationsWithType[i] = {
              oldText: change.oldText,
              newText: styleConversion,
              changeType: 'style_conversion'
            };
            // Remove from styleMap since it's been used
            styleMap.delete(matchedKey);
          }
        }

        // Add remaining style conversions (for citations that weren't renumbered)
        const existingOldTexts = new Set(changedCitationsWithType.map(c => c.oldText));
        for (const [beforeText, afterText] of styleMap) {
          if (!existingOldTexts.has(beforeText)) {
            changedCitationsWithType.push({
              oldText: beforeText,
              newText: afterText,
              changeType: 'style_conversion'
            });
            logger.info(`[Citation Management] Adding direct style conversion: "${beforeText}" → "${afterText}"`);
          }
        }
      }

      // Add reference edit changes (author-year citation text edits)
      // These should override any existing changes for the same citation
      if (storedReferenceEditChanges.length > 0) {
        for (const editChange of storedReferenceEditChanges) {
          // Check if this citation was already in changedCitationsWithType (from style conversion or renumber)
          const existingIndex = changedCitationsWithType.findIndex(c => c.oldText === editChange.beforeText);
          if (existingIndex >= 0) {
            // Update the existing change to point to the new author-year text
            changedCitationsWithType[existingIndex] = {
              ...changedCitationsWithType[existingIndex],
              newText: editChange.afterText,
              changeType: 'style_conversion'
            };
            logger.info(`[Citation Management] Updated existing change: "${editChange.beforeText}" → "${editChange.afterText}"`);
          } else {
            // Also check if the beforeText appears as a newText (chained change)
            const chainedIndex = changedCitationsWithType.findIndex(c => c.newText === editChange.beforeText);
            if (chainedIndex >= 0) {
              // Chain the changes: original → intermediate → new author-year
              changedCitationsWithType[chainedIndex] = {
                ...changedCitationsWithType[chainedIndex],
                newText: editChange.afterText,
                changeType: 'style_conversion'
              };
              logger.info(`[Citation Management] Chained reference edit: "${changedCitationsWithType[chainedIndex].oldText}" → "${editChange.afterText}"`);
            } else {
              // Add as new change
              changedCitationsWithType.push({
                oldText: editChange.beforeText,
                newText: editChange.afterText,
                changeType: 'style_conversion'
              });
              logger.info(`[Citation Management] Adding reference edit change: "${editChange.beforeText}" → "${editChange.afterText}"`);
            }
          }
        }
      }

      // Get stored reference deletion changes (for author-year citation deletions)
      const storedReferenceDeleteChanges = await prisma.citationChange.findMany({
        where: {
          documentId,
          changeType: 'REFERENCE_DELETE',
          isReverted: false
        }
      });

      // Add deletion changes to orphanedCitations array (these will be marked as deleted in DOCX)
      if (storedReferenceDeleteChanges.length > 0) {
        logger.info(`[Citation Management] Found ${storedReferenceDeleteChanges.length} reference deletion changes`);
        for (const deleteChange of storedReferenceDeleteChanges) {
          // Only add if not already in orphanedCitations
          if (!orphanedCitations.includes(deleteChange.beforeText)) {
            orphanedCitations.push(deleteChange.beforeText);
            logger.info(`[Citation Management] Adding orphaned citation from deletion: "${deleteChange.beforeText}"`);
          }
        }
      }

      // Determine if References section needs updating
      // Only update References section when:
      // 1. References have been reordered (oldToNewNumberMap has actual changes) - NUMERIC ONLY
      // 2. References have been deleted (deletedNumbers is not empty) - NUMERIC ONLY
      // 3. Style conversion is applied (hasStyleConversion is true)
      // 4. There are stored renumber changes from deletion/reordering operations
      // 5. There are stored reference delete changes (for numeric documents)
      // For REFERENCE_EDIT changes only (inline citation text edits), don't update References section
      // For AUTHOR-YEAR documents with deletions, don't rebuild References section (only strike through inline citations)
      const hasReordering = [...oldToNewNumberMap.entries()].some(([oldNum, newNum]) => oldNum !== newNum);
      // Only numeric documents need References section update for deletions (renumbering)
      // Author-year documents don't need renumbering - deletions are handled via inline citation strikethrough
      const hasNumericDeletions = deletedNumbers.size > 0;
      // Also check stored changes - these indicate prior operations that require reference section update
      const hasStoredRenumberChanges = storedRenumberChanges.length > 0;
      const hasStoredDeleteChanges = storedReferenceDeleteChanges.length > 0 && !isAuthorYearDocument;
      // Check for stored resequence changes from auto-resequencing during upload
      const hasStoredResequenceChanges = storedResequenceChanges.length > 0 && !isAuthorYearDocument;
      const needsReferenceSectionUpdate = hasReordering || hasNumericDeletions || hasStyleConversion || hasStoredRenumberChanges || hasStoredDeleteChanges || hasStoredResequenceChanges;

      logger.info(`[Citation Management] References section update check: hasReordering=${hasReordering}, hasNumericDeletions=${hasNumericDeletions}, hasStyleConversion=${hasStyleConversion}, hasStoredRenumberChanges=${hasStoredRenumberChanges}, hasStoredDeleteChanges=${hasStoredDeleteChanges}, hasStoredResequenceChanges=${hasStoredResequenceChanges}, isAuthorYear=${isAuthorYearDocument}, needsUpdate=${needsReferenceSectionUpdate}`);

      // Only pass currentReferences if References section needs updating
      // For author-year documents with only deletions/edits, don't rebuild References section
      const referencesToPass = needsReferenceSectionUpdate ? currentReferences : undefined;

      // For author-year documents, prepare selective reference section changes
      let authorYearRefChanges: {
        deletedRefTexts?: string[];
        editedRefs?: Array<{ oldText: string; newText: string }>;
      } | undefined;

      if (isAuthorYearDocument) {
        const deletedRefTexts: string[] = [];
        const editedRefs: Array<{ oldText: string; newText: string }> = [];

        // Collect deleted reference texts (use inline citation text to identify which ref was deleted)
        // The orphanedCitations array contains inline citation text like "(Marcus & Davis, 2019)"
        // We use this to match the corresponding reference entry in the References section
        for (const orphanedCitation of orphanedCitations) {
          deletedRefTexts.push(orphanedCitation);
          logger.info(`[Citation Management] Author-year deletion for References section: "${orphanedCitation}"`);
        }

        // Collect edited reference changes (REFERENCE_EDIT changes)
        // These contain oldText -> newText for inline citations which we use to update References section
        if (storedReferenceEditChanges.length > 0) {
          for (const editChange of storedReferenceEditChanges) {
            editedRefs.push({
              oldText: editChange.beforeText,
              newText: editChange.afterText
            });
            logger.info(`[Citation Management] Author-year edit for References section: "${editChange.beforeText}" → "${editChange.afterText}"`);
          }
        }

        if (deletedRefTexts.length > 0 || editedRefs.length > 0) {
          authorYearRefChanges = { deletedRefTexts, editedRefs };
          logger.info(`[Citation Management] Passing authorYearRefChanges: ${deletedRefTexts.length} deletions, ${editedRefs.length} edits`);
        }
      }

      // DEBUG: Log what we're passing to the DOCX processor
      logger.debug(`[Citation Management] Calling replaceCitationsWithTrackChanges with:`);
      logger.debug(`[Citation Management] changedCitationsWithType (${changedCitationsWithType.length}):`);
      changedCitationsWithType.forEach((c, i) => {
        logger.debug(`[Citation Management]   [${i}] "${c.oldText}" → "${c.newText}" (${c.changeType})`);
      });
      logger.debug(`[Citation Management] orphanedCitations (${orphanedCitations.length}): ${orphanedCitations.join(', ')}`);
      logger.debug(`[Citation Management] referencesToPass: ${referencesToPass ? referencesToPass.length + ' refs' : 'undefined'}`);

      // Apply replacements with Track Changes enabled (or clean export if acceptChanges is true)
      const { buffer: modifiedBuffer, summary } = await docxProcessorService.replaceCitationsWithTrackChanges(
        originalBuffer,
        changedCitationsWithType,
        orphanedCitations,
        referencesToPass,
        authorYearRefChanges,
        acceptChanges  // Pass acceptChanges flag - if true, apply changes cleanly without track changes markup
      );

      // Log summary
      logger.info(`[Citation Management] Export Summary (${acceptChanges ? 'clean' : 'track changes'}):`);
      logger.info(`  - Total citations processed: ${summary.totalCitations}`);
      logger.info(`  - Changed: ${summary.changed.map(c => `${c.from}→${c.to} (${c.count}x)`).join(', ')}`);
      logger.info(`  - Orphaned: ${summary.orphaned.map(o => `${o.text} (${o.count}x)`).join(', ')}`);
      logger.info(`  - References reordered: ${summary.referencesReordered}`);
      logger.info(`  - References deleted: ${summary.referencesDeleted}`);

      // Send modified DOCX to client
      const downloadFilename = acceptChanges
        ? `${document.originalName.replace('.docx', '')}_corrected.docx`
        : `${document.originalName.replace('.docx', '')}_tracked_changes.docx`;

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename="${downloadFilename}"`);
      res.setHeader('Content-Length', modifiedBuffer.length);
      // Include summary in custom header for frontend
      // Sanitize non-ASCII characters (en-dash, em-dash, arrows) for HTTP header compatibility
      const sanitizedSummary = JSON.stringify(summary)
        .replace(/–/g, '-')   // en-dash (U+2013) to hyphen
        .replace(/—/g, '-')   // em-dash (U+2014) to hyphen
        .replace(/→/g, '->')  // arrow (U+2192) to ASCII arrow
        .replace(/←/g, '<-')  // left arrow (U+2190) to ASCII
        .replace(/[^\x00-\x7F]/g, ''); // Remove any remaining non-ASCII characters
      res.setHeader('X-Citation-Summary', sanitizedSummary);

      res.send(modifiedBuffer);

      logger.info(`[Citation Management] Successfully exported DOCX with Track Changes`);
    } catch (error) {
      logger.error('[Citation Management] Export failed:', error);
      next(error);
    }
  }

  /**
   * GET /api/v1/citation/document/:documentId/preview
   * Preview the changes that will be applied on export - returns JSON for frontend display
   *
   * WORKING VERSION - 2026-02-14
   * Fixed: Orphan handling, RESEQUENCE+RENUMBER chaining, validFinalRefs protection
   * Key fixes:
   * - Step 3: Track usedRenumberBeforeTexts during RESEQUENCE+RENUMBER chaining
   * - Step 4: Look up original DOCX text from RESEQUENCE (not changedCitationsWithType)
   * - Step 4: Use validFinalRefs to prevent orphan collision with current DB texts
   * - Unchanged citations: Properly trace back through RENUMBER→RESEQUENCE to find original text
   */
  async previewChanges(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;

      logger.info(`[Citation Management] Preview changes for document ${documentId}`);

      // Get document with citations and references
      const document = await prisma.editorialDocument.findUnique({
        where: { id: documentId },
        include: {
          citations: true,
          referenceListEntries: {
            orderBy: { sortKey: 'asc' }
          }
        }
      });

      if (!document) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' }
        });
        return;
      }

      // Get stored changes from CitationChange table - use the same chaining logic as export
      const storedResequenceChanges = await prisma.citationChange.findMany({
        where: { documentId, changeType: 'RESEQUENCE', isReverted: false }
      });
      const storedRenumberChanges = await prisma.citationChange.findMany({
        where: { documentId, changeType: 'RENUMBER', isReverted: false }
      });
      const storedReferenceDeleteChanges = await prisma.citationChange.findMany({
        where: { documentId, changeType: 'REFERENCE_DELETE', isReverted: false }
      });
      // Get STYLE_CONVERSION changes for in-text citations
      const storedStyleConversionChanges = await prisma.citationChange.findMany({
        where: { documentId, changeType: 'STYLE_CONVERSION', isReverted: false }
      });
      // Get REFERENCE_STYLE_CONVERSION changes for reference list items
      const storedReferenceStyleChanges = await prisma.citationChange.findMany({
        where: { documentId, changeType: 'REFERENCE_STYLE_CONVERSION', isReverted: false }
      });

      logger.debug(`[Citation Management] Preview - RESEQUENCE: ${storedResequenceChanges.length}, RENUMBER: ${storedRenumberChanges.length}, DELETE: ${storedReferenceDeleteChanges.length}, STYLE_CONVERSION: ${storedStyleConversionChanges.length}, REF_STYLE: ${storedReferenceStyleChanges.length}`);

      // Use the SAME logic as export to compute changes
      // Step 1: Build oldToNewNumberMap from current citations (same as export)
      const oldToNewNumberMap = new Map<number, number>();
      const deletedNumbers = new Set<number>();

      // PASS 1: Build mapping from SINGLE-NUMBER citations
      // Use extractNumbersFromCitation to properly expand ranges like [3-5] → [3,4,5]
      document.referenceListEntries.forEach((ref, index) => {
        const newNumber = index + 1;
        if (ref.citationIds && ref.citationIds.length > 0) {
          const linkedCitations = document.citations.filter(c => ref.citationIds.includes(c.id));
          for (const citation of linkedCitations) {
            if (citation.rawText) {
              const numbers = this.extractNumbersFromCitation(citation.rawText);
              if (numbers.length === 1) {
                const oldNum = numbers[0];
                if (!oldToNewNumberMap.has(oldNum)) {
                  oldToNewNumberMap.set(oldNum, newNumber);
                }
              }
            }
          }
        }
      });

      // PASS 2: Handle multi-number citations
      // Use extractNumbersFromCitation to properly expand ranges like [3-5] → [3,4,5]
      document.referenceListEntries.forEach((ref, index) => {
        const newNumber = index + 1;
        const alreadyMapped = [...oldToNewNumberMap.entries()].some(([_, newNum]) => newNum === newNumber);
        if (alreadyMapped) return;
        if (ref.citationIds && ref.citationIds.length > 0) {
          const linkedCitations = document.citations.filter(c => ref.citationIds.includes(c.id));
          for (const citation of linkedCitations) {
            if (citation.rawText) {
              const numbers = this.extractNumbersFromCitation(citation.rawText);
              for (const oldNum of numbers) {
                if (!oldToNewNumberMap.has(oldNum)) {
                  oldToNewNumberMap.set(oldNum, newNumber);
                  break;
                }
              }
            }
          }
        }
      });

      // Find deleted numbers
      // Use extractNumbersFromCitation to properly expand ranges like [3-5] → [3,4,5]
      document.citations.forEach(citation => {
        if (citation.rawText) {
          const numbers = this.extractNumbersFromCitation(citation.rawText);
          numbers.forEach(oldNum => {
            if (!oldToNewNumberMap.has(oldNum)) {
              deletedNumbers.add(oldNum);
            }
          });
        }
      });

      logger.debug(`[Citation Management] Preview - oldToNewNumberMap: ${[...oldToNewNumberMap.entries()].map(([o, n]) => `${o}→${n}`).join(', ')}`);
      logger.debug(`[Citation Management] Preview - deletedNumbers: ${[...deletedNumbers].join(', ')}`);

      // Step 2: Build dynamic changes (current text changes based on number mapping)
      let changedCitationsWithType: Array<{ oldText: string; newText: string; changeType: string }> = [];
      const orphanedCitations: string[] = [];

      // Helper to update citation text with new numbers
      const updateCitationText = (text: string, numberMap: Map<number, number>, deleted: Set<number>): { newText: string; hasDeleted: boolean } => {
        let newText = text;
        let hasDeleted = false;
        const numbers = text.match(/\d+/g) || [];
        for (const numStr of numbers) {
          const oldNum = parseInt(numStr);
          if (deleted.has(oldNum)) {
            hasDeleted = true;
          } else if (numberMap.has(oldNum)) {
            const newNum = numberMap.get(oldNum)!;
            if (oldNum !== newNum) {
              newText = newText.replace(new RegExp(`\\b${oldNum}\\b`), String(newNum));
            }
          }
        }
        return { newText, hasDeleted };
      };

      // Build dynamic changes from current citations
      const dynamicProcessedTexts = new Set<string>();
      for (const citation of document.citations) {
        if (!citation.rawText || dynamicProcessedTexts.has(citation.rawText)) continue;
        dynamicProcessedTexts.add(citation.rawText);

        const { newText, hasDeleted } = updateCitationText(citation.rawText, oldToNewNumberMap, deletedNumbers);
        if (hasDeleted) {
          // This will be handled via RESEQUENCE chaining
        } else if (newText !== citation.rawText) {
          changedCitationsWithType.push({
            oldText: citation.rawText,
            newText: newText,
            changeType: 'renumber'
          });
        }
      }

      logger.debug(`[Citation Management] Preview - Dynamic changes: ${changedCitationsWithType.map(c => `"${c.oldText}"→"${c.newText}"`).join(', ')}`);

      // Step 3: Use stored RENUMBER changes (authoritative) instead of dynamic changes
      // IMPORTANT: After deletion, citation rawText has ALREADY been updated in database,
      // so dynamic mapping from current data gives wrong results (maps 2→2, 3→3, etc.)
      // The stored RENUMBER records contain the correct before/after mapping.

      // Track which RENUMBER changes are used during initial chaining (to skip later)
      const usedRenumberBeforeTexts = new Set<string>();

      // Get non-orphaned RENUMBER changes (these are the primary source of truth)
      const renumberChangesForChaining = storedRenumberChanges.filter(
        c => !c.afterText.toLowerCase().includes('orphaned')
      );

      // If we have RENUMBER records (from deletion/reorder), use them directly
      // This takes precedence over dynamic changes which are computed from already-updated data
      if (renumberChangesForChaining.length > 0) {
        logger.debug(`[Citation Management] Preview - Using stored RENUMBER records (${renumberChangesForChaining.length} non-orphaned)`);

        // Build map from RENUMBER records (DON'T add to usedRenumberBeforeTexts yet - only when actually used)
        const renumberMap = new Map<string, string>();
        for (const change of renumberChangesForChaining) {
          renumberMap.set(change.beforeText, change.afterText);
        }
        logger.debug(`[Citation Management] Preview - RENUMBER map: ${[...renumberMap.entries()].map(([o, n]) => `"${o}"→"${n}"`).join(', ')}`);

        // If we have RESEQUENCE changes, chain them with RENUMBER
        if (storedResequenceChanges.length > 0) {
          const chainedChanges: Array<{ oldText: string; newText: string; changeType: string }> = [];

          for (const reseq of storedResequenceChanges) {
            const originalText = reseq.beforeText;  // Original DOCX text
            const oldDbText = reseq.afterText;      // DB text at upload time

            const newDbText = renumberMap.get(oldDbText);
            if (newDbText !== undefined) {
              // Chain: RESEQUENCE + RENUMBER - mark as used
              usedRenumberBeforeTexts.add(oldDbText);
              if (originalText !== newDbText) {
                chainedChanges.push({ oldText: originalText, newText: newDbText, changeType: 'renumber' });
                logger.debug(`[Citation Management] Preview - Chained: "${originalText}" → "${oldDbText}" → "${newDbText}"`);
              }
            } else {
              // No RENUMBER for this, use RESEQUENCE directly
              if (originalText !== oldDbText) {
                chainedChanges.push({ oldText: originalText, newText: oldDbText, changeType: 'renumber' });
                logger.debug(`[Citation Management] Preview - RESEQUENCE only: "${originalText}" → "${oldDbText}"`);
              }
            }
          }

          // Add remaining RENUMBER changes not used in chaining
          for (const [oldText, newText] of renumberMap) {
            if (!usedRenumberBeforeTexts.has(oldText)) {
              if (oldText !== newText) {
                chainedChanges.push({ oldText, newText, changeType: 'renumber' });
                logger.debug(`[Citation Management] Preview - RENUMBER only: "${oldText}" → "${newText}"`);
              }
              usedRenumberBeforeTexts.add(oldText);
            }
          }

          changedCitationsWithType = chainedChanges;
        } else {
          // No RESEQUENCE, use RENUMBER records directly
          const renumberChanges: Array<{ oldText: string; newText: string; changeType: string }> = [];
          for (const [oldText, newText] of renumberMap) {
            if (oldText !== newText) {
              renumberChanges.push({ oldText, newText, changeType: 'renumber' });
              usedRenumberBeforeTexts.add(oldText);
              logger.debug(`[Citation Management] Preview - RENUMBER (direct): "${oldText}" → "${newText}"`);
            }
          }
          changedCitationsWithType = renumberChanges;
        }

        logger.debug(`[Citation Management] Preview - Changes from RENUMBER: ${changedCitationsWithType.map(c => `"${c.oldText}"→"${c.newText}"`).join(', ')}`);
      } else if (storedResequenceChanges.length > 0) {
        // RESEQUENCE changes only (no RENUMBER) - use RESEQUENCE directly
        // Check which RESEQUENCE entries are still valid in current DB
        const currentDbTexts = new Set<string>();
        document.citations.forEach(c => {
          if (c.rawText) currentDbTexts.add(c.rawText);
        });
        logger.debug(`[Citation Management] Preview - Current DB texts: ${[...currentDbTexts].join(', ')}`);

        const chainedChanges: Array<{ oldText: string; newText: string; changeType: string }> = [];

        for (const reseq of storedResequenceChanges) {
          const originalText = reseq.beforeText;
          const dbTextAtUpload = reseq.afterText;

          if (currentDbTexts.has(dbTextAtUpload)) {
            // Still valid
            if (originalText !== dbTextAtUpload) {
              chainedChanges.push({ oldText: originalText, newText: dbTextAtUpload, changeType: 'renumber' });
              logger.debug(`[Citation Management] Preview - RESEQUENCE (valid): "${originalText}" → "${dbTextAtUpload}"`);
            }
          } else {
            // Orphaned - add to orphanedCitations
            if (!orphanedCitations.includes(originalText)) {
              orphanedCitations.push(originalText);
              logger.debug(`[Citation Management] Preview - RESEQUENCE (orphaned): "${originalText}" → "${dbTextAtUpload}" - marking as orphaned`);
            }
          }
        }

        changedCitationsWithType = chainedChanges;
        logger.debug(`[Citation Management] Preview - Final RESEQUENCE-only changes: ${changedCitationsWithType.map(c => `"${c.oldText}"→"${c.newText}"`).join(', ')}`);
      }

      // Step 4: Handle orphaned citations from RENUMBER and DELETE changes

      // Build validFinalRefs set - same logic as export
      const validFinalRefs = new Set<string>();
      // Add non-orphan RENUMBER afterTexts
      for (const change of storedRenumberChanges) {
        if (!change.afterText.toLowerCase().includes('orphaned')) {
          validFinalRefs.add(change.afterText);
        }
      }
      // CRITICAL: Also add current DB citation texts as valid
      document.citations.forEach(c => {
        if (c.rawText && !c.rawText.toLowerCase().includes('orphaned')) {
          validFinalRefs.add(c.rawText);
        }
      });
      logger.debug(`[Citation Management] Preview - Valid final refs: ${[...validFinalRefs].join(', ')}`);

      for (const change of storedRenumberChanges) {
        // Skip already-chained RENUMBER changes (same as export)
        if (usedRenumberBeforeTexts.has(change.beforeText)) {
          logger.debug(`[Citation Management] Preview - Skipping already-chained RENUMBER: "${change.beforeText}" → "${change.afterText}"`);
          continue;
        }

        if (change.afterText.toLowerCase().includes('orphaned')) {
          // Find the original DOCX text via RESEQUENCE
          // change.beforeText is the OLD DB text that became orphaned
          const reseqEntry = storedResequenceChanges.find(r => r.afterText === change.beforeText);
          const originalText = reseqEntry ? reseqEntry.beforeText : change.beforeText;

          logger.debug(`[Citation Management] Preview - Orphan RENUMBER: DB "${change.beforeText}" → "${change.afterText}", original DOCX: "${originalText}"`);

          // Check if this is a valid current DB text (prevent orphan collision)
          if (validFinalRefs.has(change.beforeText) && !reseqEntry) {
            logger.debug(`[Citation Management] Preview - Skipping orphan for valid current ref: "${change.beforeText}"`);
            continue;
          }

          // Remove the RESEQUENCE-only entry that was not chained (because orphan was filtered)
          // Match by BOTH newText and oldText to avoid removing wrong entries
          const existingIdx = changedCitationsWithType.findIndex(
            c => c.newText === change.beforeText && c.oldText === originalText
          );
          if (existingIdx >= 0) {
            changedCitationsWithType.splice(existingIdx, 1);
            logger.debug(`[Citation Management] Preview - Removed stale entry: "${originalText}" → "${change.beforeText}"`);
          }

          if (!orphanedCitations.includes(originalText)) {
            orphanedCitations.push(originalText);
            logger.debug(`[Citation Management] Preview - Added orphan: "${originalText}"`);
          }
        } else {
          // Regular renumber change (not orphaned)
          // Check if there's an existing change entry to chain with
          const existingIdx = changedCitationsWithType.findIndex(c => c.newText === change.beforeText);
          if (existingIdx >= 0) {
            // Chain the changes: original → current → final
            const existing = changedCitationsWithType[existingIdx];
            logger.debug(`[Citation Management] Preview - Chaining non-orphan RENUMBER: "${existing.oldText}" → "${change.beforeText}" → "${change.afterText}"`);
            existing.newText = change.afterText;
          } else {
            // No existing change, add as new entry
            if (change.beforeText !== change.afterText) {
              changedCitationsWithType.push({
                oldText: change.beforeText,
                newText: change.afterText,
                changeType: 'renumber'
              });
              logger.debug(`[Citation Management] Preview - Adding non-chained RENUMBER: "${change.beforeText}" → "${change.afterText}"`);
            }
          }
        }
      }

      for (const deleteChange of storedReferenceDeleteChanges) {
        const reseqEntry = storedResequenceChanges.find(r => r.afterText === deleteChange.beforeText);
        const originalText = reseqEntry ? reseqEntry.beforeText : deleteChange.beforeText;
        if (!orphanedCitations.includes(originalText)) {
          orphanedCitations.push(originalText);
        }
      }

      // Filter out no-op changes
      changedCitationsWithType = changedCitationsWithType.filter(c => c.oldText !== c.newText);

      logger.debug(`[Citation Management] Preview - Final changes: ${changedCitationsWithType.map(c => `"${c.oldText}"→"${c.newText}"`).join(', ')}`);
      logger.debug(`[Citation Management] Preview - Orphaned: ${orphanedCitations.join(', ')}`);

      // Build preview data
      const citationPreviews: Array<{
        id: string;
        originalText: string;
        newText: string;
        changeType: string;
        isOrphaned: boolean;
        referenceNumber: number | null;
      }> = [];

      const processedTexts = new Set<string>();

      // IMPORTANT: Add STYLE_CONVERSION changes FIRST (they take priority over renumber)
      // Style conversion changes represent the final intended format (e.g., Vancouver → APA)
      for (const styleChange of storedStyleConversionChanges) {
        if (processedTexts.has(styleChange.beforeText)) continue;
        processedTexts.add(styleChange.beforeText);
        // Also mark afterText as processed to prevent duplicate in unchanged citations loop
        processedTexts.add(styleChange.afterText);

        // After style conversion, the citation's rawText has been updated to afterText
        // So we need to search by afterText to find the citation, not beforeText
        const citation = document.citations.find(c => c.rawText === styleChange.afterText);
        citationPreviews.push({
          id: citation?.id || '',
          originalText: styleChange.beforeText,
          newText: styleChange.afterText,
          changeType: 'style',
          isOrphaned: false,
          referenceNumber: citation?.referenceNumber || null
        });
        logger.debug(`[Citation Management] Preview - Style conversion: "${styleChange.beforeText}" → "${styleChange.afterText}"`);
      }

      // Add changed citations (renumber changes) - only for citations not already processed by style conversion
      for (const change of changedCitationsWithType) {
        if (processedTexts.has(change.oldText)) continue;
        processedTexts.add(change.oldText);

        const citation = document.citations.find(c => c.rawText === change.newText);
        citationPreviews.push({
          id: citation?.id || '',
          originalText: change.oldText,
          newText: change.newText,
          changeType: change.changeType,
          isOrphaned: false,
          referenceNumber: citation?.referenceNumber || null
        });
      }

      // Add orphaned citations
      for (const orphanedText of orphanedCitations) {
        if (processedTexts.has(orphanedText)) continue;
        processedTexts.add(orphanedText);

        citationPreviews.push({
          id: '',
          originalText: orphanedText,
          newText: orphanedText,
          changeType: 'deleted',
          isOrphaned: true,
          referenceNumber: null
        });
      }

      // Add unchanged citations (those not already in changed or orphaned)
      for (const citation of document.citations) {
        if (!citation.rawText) continue;

        // Find original DOCX text via RESEQUENCE changes
        // RESEQUENCE maps: original DOCX text (beforeText) → DB text at upload (afterText)
        // We need to find the RESEQUENCE where the chain leads to this citation's current text
        let originalText = citation.rawText;

        // First, check if there's a RESEQUENCE that directly maps to current text
        // (for citations that weren't affected by RENUMBER)
        const directReseq = storedResequenceChanges.find(r => r.afterText === citation.rawText);
        if (directReseq) {
          originalText = directReseq.beforeText;
        } else {
          // For chained changes, we need to trace back through RENUMBER
          // Find RENUMBER where afterText === citation.rawText to get the oldDbText
          const renumberToThis = storedRenumberChanges.find(
            r => r.afterText === citation.rawText && !r.afterText.toLowerCase().includes('orphaned')
          );
          if (renumberToThis) {
            // Now find RESEQUENCE where afterText === renumberToThis.beforeText
            const chainedReseq = storedResequenceChanges.find(r => r.afterText === renumberToThis.beforeText);
            if (chainedReseq) {
              originalText = chainedReseq.beforeText;
            }
          }
        }

        if (processedTexts.has(originalText)) continue;
        processedTexts.add(originalText);

        citationPreviews.push({
          id: citation.id,
          originalText: originalText,
          newText: citation.rawText,
          changeType: originalText !== citation.rawText ? 'renumber' : 'unchanged',
          isOrphaned: citation.referenceNumber === null,
          referenceNumber: citation.referenceNumber
        });
      }

      // Build reference previews using stored style conversion changes
      // Create a map of reference ID to style change for quick lookup
      // Note: citationId field is used to store the reference ID for REFERENCE_STYLE_CONVERSION changes
      const refStyleChangeMap = new Map<string, { beforeText: string; afterText: string }>();
      for (const change of storedReferenceStyleChanges) {
        if (change.citationId) {
          refStyleChangeMap.set(change.citationId, {
            beforeText: change.beforeText,
            afterText: change.afterText
          });
        }
      }

      const referencePreviews: Array<{
        id: string;
        position: number;
        authors: string[];
        year: string | null;
        title: string | null;
        originalText: string | null;
        convertedText: string | null;
        hasStyleChange: boolean;
        isDeleted: boolean;
        citationCount: number;
      }> = document.referenceListEntries.map((ref, index) => {
        const authors = Array.isArray(ref.authors) ? ref.authors as string[] : [];

        // Check if we have a stored style change for this reference
        const styleChange = refStyleChangeMap.get(ref.id);

        // Use stored change if available, otherwise construct from components
        let originalText: string;
        let convertedText: string | null;
        let hasStyleChange: boolean;

        if (styleChange) {
          // We have a stored style change - use it
          originalText = styleChange.beforeText;
          convertedText = styleChange.afterText;
          hasStyleChange = true;
          logger.debug(`[Citation Management] Preview - Ref ${ref.id} has style change: "${originalText.substring(0, 50)}..." → "${convertedText.substring(0, 50)}..."`);
        } else {
          // No stored change - use formattedApa or construct from components
          const componentText = `${authors.join(', ')} (${ref.year || 'n.d.'}). ${ref.title || 'Untitled'}`;
          originalText = componentText;
          convertedText = ref.formattedApa || null;
          hasStyleChange = false;
        }

        return {
          id: ref.id,
          position: index + 1,
          authors: authors,
          year: ref.year,
          title: ref.title,
          originalText: originalText,
          convertedText: convertedText,
          hasStyleChange: hasStyleChange,
          isDeleted: false,
          citationCount: ref.citationIds?.length || 0
        };
      });

      // Calculate summary statistics
      const styleChangedCitations = citationPreviews.filter(c => c.changeType === 'style').length;
      const styleChangedReferences = referencePreviews.filter(r => r.hasStyleChange).length;

      const summary = {
        totalCitations: document.citations.length,
        uniqueCitations: processedTexts.size,
        changedCitations: citationPreviews.filter(c => c.changeType !== 'unchanged').length,
        orphanedCitations: citationPreviews.filter(c => c.isOrphaned || c.changeType === 'deleted').length,
        totalReferences: document.referenceListEntries.length,
        hasStyleConversion: !!document.referenceListStyle && (styleChangedCitations > 0 || styleChangedReferences > 0),
        styleChangedCitations: styleChangedCitations,
        styleChangedReferences: styleChangedReferences,
        targetStyle: document.referenceListStyle
      };

      // Group changes for display
      const changesByType = {
        renumber: citationPreviews.filter(c => c.changeType === 'renumber').map(c => ({
          from: c.originalText,
          to: c.newText
        })),
        style: citationPreviews.filter(c => c.changeType === 'style').map(c => ({
          from: c.originalText,
          to: c.newText
        })),
        deleted: citationPreviews.filter(c => c.changeType === 'deleted').map(c => ({
          text: c.originalText
        })),
        unchanged: citationPreviews.filter(c => c.changeType === 'unchanged').length
      };

      res.json({
        success: true,
        data: {
          documentId,
          filename: document.originalName,
          detectedStyle: document.referenceListStyle,
          summary,
          changes: changesByType,
          citations: citationPreviews,
          references: referencePreviews,
          documentText: document.fullText?.substring(0, 5000) || null, // First 5000 chars of document
          hasMoreText: (document.fullText?.length || 0) > 5000
        }
      });

    } catch (error) {
      logger.error('[Citation Management] Preview failed:', error);
      next(error);
    }
  }

  /**
   * GET /api/v1/citation/document/:documentId/export-debug
   * Debug endpoint to check what export would do - shows database state AND DOCX content
   */
  async exportDebug(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;

      const document = await prisma.editorialDocument.findUnique({
        where: { id: documentId },
        include: {
          citations: true,
          referenceListEntries: {
            orderBy: { sortKey: 'asc' }
          }
        }
      });

      if (!document) {
        res.status(404).json({ success: false, error: { message: 'Document not found' } });
        return;
      }

      const hasStyleConversion = document.referenceListStyle &&
        document.referenceListEntries.some(ref => ref.formattedApa);

      // Try to read the original DOCX and extract reference section
      interface DocxRef { paraNum: number; firstAuthor: string; text: string }
      let docxInfo: { available: boolean; error?: string; refSectionFound?: boolean; docxReferences?: DocxRef[]; rawParagraphs?: string[] } = { available: false };
      try {
        const fs = await import('fs/promises');
        const path = await import('path');
        const JSZip = await import('jszip');

        const filePath = path.join(process.cwd(), 'uploads', document.storagePath);
        const fileBuffer = await fs.readFile(filePath);

        const zip = await JSZip.loadAsync(fileBuffer);
        const documentXML = await zip.file('word/document.xml')?.async('string');

        if (documentXML) {
          // Find References section
          const refPatterns = [
            /<w:t[^>]*>References<\/w:t>/i,
            /<w:t[^>]*>Bibliography<\/w:t>/i,
            /<w:t[^>]*>Works Cited<\/w:t>/i,
          ];

          let refSectionFound = false;
          let refSectionStart = -1;

          for (const pattern of refPatterns) {
            const match = documentXML.match(pattern);
            if (match && match.index !== undefined) {
              refSectionFound = true;
              refSectionStart = match.index;
              break;
            }
          }

          // Extract reference paragraphs from DOCX
          const docxReferences: Array<{ paraNum: number; text: string; firstAuthor: string | null }> = [];
          const rawParagraphs: string[] = []; // Store raw paragraph texts for debugging

          if (refSectionFound) {
            const refsXML = documentXML.substring(refSectionStart);
            const paragraphRegex = /<w:p[^>]*>[\s\S]*?<\/w:p>/g;
            const paragraphs = refsXML.match(paragraphRegex) || [];

            let refNum = 0;
            for (let i = 0; i < Math.min(paragraphs.length, 15); i++) { // Limit to first 15 paragraphs for debug
              const para = paragraphs[i];
              const textMatches = para.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || [];
              const fullText = textMatches
                .map(t => t.replace(/<w:t[^>]*>([^<]*)<\/w:t>/, '$1'))
                .join('').trim();

              // Store all non-empty paragraphs for raw debug
              if (fullText) {
                rawParagraphs.push(fullText.substring(0, 200) + (fullText.length > 200 ? '...' : ''));
              }

              // Skip the "References" header and empty paragraphs
              if (fullText && !fullText.match(/^(References|Bibliography|Works Cited)$/i)) {
                // Check if it looks like a reference (numbered OR unnumbered)
                const numMatch = fullText.match(/^(\d+)[\.\)\]\s\t]/);
                const authorMatch = fullText.match(/^([A-Z][a-z]+)/); // First word starting with capital

                // Include if: numbered reference, OR starts with author name and has year
                const looksLikeRef = numMatch ||
                  (authorMatch && /\d{4}/.test(fullText)) ||
                  /^[A-Z][a-z]+\s+[A-Z]{1,3}\./.test(fullText);

                if (looksLikeRef) {
                  refNum++;
                  // Extract first author
                  let firstAuthor: string | null = null;
                  if (numMatch) {
                    const afterNum = fullText.substring(numMatch[0].length).trim();
                    const afterNumAuthorMatch = afterNum.match(/^([A-Za-z]+)/);
                    firstAuthor = afterNumAuthorMatch ? afterNumAuthorMatch[1] : null;
                  } else if (authorMatch) {
                    firstAuthor = authorMatch[1];
                  }

                  docxReferences.push({
                    paraNum: refNum,
                    text: fullText.substring(0, 150) + (fullText.length > 150 ? '...' : ''),
                    firstAuthor
                  });
                }
              }
            }
          }

          docxInfo = {
            available: true,
            refSectionFound,
            docxReferenceCount: docxReferences.length,
            docxReferences,
            rawParagraphs // Show raw text of all paragraphs in References section for debugging
          };
        }
      } catch (docxError: unknown) {
        const errorMessage = docxError instanceof Error ? docxError.message : 'Unknown error';
        docxInfo = { available: false, error: errorMessage };
      }

      // Build matching preview - how would refs match?
      const matchingPreview = document.referenceListEntries.map((ref, idx) => {
        const authorsArray = Array.isArray(ref.authors) ? ref.authors as string[] : [];
        const dbAuthorLastName = authorsArray.length > 0 && authorsArray[0]
          ? String(authorsArray[0]).split(/[,\s]/)[0]
          : 'UNKNOWN';

        // Try to find matching DOCX reference
        let matchedDocxRef: DocxRef | undefined = undefined;
        if (docxInfo.available && docxInfo.docxReferences) {
          matchedDocxRef = docxInfo.docxReferences.find((dr) => {
            if (!dr.firstAuthor) return false;
            return dr.firstAuthor.toLowerCase() === dbAuthorLastName.toLowerCase();
          });
        }

        return {
          dbPosition: idx + 1,
          dbSortKey: ref.sortKey,
          dbAuthor: dbAuthorLastName,
          matchedDocxPara: matchedDocxRef?.paraNum || null,
          matchStatus: matchedDocxRef ? 'MATCHED' : 'NO_MATCH'
        };
      });

      res.json({
        success: true,
        data: {
          documentId,
          referenceListStyle: document.referenceListStyle,
          hasStyleConversion,
          database: {
            referencesCount: document.referenceListEntries.length,
            citationsCount: document.citations.length,
            references: document.referenceListEntries.map((ref, idx) => ({
              id: ref.id,
              position: idx + 1,
              sortKey: ref.sortKey,
              authors: ref.authors,
              citationIds: ref.citationIds,
              formattedApa: ref.formattedApa?.substring(0, 100) || null
            }))
          },
          docx: docxInfo,
          matchingPreview,
          diagnosis: {
            phase3WillExecute: document.referenceListEntries.length > 0 && docxInfo.refSectionFound,
            allRefsMatched: matchingPreview.every(m => m.matchStatus === 'MATCHED'),
            unmatchedDbRefs: matchingPreview.filter(m => m.matchStatus === 'NO_MATCH').map(m => m.dbAuthor),
            unmatchedDocxRefs: docxInfo.available && docxInfo.docxReferences
              ? docxInfo.docxReferences.filter((dr) =>
                  !matchingPreview.some(m => m.matchedDocxPara === dr.paraNum)
                ).map((dr) => `Para ${dr.paraNum}: ${dr.firstAuthor}`)
              : []
          }
        }
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/v1/citation-management/document/:documentId/debug-style-conversion
   * Debug endpoint to test style conversion and verify formattedApa is saved
   * This is SEPARATE from main conversion to avoid changing existing functionality
   */
  async debugStyleConversion(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const { targetStyle } = req.body;

      if (!targetStyle) {
        res.status(400).json({
          success: false,
          error: { message: 'targetStyle is required in request body' }
        });
        return;
      }

      logger.info(`[Debug Style Conversion] Testing conversion for ${documentId} to ${targetStyle}`);

      const document = await prisma.editorialDocument.findUnique({
        where: { id: documentId },
        include: {
          referenceListEntries: {
            orderBy: { sortKey: 'asc' }
          }
        }
      });

      if (!document) {
        res.status(404).json({ success: false, error: { message: 'Document not found' } });
        return;
      }

      // Step 1: Check current state BEFORE conversion
      const beforeState = document.referenceListEntries.map((ref, idx) => ({
        id: ref.id,
        position: idx + 1,
        authors: ref.authors,
        formattedApa: ref.formattedApa,
        hasFormattedApa: !!ref.formattedApa
      }));

      // Step 2: Prepare references for conversion (same as convertStyle)
      const references = document.referenceListEntries.map((r, index) => {
        const authors = Array.isArray(r.authors) ? r.authors as string[] : [];
        return {
          id: r.id,
          number: index + 1,
          rawText: r.formattedApa || `${authors.join(', ')} (${r.year}). ${r.title}`,
          components: {
            authors: authors,
            year: r.year || undefined,
            title: r.title || undefined,
            journal: r.journalName || undefined,
            volume: r.volume || undefined,
            issue: r.issue || undefined,
            pages: r.pages || undefined,
            doi: r.doi || undefined
          },
          citedBy: []
        };
      });

      logger.info(`[Debug Style Conversion] Prepared ${references.length} references for conversion`);
      references.forEach((ref, idx) => {
        logger.info(`[Debug Style Conversion] Input ref ${idx + 1}: id=${ref.id}, rawText="${ref.rawText?.substring(0, 60)}..."`);
      });

      // Step 3: Call AI conversion
      const result = await aiFormatConverterService.convertStyle(
        references,
        [], // No in-text citations for this debug
        targetStyle as CitationStyle
      );

      logger.info(`[Debug Style Conversion] AI returned ${result.convertedReferences.length} converted references`);

      // Step 4: Log what AI returned
      const conversionResults = result.convertedReferences.map((ref, idx) => {
        const originalRef = references[idx];
        return {
          index: idx,
          inputId: originalRef?.id || 'MISSING',
          outputId: ref.id,
          idMatch: originalRef?.id === ref.id,
          inputRawText: originalRef?.rawText?.substring(0, 60) || 'MISSING',
          outputRawText: ref.rawText?.substring(0, 60) || 'EMPTY',
          hasOutputRawText: !!ref.rawText && ref.rawText.length > 0
        };
      });

      // Step 5: Attempt to save (simulate what convertStyle does)
      const saveResults: Array<{ id: string; success: boolean; error?: string }> = [];

      for (const ref of result.convertedReferences) {
        if (!ref.id || ref.id.startsWith('ref-')) {
          saveResults.push({
            id: ref.id,
            success: false,
            error: 'Invalid ID (generated fallback ID instead of database ID)'
          });
          continue;
        }

        if (!ref.rawText || ref.rawText.length === 0) {
          saveResults.push({
            id: ref.id,
            success: false,
            error: 'Empty rawText from AI conversion'
          });
          continue;
        }

        try {
          await prisma.referenceListEntry.update({
            where: { id: ref.id },
            data: { formattedApa: ref.rawText }
          });
          saveResults.push({ id: ref.id, success: true });
          logger.info(`[Debug Style Conversion] Saved formattedApa for ${ref.id}`);
        } catch (saveError: unknown) {
          const errorMessage = saveError instanceof Error ? saveError.message : 'Unknown error';
          saveResults.push({
            id: ref.id,
            success: false,
            error: errorMessage
          });
          logger.error(`[Debug Style Conversion] Failed to save ${ref.id}: ${errorMessage}`);
        }
      }

      // Step 6: Check state AFTER conversion
      const updatedDoc = await prisma.editorialDocument.findUnique({
        where: { id: documentId },
        include: {
          referenceListEntries: {
            orderBy: { sortKey: 'asc' }
          }
        }
      });

      const afterState = updatedDoc?.referenceListEntries.map((ref, idx) => ({
        id: ref.id,
        position: idx + 1,
        authors: ref.authors,
        formattedApa: ref.formattedApa,
        hasFormattedApa: !!ref.formattedApa
      })) || [];

      res.json({
        success: true,
        data: {
          documentId,
          targetStyle,
          beforeConversion: {
            referencesCount: beforeState.length,
            withFormattedApa: beforeState.filter(r => r.hasFormattedApa).length,
            references: beforeState
          },
          aiConversion: {
            inputCount: references.length,
            outputCount: result.convertedReferences.length,
            conversionResults
          },
          saveAttempts: {
            total: saveResults.length,
            successful: saveResults.filter(r => r.success).length,
            failed: saveResults.filter(r => !r.success).length,
            results: saveResults
          },
          afterConversion: {
            referencesCount: afterState.length,
            withFormattedApa: afterState.filter(r => r.hasFormattedApa).length,
            references: afterState
          },
          diagnosis: {
            allIdsMapped: conversionResults.every(r => r.idMatch),
            allHaveRawText: conversionResults.every(r => r.hasOutputRawText),
            allSaveSuccessful: saveResults.every(r => r.success),
            issues: [
              ...conversionResults.filter(r => !r.idMatch).map(r => `ID mismatch at index ${r.index}: input=${r.inputId}, output=${r.outputId}`),
              ...conversionResults.filter(r => !r.hasOutputRawText).map(r => `Empty rawText at index ${r.index}`),
              ...saveResults.filter(r => !r.success).map(r => `Save failed for ${r.id}: ${r.error}`)
            ]
          }
        }
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`[Debug Style Conversion] Error: ${errorMessage}`);
      next(error);
    }
  }

  /**
   * GET /api/v1/citation/styles
   * Get supported citation styles
   */
  async getStyles(req: Request, res: Response): Promise<void> {
    const styles = aiFormatConverterService.getSupportedStyles();

    res.json({
      success: true,
      data: {
        styles: styles.map(style => ({
          name: style,
          code: style.toLowerCase()
        }))
      }
    });
  }

  /**
   * Background: Analyze document citations
   */
  private async analyzeDocument(documentId: string, documentText: string): Promise<void> {
    try {
      await prisma.editorialDocument.update({
        where: { id: documentId },
        data: { status: 'ANALYZING' }
      });

      // Run AI analysis
      const analysis = await aiCitationDetectorService.analyzeDocument(documentText);

      logger.info(`[Citation Management] AI detected ${analysis.inTextCitations.length} citations, ${analysis.references.length} references`);

      // ============================================
      // FIX SEQUENCE MISMATCH: Get correct reference order from HTML
      // ============================================
      // AI may extract references in wrong order - use HTML <ol><li> as source of truth
      const documentRecord = await prisma.editorialDocument.findUnique({
        where: { id: documentId },
        select: { fullHtml: true }
      });

      let aiRefToHtmlPosition = new Map<number, number>();
      let htmlRefs: Array<{ position: number; text: string; firstAuthor?: string }> = [];

      if (documentRecord?.fullHtml) {
        htmlRefs = this.extractReferencesFromHtml(documentRecord.fullHtml);
        logger.info(`[Citation Management] Extracted ${htmlRefs.length} references from HTML for position mapping`);

        if (htmlRefs.length > 0) {
          // Create mapping from AI ref number to correct HTML position
          aiRefToHtmlPosition = this.matchReferencesToHtmlOrder(analysis.references, htmlRefs);
          logger.info(`[Citation Management] Created AI-to-HTML mapping for ${aiRefToHtmlPosition.size} references`);

          // Log the mapping for debugging
          for (const [aiNum, htmlPos] of aiRefToHtmlPosition.entries()) {
            const aiRef = analysis.references.find(r => r.number === aiNum);
            const htmlRef = htmlRefs.find(r => r.position === htmlPos);
            logger.info(`[Citation Management] AI ref ${aiNum} ("${aiRef?.components?.authors?.[0] || 'unknown'}") → HTML pos ${htmlPos} ("${htmlRef?.text.substring(0, 50)}...")`);
          }
        }
      }

      // ============================================
      // FALLBACK: Use HTML references when AI returns 0
      // ============================================
      // AI often fails to extract references from Vancouver-style documents
      // Use HTML-extracted references as fallback
      if (analysis.references.length === 0 && htmlRefs.length > 0) {
        logger.info(`[Citation Management] AI returned 0 references - using ${htmlRefs.length} HTML-extracted references as fallback`);

        // Convert HTML refs to analysis.references format
        analysis.references = htmlRefs.map((htmlRef, index) => {
          // Try to parse author and year from the reference text
          const authorMatch = htmlRef.text.match(/^([A-Z][a-z]+(?:\s+[A-Z][A-Z]?)?)/);
          const yearMatch = htmlRef.text.match(/\b(19|20)\d{2}\b/);
          const titleMatch = htmlRef.text.match(/\.\s+([^.]+)\./);

          return {
            number: index + 1,
            text: htmlRef.text,
            components: {
              authors: htmlRef.firstAuthor ? [htmlRef.firstAuthor] : (authorMatch ? [authorMatch[1]] : []),
              year: yearMatch ? yearMatch[0] : undefined,
              title: titleMatch ? titleMatch[1].trim() : htmlRef.text.substring(0, 100),
              journal: undefined,
              volume: undefined,
              issue: undefined,
              pages: undefined,
              doi: undefined,
              url: undefined,
              publisher: undefined
            }
          };
        });

        logger.info(`[Citation Management] Created ${analysis.references.length} references from HTML fallback`);
      }

      // CRITICAL FIX: Use regex to find actual citations in document
      // AI detection often gives wrong positions/text
      const actualCitations = this.findActualCitationsInText(documentText);
      logger.info(`[Citation Management] Regex found ${actualCitations.length} actual citations in text`);

      if (actualCitations.length > 0) {
        logger.info(`[Citation Management] Sample citation: "${actualCitations[0].text}" at position ${actualCitations[0].start}`);
      }

      // ============================================
      // DETECT CITATION STYLE FROM CITATIONS
      // ============================================
      // If AI didn't detect style, detect from actual citations
      if (!analysis.detectedStyle || analysis.detectedStyle === 'Unknown') {
        const numericCount = actualCitations.filter(c => c.type === 'numeric').length;
        const authorYearCount = actualCitations.filter(c => c.type === 'author-year').length;

        if (numericCount > authorYearCount) {
          // More numeric citations - likely Vancouver or IEEE
          // Check citation format: [1] = Vancouver, (1) = could be Vancouver or other
          const bracketCount = actualCitations.filter(c => c.text.startsWith('[')).length;
          const parenCount = actualCitations.filter(c => c.text.startsWith('(')).length;

          if (bracketCount > parenCount) {
            analysis.detectedStyle = 'Vancouver';
            logger.info(`[Citation Management] Detected style: Vancouver (bracket numeric citations)`);
          } else {
            analysis.detectedStyle = 'Vancouver'; // Default numeric to Vancouver
            logger.info(`[Citation Management] Detected style: Vancouver (numeric citations)`);
          }
        } else if (authorYearCount > 0) {
          analysis.detectedStyle = 'APA'; // Default author-year to APA
          logger.info(`[Citation Management] Detected style: APA (author-year citations)`);
        } else {
          analysis.detectedStyle = 'Unknown';
          logger.info(`[Citation Management] Could not detect style - defaulting to Unknown`);
        }
      }

      // ============================================
      // AUTO-RESEQUENCING: Renumber citations by appearance order
      // ============================================
      // For numeric citations, find first appearance of each reference number
      // and create a mapping to renumber them sequentially
      const numericCitations = actualCitations.filter(c => c.type === 'numeric' && c.number);
      const totalReferences = analysis.references.length;

      // ============================================
      // ONLY RESEQUENCE NUMERIC CITATIONS (Vancouver, IEEE)
      // Skip for author-year formats (APA, MLA, Chicago)
      // ============================================
      const hasNumericCitations = numericCitations.length > 0;

      // Track mapping for numeric citations (will be empty for author-year)
      const oldToNewNumber = new Map<number, number>();

      if (hasNumericCitations) {
        logger.info(`[Citation Management] Numeric citation document - applying resequencing logic`);

        // Track first appearance of each reference number
        const numberFirstAppearance = new Map<number, number>(); // refNum -> position
      for (const citation of numericCitations) {
        if (citation.number && !numberFirstAppearance.has(citation.number)) {
          numberFirstAppearance.set(citation.number, citation.start);
        }
      }

      // Sort reference numbers by their first appearance position
      const sortedByAppearance = [...numberFirstAppearance.entries()]
        .sort((a, b) => a[1] - b[1]) // Sort by position
        .map(entry => entry[0]); // Get just the reference numbers

      // Create old-to-new number mapping (populate the map declared earlier)
      sortedByAppearance.forEach((oldNum, index) => {
        const newNum = index + 1;
        oldToNewNumber.set(oldNum, newNum);
        if (oldNum !== newNum) {
          logger.info(`[Citation Management] Resequence: reference ${oldNum} → ${newNum}`);
        }
      });

      // Add any reference numbers not cited (put at end)
      let nextNum = sortedByAppearance.length + 1;
      for (let i = 1; i <= totalReferences; i++) {
        if (!oldToNewNumber.has(i)) {
          oldToNewNumber.set(i, nextNum);
          logger.info(`[Citation Management] Resequence: uncited reference ${i} → ${nextNum}`);
          nextNum++;
        }
      }

      logger.debug(`[Citation Management] Resequence mapping: ${[...oldToNewNumber.entries()].sort((a, b) => a[0] - b[0]).map(([o, n]) => `${o}→${n}`).join(', ')}`);

      // ============================================
      // CREATE CITATION CHANGE RECORDS FOR EXPORT
      // ============================================
      // Store resequencing changes so export can show track changes
      const resequenceChanges: Array<{beforeText: string, afterText: string}> = [];

      // Build unique text changes for each citation that needs renumbering
      for (const citation of actualCitations) {
        if (citation.type === 'numeric' && citation.number) {
          const newNumber = oldToNewNumber.get(citation.number);
          if (newNumber && newNumber !== citation.number) {
            const newText = citation.text.replace(
              new RegExp(`(\\(|\\[)${citation.number}(\\)|\\])`, 'g'),
              `$1${newNumber}$2`
            );
            // Only add if not already in list (avoid duplicates for same text)
            if (!resequenceChanges.some(c => c.beforeText === citation.text && c.afterText === newText)) {
              resequenceChanges.push({ beforeText: citation.text, afterText: newText });
            }
          }
        }
      }

      // Delete any existing resequence changes for this document
      await prisma.citationChange.deleteMany({
        where: {
          documentId,
          changeType: 'RESEQUENCE'
        }
      });

      // Create new citation change records for resequencing
      if (resequenceChanges.length > 0) {
        await prisma.citationChange.createMany({
          data: resequenceChanges.map(change => ({
            documentId,
            changeType: 'RESEQUENCE',
            beforeText: change.beforeText,
            afterText: change.afterText,
            appliedBy: 'SYSTEM'
          }))
        });
        logger.info(`[Citation Management] Stored ${resequenceChanges.length} resequence changes for export track changes`);
      }

      } else {
        // AUTHOR-YEAR STYLE (APA, MLA, Chicago): No resequencing needed
        logger.info(`[Citation Management] Author-year citation document - skipping resequencing`);

        // Delete any existing resequence changes that might have been created incorrectly
        await prisma.citationChange.deleteMany({
          where: {
            documentId,
            changeType: 'RESEQUENCE'
          }
        });
        logger.info(`[Citation Management] Cleaned up any leftover resequence changes for author-year document`);
      }

      // Apply resequencing to citations - update their text with new numbers
      // For author-year documents, oldToNewNumber is empty so no changes are made
      const resequencedCitations = actualCitations.map(citation => {
        if (citation.type === 'numeric' && citation.number) {
          const newNumber = oldToNewNumber.get(citation.number);
          if (newNumber && newNumber !== citation.number) {
            // Update the citation text with new number
            const newText = citation.text.replace(
              new RegExp(`(\\(|\\[)${citation.number}(\\)|\\])`, 'g'),
              `$1${newNumber}$2`
            );
            logger.info(`[Citation Management] Citation text: "${citation.text}" → "${newText}"`);
            return {
              ...citation,
              text: newText,
              originalNumber: citation.number,
              number: newNumber
            };
          }
        }
        return { ...citation, originalNumber: citation.number };
      });

      // Save citations with RESEQUENCED numbers
      const createdCitations = [];
      for (const citation of resequencedCitations) {
        // Ensure we have the actual text
        if (!citation.text || citation.text.trim() === '') {
          logger.warn(`[Citation Management] Skipping citation with empty text at position ${citation.start}`);
          continue;
        }

        logger.info(`[Citation Management] Saving citation: "${citation.text}" (type: ${citation.type}, newNumber: ${citation.number}, originalNumber: ${citation.originalNumber}, author: ${citation.authorName || 'N/A'}, year: ${citation.year || 'N/A'})`);

        const created = await prisma.citation.create({
          data: {
            documentId,
            rawText: citation.text,
            citationType: 'PARENTHETICAL',
            paragraphIndex: 0, // We don't have paragraph info from regex
            startOffset: citation.start,
            endOffset: citation.end,
            validationErrors: []
          }
        });

        createdCitations.push({
          ...created,
          citationNumber: citation.number, // Use NEW number for linking
          originalNumber: citation.originalNumber, // Keep track of original
          citationType: citation.type,
          authorName: citation.authorName,
          year: citation.year
        });
      }

      // Save references and link to citations
      // IMPORTANT: Handle both numeric and author-year citation styles
      const createdReferences = [];
      logger.info(`[Citation Management] Citation style: ${hasNumericCitations ? 'numeric' : 'author-year'}, ${totalReferences} references to save`);

      if (hasNumericCitations) {
        // NUMERIC STYLE (Vancouver, IEEE): Use resequencing logic
        // References are reordered to match citation appearance order in text

        // Use HTML mapping to correct AI extraction errors if needed
        // Map AI reference numbers to correct HTML positions
        const correctedRefDataByOriginalNumber = new Map<number, typeof analysis.references[0]>();

        if (aiRefToHtmlPosition.size > 0) {
          // AI-to-HTML mapping available - use it to correct any AI extraction order issues
          logger.info(`[Citation Management] Using HTML position mapping to correct AI extraction order`);

          for (const ref of analysis.references) {
            const aiNum = ref.number || 0;
            const htmlPos = aiRefToHtmlPosition.get(aiNum);

            if (htmlPos !== undefined) {
              // Use HTML position as the "original" number for this reference
              correctedRefDataByOriginalNumber.set(htmlPos, ref);
              logger.info(`[Citation Management] Reference "${ref.components?.authors?.[0] || 'unknown'}" (AI #${aiNum}) → corrected to original #${htmlPos}`);
            } else {
              // No HTML match - use AI number as-is
              correctedRefDataByOriginalNumber.set(aiNum, ref);
              logger.warn(`[Citation Management] Reference "${ref.components?.authors?.[0] || 'unknown'}" (AI #${aiNum}) - no HTML match, keeping AI number`);
            }
          }
        } else {
          // No HTML mapping - use AI numbers directly
          logger.info(`[Citation Management] No HTML mapping - using AI extraction order`);
          for (const ref of analysis.references) {
            const origNum = ref.number || 0;
            correctedRefDataByOriginalNumber.set(origNum, ref);
          }
        }

        // Save references in NEW order based on citation appearance
        for (let newNum = 1; newNum <= totalReferences; newNum++) {
          const originalNum = [...oldToNewNumber.entries()].find(([_, n]) => n === newNum)?.[0];
          if (originalNum === undefined) {
            logger.warn(`[Citation Management] No original reference found for new number ${newNum}`);
            continue;
          }

          const ref = correctedRefDataByOriginalNumber.get(originalNum);
          if (!ref) {
            logger.warn(`[Citation Management] Reference data not found for original number ${originalNum}`);
            continue;
          }

          const refAuthors = ref.components?.authors || [];
          const refYear = ref.components?.year;

          // Link numeric citations by checking if citation text contains this reference number
          // Note: Multi-number citations like [2,6] should link to BOTH reference 2 and 6
          // We use originalNum because citation text still has original numbers before resequencing
          const linkedCitationIds = createdCitations
            .filter(c => {
              if (c.citationType !== 'numeric') return false;
              // Extract ALL numbers from citation text (handles ranges like [3-5] → [3,4,5])
              const numbersInCitation = this.extractNumbersFromCitation(c.rawText || '');
              // Check if this citation contains the original reference number
              return numbersInCitation.includes(originalNum);
            })
            .map(c => c.id);

          logger.info(`[Citation Management] Saving reference ${newNum} (was ${originalNum}): "${ref.components?.title?.substring(0, 50)}..." with ${linkedCitationIds.length} linked citations`);

          const createdRef = await prisma.referenceListEntry.create({
            data: {
              documentId,
              sortKey: String(newNum).padStart(4, '0'),
              citationIds: linkedCitationIds,
              authors: refAuthors,
              year: refYear,
              title: ref.components.title || 'Untitled',
              sourceType: ref.components.sourceType || 'journal',
              journalName: ref.components.journal || ref.components.journalName,
              volume: ref.components.volume,
              issue: ref.components.issue,
              pages: ref.components.pages,
              doi: ref.components.doi,
              publisher: ref.components.publisher,
              url: ref.components.url,
              enrichmentSource: 'ai',
              enrichmentConfidence: 0.8
            }
          });

          createdReferences.push({
            ...createdRef,
            refNumber: newNum,
            originalNumber: originalNum
          });
        }
      } else {
        // AUTHOR-YEAR STYLE (APA, MLA, Chicago): Save all references directly
        // No resequencing needed - order is typically alphabetical or by appearance
        for (let i = 0; i < analysis.references.length; i++) {
          const ref = analysis.references[i];
          const refAuthors = ref.components?.authors || [];
          const refYear = ref.components?.year;
          const refNum = i + 1;

          // Link author-year citations by matching author name and year
          logger.info(`[Citation Management] Trying to link reference ${refNum}: authors=${JSON.stringify(refAuthors)}, year=${refYear}`);

          const linkedCitationIds: string[] = [];
          // Note: createdCitations uses citationType from AI analysis (lowercase 'numeric' | 'author-year')
          const authorYearMatches = createdCitations.filter(c => {
            if (c.citationType !== 'author-year' || !c.authorName || !c.year) {
              return false;
            }

            // Convert both years to strings for comparison (AI might return number, regex returns string)
            const citationYear = String(c.year).trim();
            const referenceYear = String(refYear || '').trim();

            if (citationYear !== referenceYear) {
              logger.debug(`[Citation Management] Year mismatch: citation "${c.authorName}" has year "${citationYear}" but reference has "${referenceYear}"`);
              return false;
            }

            // Check if any author's last name matches the citation author
            for (const author of refAuthors) {
              const lastName = this.extractLastName(author);
              logger.debug(`[Citation Management] Comparing citation author "${c.authorName}" with reference author lastName "${lastName}"`);
              if (lastName.toLowerCase() === c.authorName.toLowerCase()) {
                logger.info(`[Citation Management] MATCH FOUND: "${c.authorName}" matches "${lastName}" (year: ${citationYear})`);
                return true;
              }
            }
            logger.debug(`[Citation Management] No author match for citation "${c.authorName}" in reference authors: ${JSON.stringify(refAuthors)}`);
            return false;
          });

          if (authorYearMatches.length > 0) {
            linkedCitationIds.push(...authorYearMatches.map(c => c.id));
            logger.info(`[Citation Management] Linked ${authorYearMatches.length} author-year citations to reference by ${refAuthors[0] || 'unknown'} (${refYear})`);
          }

          logger.info(`[Citation Management] Saving reference ${refNum}: "${ref.components?.title?.substring(0, 50)}..." with ${linkedCitationIds.length} linked citations`);

          const createdRef = await prisma.referenceListEntry.create({
            data: {
              documentId,
              sortKey: String(refNum).padStart(4, '0'),
              citationIds: [...new Set(linkedCitationIds)],
              authors: refAuthors,
              year: refYear,
              title: ref.components.title || 'Untitled',
              sourceType: ref.components.sourceType || 'journal',
              journalName: ref.components.journal || ref.components.journalName,
              volume: ref.components.volume,
              issue: ref.components.issue,
              pages: ref.components.pages,
              doi: ref.components.doi,
              publisher: ref.components.publisher,
              url: ref.components.url,
              enrichmentSource: 'ai',
              enrichmentConfidence: 0.8
            }
          });

          createdReferences.push({
            ...createdRef,
            refNumber: refNum,
            originalNumber: refNum
          });
        }
      }

      // Update citations with their referenceId (link back to ReferenceListEntry)
      // Note: Citation.referenceId links to Reference model, not ReferenceListEntry
      // So we skip this for now - the link is maintained via citationIds array

      // ============================================
      // UPDATE DOCUMENT TEXT WITH CORRECTED CITATIONS
      // ============================================
      // Apply resequencing to the document's fullText so preview shows corrected numbers
      let updatedText = documentText;

      // Build replacements: sort by position descending to avoid offset issues
      const replacements: Array<{start: number, end: number, oldText: string, newText: string}> = [];

      // Helper to convert number to superscript
      const numberToSuperscript = (num: number): string => {
        const superDigits: { [key: string]: string } = {
          '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
          '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹'
        };
        return num.toString().split('').map(d => superDigits[d] || d).join('');
      };

      // Check if text contains superscript characters
      const isSuperscript = (text: string): boolean => {
        return /[¹²³⁴⁵⁶⁷⁸⁹⁰]/.test(text);
      };

      for (const citation of actualCitations) {
        if (citation.type === 'numeric' && citation.number) {
          const newNumber = oldToNewNumber.get(citation.number);
          if (newNumber && newNumber !== citation.number) {
            let newText: string;

            if (isSuperscript(citation.text)) {
              // Superscript citation - replace with superscript number
              newText = numberToSuperscript(newNumber);
            } else {
              // Parenthetical or bracket citation
              newText = citation.text.replace(
                new RegExp(`(\\(|\\[)${citation.number}(\\)|\\])`, 'g'),
                `$1${newNumber}$2`
              );
            }

            replacements.push({
              start: citation.start,
              end: citation.end,
              oldText: citation.text,
              newText: newText
            });
          }
        }
      }

      // Sort by position descending to replace from end to start (preserves offsets)
      replacements.sort((a, b) => b.start - a.start);

      // Apply replacements to fullText (using positions)
      for (const rep of replacements) {
        updatedText = updatedText.substring(0, rep.start) + rep.newText + updatedText.substring(rep.end);
        logger.info(`[Citation Management] Updated text: "${rep.oldText}" → "${rep.newText}" at position ${rep.start}`);
      }

      logger.info(`[Citation Management] Applied ${replacements.length} citation text replacements`);

      // Also update fullHtml - use simple string replace since HTML positions differ
      // Get the document's current fullHtml
      const currentDoc = await prisma.editorialDocument.findUnique({
        where: { id: documentId },
        select: { fullHtml: true }
      });

      let updatedHtml = currentDoc?.fullHtml || '';

      // Build unique replacement pairs (old number -> new number)
      const numberReplacements = new Map<number, number>();
      for (const [oldNum, newNum] of oldToNewNumber.entries()) {
        if (oldNum !== newNum) {
          numberReplacements.set(oldNum, newNum);
        }
      }

      // Apply replacements to HTML using temporary placeholders to avoid conflicts
      // e.g., (2)->(1) and (1)->(4) could conflict if done directly
      const placeholder = '___CITE_PLACEHOLDER_';

      // Helper functions for superscript conversion in HTML context
      const numToSuperscriptHtml = (num: number): string => {
        const superDigits: { [key: string]: string } = {
          '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
          '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹'
        };
        return num.toString().split('').map(d => superDigits[d] || d).join('');
      };

      const oldNumToSuperscript = (num: number): string => {
        const superDigits: { [key: string]: string } = {
          '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
          '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹'
        };
        return num.toString().split('').map(d => superDigits[d] || d).join('');
      };

      // First pass: replace old numbers with placeholders
      for (const [oldNum, newNum] of numberReplacements.entries()) {
        // Match (N) or [N] patterns
        const parenBracketPattern = new RegExp(`\\((${oldNum})\\)|\\[(${oldNum})\\]`, 'g');
        updatedHtml = updatedHtml.replace(parenBracketPattern, (match) => {
          if (match.startsWith('(')) return `(${placeholder}${newNum})`;
          return `[${placeholder}${newNum}]`;
        });

        // Match superscript Unicode characters
        const oldSuperscript = oldNumToSuperscript(oldNum);
        updatedHtml = updatedHtml.replace(new RegExp(oldSuperscript, 'g'), `${placeholder}SUP${newNum}`);

        // Match <sup>N</sup> HTML tags
        const supTagPattern = new RegExp(`<sup>(${oldNum})</sup>`, 'gi');
        updatedHtml = updatedHtml.replace(supTagPattern, `<sup>${placeholder}${newNum}</sup>`);
      }

      // Second pass: remove placeholders and convert SUP placeholders to superscript
      updatedHtml = updatedHtml.replace(new RegExp(`${placeholder}SUP(\\d+)`, 'g'), (_, num) => numToSuperscriptHtml(parseInt(num)));
      updatedHtml = updatedHtml.replace(new RegExp(placeholder, 'g'), '');

      logger.info(`[Citation Management] Updated fullHtml with ${numberReplacements.size} citation number changes`);

      // Update document status, fullText AND fullHtml
      await prisma.editorialDocument.update({
        where: { id: documentId },
        data: {
          status: 'COMPLETED',
          referenceListStyle: analysis.detectedStyle,
          fullText: updatedText,
          fullHtml: updatedHtml
        }
      });

      logger.info(`[Citation Management] Successfully saved ${createdCitations.length} citations and ${createdReferences.length} references`);
      logger.info(`[Citation Management] Analysis complete for ${documentId}`);
    } catch (error) {
      logger.error(`[Citation Management] Analysis failed:`, error);
      await prisma.editorialDocument.update({
        where: { id: documentId },
        data: { status: 'FAILED' }
      });
    }
  }

  /**
   * Find actual citation positions in document text using regex
   * This fixes AI detection errors where positions/text are wrong
   * Returns citations with type: 'numeric' or 'author-year'
   */
  private findActualCitationsInText(documentText: string): Array<{text: string, start: number, end: number, number: number, type: 'numeric' | 'author-year', authorName?: string, year?: string}> {
    const citations: Array<{text: string, start: number, end: number, number: number, type: 'numeric' | 'author-year', authorName?: string, year?: string}> = [];

    // Normalize ampersand characters - DOCX may use different Unicode variants
    // Common variants: & (U+0026), ＆ (U+FF06 full-width), ⅋ (U+214B turned ampersand)
    // Also handle HTML entity that might be in extracted text
    let normalizedText = documentText
      .replace(/＆/g, '&')  // Full-width ampersand
      .replace(/⅋/g, '&')   // Turned ampersand
      .replace(/&amp;/gi, '&');  // HTML entity

    logger.debug(`[Citation Management] Text normalization: documentText length=${documentText.length}, has ampersand=${documentText.includes('&')}, has fullWidth=${documentText.includes('＆')}`);

    // Use normalized text for pattern matching
    const textForMatching = normalizedText;

    // Pattern 1: Parenthetical numeric citations like (1), (2), (1,2,3)
    // IMPORTANT: Exclude year-like numbers (1800-2100) as they're author-year citations
    const parenRegex = /\((\d+(?:\s*,\s*\d+)*)\)/g;
    let match: RegExpExecArray | null;

    while ((match = parenRegex.exec(textForMatching)) !== null) {
      const fullText = match[0]; // e.g., "(1)" or "(1,2,3)"
      const matchIndex = match.index;
      const numbers = match[1].split(',').map(n => parseInt(n.trim()));

      // Skip if preceded by a number (e.g., "28(1)" is volume/issue, not a citation)
      if (matchIndex > 0) {
        const charBefore = textForMatching[matchIndex - 1];
        if (/\d/.test(charBefore)) {
          logger.debug(`[Citation Management] Skipping "(${match[1]})" - preceded by number, likely volume/issue`);
          continue;
        }
      }

      // Filter out year-like numbers (1800-2100) - these are part of author-year citations
      const validNumbers = numbers.filter(num => num < 1800 || num > 2100);

      if (validNumbers.length === 0) {
        // All numbers were years, skip this match
        continue;
      }

      validNumbers.forEach(num => {
        citations.push({
          text: fullText,
          start: matchIndex,
          end: matchIndex + fullText.length,
          number: num,
          type: 'numeric'
        });
      });
    }

    // Pattern 2: Bracket numeric citations like [1], [2], [1-3], [3–5] (en-dash), [1,2]
    // Support hyphen (-), en-dash (–), and em-dash (—) for ranges
    const bracketRegex = /\[(\d+(?:\s*[-–—,]\s*\d+)*)\]/g;

    while ((match = bracketRegex.exec(textForMatching)) !== null) {
      const fullText = match[0];
      const matchIndex = match.index;
      const numberPart = match[1];

      // Handle ranges like [1-3], [3–5], [3—5] (hyphen, en-dash, em-dash)
      // Check for any dash character (hyphen, en-dash, or em-dash)
      const hasDash = /[-–—]/.test(numberPart);

      if (hasDash && !numberPart.includes(',')) {
        // Pure range like [3-5] or [3–5]
        const [start, end] = numberPart.split(/[-–—]/).map(n => parseInt(n.trim()));
        logger.debug(`[Citation Management] Range citation "${fullText}": expanding ${start} to ${end}`);
        for (let num = start; num <= end; num++) {
          citations.push({
            text: fullText,
            start: matchIndex,
            end: matchIndex + fullText.length,
            number: num,
            type: 'numeric'
          });
        }
      } else if (numberPart.includes(',')) {
        // Comma-separated, may also have ranges within: [1,2,5-7]
        const parts = numberPart.split(',').map(p => p.trim());
        parts.forEach(part => {
          if (/[-–—]/.test(part)) {
            // Range within comma-separated: expand 5-7 to 5,6,7
            const [start, end] = part.split(/[-–—]/).map(n => parseInt(n.trim()));
            for (let num = start; num <= end; num++) {
              citations.push({
                text: fullText,
                start: matchIndex,
                end: matchIndex + fullText.length,
                number: num,
                type: 'numeric'
              });
            }
          } else {
            // Single number
            const num = parseInt(part);
            citations.push({
              text: fullText,
              start: matchIndex,
              end: matchIndex + fullText.length,
              number: num,
              type: 'numeric'
            });
          }
        });
      } else {
        // Single number like [1]
        const num = parseInt(numberPart.trim());
        citations.push({
          text: fullText,
          start: matchIndex,
          end: matchIndex + fullText.length,
          number: num,
          type: 'numeric'
        });
      }
    }

    // Pattern 3: Superscript numeric citations
    // Unicode superscript characters: ¹²³⁴⁵⁶⁷⁸⁹⁰
    const superscriptMap: { [key: string]: number } = {
      '¹': 1, '²': 2, '³': 3, '⁴': 4, '⁵': 5,
      '⁶': 6, '⁷': 7, '⁸': 8, '⁹': 9, '⁰': 0
    };
    const superscriptChars = Object.keys(superscriptMap).join('');
    const superscriptRegex = new RegExp(`[${superscriptChars}]+`, 'g');

    while ((match = superscriptRegex.exec(textForMatching)) !== null) {
      const fullText = match[0]; // e.g., "¹" or "¹²"
      const matchIndex = match.index;

      // Convert superscript string to number
      let numStr = '';
      for (const char of fullText) {
        if (superscriptMap[char] !== undefined) {
          numStr += superscriptMap[char].toString();
        }
      }
      const num = parseInt(numStr);

      if (!isNaN(num) && num > 0) {
        citations.push({
          text: fullText,
          start: matchIndex,
          end: matchIndex + fullText.length,
          number: num,
          type: 'numeric'
        });
      }
    }

    // Pattern 4: Author-year citations like (Smith, 2020), (Brown et al., 2021), (Marcus & Davis, 2019)
    // Also handles multiple citations: (Brown et al., 2020; Bommasani et al., 2021)
    // Handles: & or &amp; or "and" between authors, "et al." suffix
    const authorYearRegex = /\(([A-Z][a-z]+(?:\s+(?:et\s+al\.?|(?:&|&amp;|and)\s+[A-Z][a-z]+))?,?\s*\d{4}(?:;\s*[A-Z][a-z]+(?:\s+(?:et\s+al\.?|(?:&|&amp;|and)\s+[A-Z][a-z]+))?,?\s*\d{4})*)\)/gi;

    while ((match = authorYearRegex.exec(textForMatching)) !== null) {
      const fullText = match[0]; // e.g., "(Smith, 2020)" or "(Brown et al., 2020; Bommasani et al., 2021)"
      const matchIndex = match.index;
      const content = match[1];

      // Split by semicolon for multiple citations in one parenthesis
      const parts = content.split(/;\s*/);

      // Track position within the content for each part
      let currentPos = matchIndex + 1; // +1 for opening parenthesis

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        // Extract author name and year from each part
        // Handles: "Smith, 2020", "Brown et al., 2021", "Marcus & Davis, 2019", "Marcus and Davis, 2019"
        const authorMatch = part.match(/([A-Z][a-z]+(?:\s+(?:et\s+al\.?|(?:&|and)\s+[A-Z][a-z]+))?),?\s*(\d{4})/i);
        if (authorMatch) {
          // Extract first author's last name (before "et al.", "&" or "and")
          const authorName = authorMatch[1].replace(/\s+et\s+al\.?/i, '').replace(/\s*(?:&|and)\s+.*/i, '').trim();
          const year = authorMatch[2];

          // For single citations, use full text with parentheses: "(Smith, 2020)"
          // For multi-citations, use individual part: "Brown et al., 2020" or "Bommasani et al., 2021"
          const citationText = parts.length === 1 ? fullText : part.trim();
          const citationStart = parts.length === 1 ? matchIndex : currentPos;
          const citationEnd = parts.length === 1 ? matchIndex + fullText.length : currentPos + part.length;

          logger.info(`[Citation Management] Detected author-year citation: author="${authorName}", year="${year}", text="${citationText}"`);

          citations.push({
            text: citationText,
            start: citationStart,
            end: citationEnd,
            number: 0, // Author-year citations don't have numbers
            type: 'author-year',
            authorName,
            year
          });
        }
        // Move position past this part and the semicolon separator
        currentPos += part.length + 2; // +2 for "; " separator
      }
    }

    // Pattern 5: Simple two-author citations with & or and (more flexible pattern)
    // Matches: (Marcus & Davis, 2019), (Smith and Jones, 2020)
    const twoAuthorRegex = /\(([A-Z][a-z]+)\s*(?:&|&amp;|and)\s*([A-Z][a-z]+),?\s*(\d{4})\)/gi;

    while ((match = twoAuthorRegex.exec(textForMatching)) !== null) {
      const fullText = match[0];
      const matchIndex = match.index;
      const author1 = match[1];
      const author2 = match[2];
      const year = match[3];

      // Check if this citation was already detected by Pattern 4
      const alreadyDetected = citations.some(c =>
        c.start === matchIndex && c.type === 'author-year'
      );

      if (!alreadyDetected) {
        logger.info(`[Citation Management] Detected two-author citation: "${author1} & ${author2}, ${year}" from "${fullText}"`);

        citations.push({
          text: fullText,
          start: matchIndex,
          end: matchIndex + fullText.length,
          number: 0,
          type: 'author-year',
          authorName: author1, // Use first author for linking
          year
        });
      }
    }

    // Deduplicate: remove citations at same position (some patterns overlap)
    const uniqueCitations = citations.filter((citation, index, self) =>
      index === self.findIndex(c => c.start === citation.start && c.end === citation.end && c.number === citation.number && c.type === citation.type && c.authorName === citation.authorName)
    );

    return uniqueCitations.sort((a, b) => a.start - b.start);
  }

  /**
   * Extract last name from author string
   * Handles: "Smith, J.", "J. Smith", "Smith"
   */
  private extractLastName(author: string): string {
    if (!author) return '';

    // If contains comma, last name is before comma: "Smith, J." -> "Smith"
    if (author.includes(',')) {
      return author.split(',')[0].trim();
    }

    // Otherwise, last name is the last word (unless it's initials)
    const parts = author.trim().split(/\s+/);
    if (parts.length === 1) return parts[0];

    // If last part looks like initials, first part is last name
    const lastPart = parts[parts.length - 1];
    if (lastPart.length <= 3 && /^[A-Z]\.?$/.test(lastPart.replace(/\./g, ''))) {
      return parts[0];
    }

    return lastPart;
  }

  /**
   * Extract references from HTML in document order
   * Parses <ol><li> structure to get correct reference positions
   */
  private extractReferencesFromHtml(html: string): Array<{ position: number; text: string }> {
    const references: Array<{ position: number; text: string }> = [];

    // Find ordered list with references
    const olMatch = html.match(/<ol[^>]*>([\s\S]*?)<\/ol>/i);
    if (!olMatch) {
      // Try finding references after "References" heading
      const refSectionMatch = html.match(/References<\/[^>]+>([\s\S]*?)(?:<\/div>|<\/article>|$)/i);
      if (refSectionMatch) {
        const liMatches = refSectionMatch[1].match(/<li[^>]*>([\s\S]*?)<\/li>/gi);
        if (liMatches) {
          liMatches.forEach((li, idx) => {
            const text = li.replace(/<[^>]+>/g, '').trim();
            if (text.length > 10) {
              references.push({ position: idx + 1, text });
            }
          });
        }
      }
      return references;
    }

    // Parse <li> items from the <ol>
    const liMatches = olMatch[1].match(/<li[^>]*>([\s\S]*?)<\/li>/gi);
    if (liMatches) {
      liMatches.forEach((li, idx) => {
        const text = li.replace(/<[^>]+>/g, '').trim();
        if (text.length > 10) {
          references.push({ position: idx + 1, text });
        }
      });
    }

    logger.info(`[Citation Management] Extracted ${references.length} references from HTML`);
    return references;
  }

  /**
   * Match AI-extracted references to HTML references by text similarity
   * Returns a mapping of AI reference number to correct document position
   */
  private matchReferencesToHtmlOrder(
    aiRefs: Array<{ number?: number; rawText?: string; components?: { authors?: string[]; year?: string; title?: string } }>,
    htmlRefs: Array<{ position: number; text: string }>
  ): Map<number, number> {
    const mapping = new Map<number, number>();

    for (const aiRef of aiRefs) {
      const aiAuthors = aiRef.components?.authors || [];
      const aiYear = aiRef.components?.year || '';
      const aiTitle = aiRef.components?.title || '';

      let bestMatch = -1;
      let bestScore = 0;

      for (const htmlRef of htmlRefs) {
        const htmlText = htmlRef.text;
        let score = 0;

        // Check if first author name appears in HTML ref
        if (aiAuthors.length > 0) {
          const firstAuthor = typeof aiAuthors[0] === 'string' ? aiAuthors[0] : aiAuthors[0]?.lastName || '';
          const authorName = firstAuthor.split(/[,\s]/)[0];
          if (authorName && htmlText.toLowerCase().includes(authorName.toLowerCase())) {
            score += 40;
          }
        }

        // Check if year appears
        if (aiYear && htmlText.includes(aiYear)) {
          score += 30;
        }

        // Check if title words appear
        if (aiTitle) {
          const titleWords: string[] = aiTitle.toLowerCase().split(/\s+/).filter((w: string) => w.length > 4);
          const matchingWords = titleWords.filter((w: string) => htmlText.toLowerCase().includes(w));
          score += (matchingWords.length / Math.max(titleWords.length, 1)) * 30;
        }

        if (score > bestScore) {
          bestScore = score;
          bestMatch = htmlRef.position;
        }
      }

      if (bestMatch > 0 && bestScore >= 40) {
        mapping.set(aiRef.number || 0, bestMatch);
        logger.debug(`[Citation Management] Matched AI ref ${aiRef.number} to HTML position ${bestMatch} (score: ${bestScore})`);
      }
    }

    return mapping;
  }
}

export const citationManagementController = new CitationManagementController();
