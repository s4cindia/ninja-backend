/**
 * Citation Reference Controller
 * Handles reference CRUD operations with tenant isolation
 *
 * Endpoints:
 * - POST /document/:documentId/reorder - Reorder references
 * - DELETE /document/:documentId/reference/:referenceId - Delete reference
 * - PATCH /document/:documentId/reference/:referenceId - Edit reference
 * - POST /document/:documentId/resequence - Resequence by appearance
 */

import { randomUUID } from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { Prisma, PrismaPromise } from '@prisma/client';
import prisma from '../../lib/prisma';

// Type for Prisma transaction client
type TransactionClient = Omit<typeof prisma, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;
import { logger } from '../../lib/logger';

import { referenceReorderingService } from '../../services/citation/reference-reordering.service';
import { referenceListService, normalizeStyleCode, getFormattedColumn } from '../../services/citation/reference-list.service';
import type { EditReferenceBody } from '../../schemas/citation.schemas';
import { resolveDocumentSimple } from './document-resolver';
import { extractCitationNumbers } from '../../utils/citation.utils';

/**
 * Safely extract authors array from Prisma JsonValue
 * @param authors - Prisma JsonValue that may be string[], string, or other types
 * @returns string[] with safe handling for all input types
 */
function safeAuthorsArray(authors: unknown): string[] {
  if (Array.isArray(authors)) {
    return authors.map(a => typeof a === 'string' ? a : String(a));
  }
  if (typeof authors === 'string') {
    return authors.split(',').map(s => s.trim()).filter(s => s.length > 0);
  }
  return [];
}

/**
 * Parse authors from JSON value to Author array format
 */
function parseAuthorsToArray(authors: Prisma.JsonValue): Array<{ firstName?: string; lastName: string; suffix?: string }> {
  if (!Array.isArray(authors)) return [];

  return authors.map(a => {
    if (typeof a === 'string') {
      // Simple string author - treat as last name
      return { lastName: a };
    }
    if (a && typeof a === 'object' && 'lastName' in a) {
      return {
        firstName: (a as { firstName?: string }).firstName,
        lastName: (a as { lastName: string }).lastName,
        suffix: (a as { suffix?: string }).suffix
      };
    }
    return { lastName: String(a) };
  });
}

/**
 * Format authors for in-text citation based on citation style
 * - APA: "Smith & Jones" (2 authors), "Smith et al." (3+)
 * - Vancouver: "Smith, Jones" (comma separator)
 * - Chicago/MLA: "Smith and Jones" (uses "and" instead of ampersand)
 * - IEEE: Not typically used for in-text (uses numbers)
 */
function formatAuthorsForInTextCitation(
  authors: Array<{ firstName?: string; lastName: string; suffix?: string }>,
  styleCode?: string
): string {
  if (!authors || authors.length === 0) {
    return 'Unknown';
  }

  // Extract last names, stripping any initials that may be included
  // Handles: "Bommasani R" -> "Bommasani", "Bommasani, R." -> "Bommasani", "Bommasani EM" -> "Bommasani"
  const lastNames = authors.map(a => {
    const lastName = a.lastName || 'Unknown';
    // Extract just the surname (first word before comma, space+initial, or space+uppercase)
    // Pattern: Take everything before a comma, or before " X" where X is uppercase (initial)
    const surnameMatch = lastName.match(/^([A-Za-z\-']+)/);
    return surnameMatch ? surnameMatch[1] : lastName;
  });
  const style = (styleCode || 'apa').toLowerCase();

  if (lastNames.length === 1) {
    return lastNames[0];
  }

  // Style-specific formatting for 2 authors
  if (lastNames.length === 2) {
    if (style.includes('vancouver') || style.includes('ieee')) {
      // Vancouver/IEEE typically use numbers, but if needed use comma
      return `${lastNames[0]}, ${lastNames[1]}`;
    } else if (style.includes('chicago') || style.includes('mla') || style.includes('turabian')) {
      // Chicago/MLA use "and"
      return `${lastNames[0]} and ${lastNames[1]}`;
    }
    // APA uses ampersand
    return `${lastNames[0]} & ${lastNames[1]}`;
  }

  // 3+ authors: "First et al." (most styles)
  return `${lastNames[0]} et al.`;
}

export class CitationReferenceController {
  /**
   * POST /api/v1/citation-management/document/:documentId/reorder
   * Reorder references and auto-update in-text citations
   *
   * NOTE: The :documentId param can be either a document ID or a job ID.
   */
  async reorderReferences(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const { referenceId, newPosition, sortBy } = req.body;
      const { tenantId } = req.user!;

      logger.info(`[CitationReference] Reordering references for ${documentId}`);

      // Resolve document (handles both document ID and job ID)
      const baseDoc = await resolveDocumentSimple(documentId, tenantId);

      if (!baseDoc) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' }
        });
        return;
      }

      // Get current references and citations with tenant verification using resolved ID
      const document = await prisma.editorialDocument.findFirst({
        where: { id: baseDoc.id, tenantId },
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
        number: index + 1,
        rawText: r.formattedApa || `${JSON.stringify(r.authors)} (${r.year}). ${r.title}`,
        components: {
          authors: safeAuthorsArray(r.authors),
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
        numbers: [],
        context: c.rawText
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

      // Build old-to-new number mapping
      const oldToNewNumber = new Map<number, number>();
      for (const change of result.changes) {
        oldToNewNumber.set(change.oldNumber, change.newNumber);
      }
      for (let i = 0; i < references.length; i++) {
        const oldNum = i + 1;
        if (!oldToNewNumber.has(oldNum)) {
          const ref = result.updatedReferences.find(r => r.id === references[i].id);
          if (ref) {
            oldToNewNumber.set(oldNum, ref.number!);
          }
        }
      }

      // Update database
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

      if (citationUpdates.length > 0) {
        await prisma.$transaction(
          citationUpdates.map(update =>
            prisma.citation.update({
              where: { id: update.id },
              data: { rawText: update.newRawText }
            })
          )
        );

        // Delete existing RENUMBER changes and create new ones
        await prisma.citationChange.deleteMany({
          where: { documentId, changeType: 'RENUMBER', isReverted: false }
        });

        const uniqueTextChanges = new Map<string, string>();
        for (const update of citationUpdates) {
          if (!uniqueTextChanges.has(update.oldRawText)) {
            uniqueTextChanges.set(update.oldRawText, update.newRawText);
          }
        }

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
          await prisma.citationChange.createMany({ data: renumberChanges });
        }
        // Note: Reference section reordering is handled at export time via REFERENCE_REORDER
        // in the export controller, which builds a complete reorder map from the current DB state.

        // Update existing INTEXT_STYLE_CONVERSION changes to reflect new numbering
        // When refs are reordered, the afterText of style conversions becomes stale
        // e.g., Chicago: (2)→² must become (3)→³ if ref 2 moved to position 3
        const activeStyleConversions = await prisma.citationChange.findMany({
          where: {
            documentId: baseDoc.id,
            changeType: 'INTEXT_STYLE_CONVERSION',
            isReverted: false,
            citationId: { not: null }
          }
        });

        if (activeStyleConversions.length > 0) {
          const styleUpdateOps: PrismaPromise<unknown>[] = [];

          for (const sc of activeStyleConversions) {
            const citUpdate = citationUpdates.find(u => u.id === sc.citationId);
            if (!citUpdate) continue; // Citation wasn't affected by reorder

            // Update beforeText to match citation's new rawText
            const newBeforeText = citUpdate.newRawText;

            // Rebuild afterText using the citation's new number in the same style format
            const newAfterText = this.rebuildStyledText(
              sc.afterText || '', citUpdate.newRawText
            );

            if (newBeforeText !== sc.beforeText || newAfterText !== sc.afterText) {
              logger.info(`[CitationReference] Updating INTEXT_STYLE_CONVERSION for citation ${sc.citationId}: before "${sc.beforeText}"→"${newBeforeText}", after "${sc.afterText}"→"${newAfterText}"`);
              styleUpdateOps.push(
                prisma.citationChange.update({
                  where: { id: sc.id },
                  data: { beforeText: newBeforeText, afterText: newAfterText }
                })
              );
            }
          }

          if (styleUpdateOps.length > 0) {
            await prisma.$transaction(styleUpdateOps);
          }
        }
      }

      // Fetch and return updated data
      const updatedDocument = await prisma.editorialDocument.findUnique({
        where: { id: documentId },
        include: {
          citations: true,
          referenceListEntries: {
            orderBy: { sortKey: 'asc' },
            include: { citationLinks: true }
          }
        }
      });

      res.json({
        success: true,
        data: {
          message: 'References reordered successfully',
          changes: result.changes,
          updatedCount: result.changes.length,
          citationsUpdated: citationUpdates.length,
          references: updatedDocument!.referenceListEntries.map((r, index) => ({
            id: r.id,
            position: index + 1,
            number: index + 1,
            rawText: r.formattedApa || `${safeAuthorsArray(r.authors).join(', ') || 'Unknown'} (${r.year || 'n.d.'}). ${r.title || 'Untitled'}`,
            citationCount: r.citationLinks.length
          }))
        }
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /api/v1/citation-management/document/:documentId/reference/:referenceId
   * Delete a reference and renumber remaining references
   */
  async deleteReference(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId, referenceId } = req.params;
      const { tenantId } = req.user!;

      logger.info(`[CitationReference] Deleting reference ${referenceId} from document ${documentId}`);

      // Get the reference with tenant verification
      const referenceToDelete = await prisma.referenceListEntry.findUnique({
        where: { id: referenceId },
        include: {
          citationLinks: true,
          document: {
            include: {
              referenceListEntries: { orderBy: { sortKey: 'asc' } },
              citations: true,
              documentContent: true
            }
          }
        }
      });

      if (!referenceToDelete) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Reference not found' }
        });
        return;
      }

      // CRITICAL: Verify tenant ownership (returns 404 to prevent enumeration)
      if (referenceToDelete.document.tenantId !== tenantId) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Reference not found' }
        });
        return;
      }

      // Validate URL param resolves to the same document as the reference
      // This prevents data inconsistency if URL param (which may be jobId) doesn't match
      const resolvedDoc = await resolveDocumentSimple(documentId, tenantId);
      if (!resolvedDoc || resolvedDoc.id !== referenceToDelete.documentId) {
        logger.warn(`[CitationReference] Document mismatch: URL param resolved to ${resolvedDoc?.id}, reference belongs to ${referenceToDelete.documentId}`);
        res.status(400).json({
          success: false,
          error: { code: 'DOCUMENT_MISMATCH', message: 'Document ID mismatch between URL and reference' }
        });
        return;
      }

      const allReferences = referenceToDelete.document.referenceListEntries;
      const deletedPosition = parseInt(referenceToDelete.sortKey) || 0;
      const affectedCitationIds = referenceToDelete.citationLinks.map(link => link.citationId);

      // Create old-to-new mapping (deleted = null)
      const oldToNewNumber = new Map<number, number | null>();
      let newPosition = 0;

      for (let i = 0; i < allReferences.length; i++) {
        const oldPosition = parseInt(allReferences[i].sortKey) || (i + 1);
        if (allReferences[i].id === referenceId) {
          oldToNewNumber.set(oldPosition, null);
          logger.debug(`[CitationReference] Mapping: ${oldPosition} -> null (deleted)`);
        } else {
          newPosition++;
          oldToNewNumber.set(oldPosition, newPosition);
          logger.debug(`[CitationReference] Mapping: ${oldPosition} -> ${newPosition}`);
        }
      }

      // Use already loaded data instead of re-fetching (N+1 prevention)
      const remainingReferences = allReferences.filter(ref => ref.id !== referenceId);
      const citations = referenceToDelete.document.citations;

      // Prepare citation updates before database operations
      // Track old->new text for creating CitationChange records
      // Process citations based on citationType - NUMERIC citations need renumbering
      const citationUpdates: { id: string; oldRawText: string; newRawText: string }[] = [];
      for (const citation of citations) {
        // Use citationType field for semantic distinction
        // Skip PARENTHETICAL (author-year) citations - they don't have numeric references
        if (citation.citationType === 'PARENTHETICAL') {
          continue;
        }
        // For NUMERIC and other types, check if citation contains any numbers
        if (!/\d/.test(citation.rawText)) continue;

        const newRawText = this.updateCitationNumbersWithDeletion(citation.rawText, oldToNewNumber);
        logger.debug(`[CitationReference] Citation update: length=${citation.rawText.length} -> ${newRawText.length}`);
        if (newRawText !== citation.rawText) {
          citationUpdates.push({ id: citation.id, oldRawText: citation.rawText, newRawText });
        }
      }

      // Group citation updates by new rawText value for batch operations
      const citationsByNewText = new Map<string, string[]>();
      for (const update of citationUpdates) {
        const ids = citationsByNewText.get(update.newRawText) || [];
        ids.push(update.id);
        citationsByNewText.set(update.newRawText, ids);
      }

      // Build the deleted reference text for track changes
      const deletedRefText = referenceToDelete.formattedApa ||
        `${safeAuthorsArray(referenceToDelete.authors).join(', ') || 'Unknown'} (${referenceToDelete.year || 'n.d.'}). ${referenceToDelete.title || 'Untitled'}`;

      // Execute all database operations in a single transaction
      // Increased timeout to handle many citation updates (default 5s is too short)
      await prisma.$transaction(async (tx) => {
        // Delete the reference
        await tx.referenceListEntry.delete({ where: { id: referenceId } });

        // Batch renumber remaining references using concurrent updates
        if (remainingReferences.length > 0) {
          await Promise.all(remainingReferences.map((ref, i) =>
            tx.referenceListEntry.update({
              where: { id: ref.id },
              data: { sortKey: String(i + 1).padStart(4, '0') }
            })
          ));
        }

        // Update citations using batched updateMany for efficiency
        // Group by new text value to minimize database round trips: O(k) where k = distinct text values
        for (const [newRawText, ids] of citationsByNewText) {
          await tx.citation.updateMany({
            where: { id: { in: ids } },
            data: { rawText: newRawText }
          });
        }

        // Create CitationChange record for the deleted reference
        // Format depends on citation style - Chicago uses footnotes without [N] prefix
        const docStyle = referenceToDelete.document.referenceListStyle?.toLowerCase() || '';
        const isChicagoStyle = docStyle.includes('chicago') || docStyle.includes('turabian') || docStyle.includes('footnote');

        // For Chicago/footnote style, store just the reference text (footnotes don't have [N] prefix)
        // For other styles (Vancouver, APA numbered), include the [N] prefix
        const deleteBeforeText = isChicagoStyle
          ? deletedRefText
          : `[${deletedPosition}] ${deletedRefText}`;

        // Use actual document ID from reference (URL param might be jobId)
        const actualDocumentId = referenceToDelete.documentId;

        await tx.citationChange.create({
          data: {
            documentId: actualDocumentId,
            citationId: null,
            changeType: 'DELETE',
            beforeText: deleteBeforeText,
            afterText: '', // Empty for deletions - no "after" text
            // Store structured metadata separately for export processing
            // Includes full reference data for undo/dismiss restore
            metadata: {
              position: deletedPosition,
              style: docStyle,
              isFootnoteStyle: isChicagoStyle,
              // Full reference data for undo restore
              referenceId: referenceId,
              referenceData: {
                authors: referenceToDelete.authors,
                year: referenceToDelete.year,
                title: referenceToDelete.title,
                sourceType: referenceToDelete.sourceType,
                journalName: referenceToDelete.journalName,
                volume: referenceToDelete.volume,
                issue: referenceToDelete.issue,
                pages: referenceToDelete.pages,
                publisher: referenceToDelete.publisher,
                doi: referenceToDelete.doi,
                url: referenceToDelete.url,
                enrichmentSource: referenceToDelete.enrichmentSource,
                enrichmentConfidence: referenceToDelete.enrichmentConfidence,
                formattedApa: referenceToDelete.formattedApa,
                formattedMla: referenceToDelete.formattedMla,
                formattedChicago: referenceToDelete.formattedChicago,
                formattedVancouver: referenceToDelete.formattedVancouver,
                formattedIeee: referenceToDelete.formattedIeee,
                sortKey: referenceToDelete.sortKey,
              },
              // Store the old→new number map for reversing renumber
              renumberMap: Object.fromEntries(oldToNewNumber),
              // Store citation text updates for restoration
              citationUpdates: citationUpdates.map(u => ({ id: u.id, oldRawText: u.oldRawText, newRawText: u.newRawText })),
              // Store original fullHtml/fullText for perfect restoration
              oldFullHtml: referenceToDelete.document.documentContent?.fullHtml || null,
              oldFullText: referenceToDelete.document.documentContent?.fullText || null,
            },
            appliedBy: 'user',
            isReverted: false
          }
        });

        // Create DELETE CitationChange records for TRULY ORPHANED in-text citations
        // A citation is orphaned only if ALL its referenced numbers are deleted
        // Citations that still reference other valid references get RENUMBER, not DELETE
        // This handles author-year style citations like "(Bender et al., 2021)"

        // Build set of citation IDs that will be truly renumbered (exclude those marked as orphaned)
        // Citations with newRawText === '[orphaned]' are not being renumbered, they're being deleted
        const renumberedCitationIds = new Set(
          citationUpdates
            .filter(u => u.newRawText !== '[orphaned]')
            .map(u => u.id)
        );

        // First try explicit links, then fall back to text matching
        let affectedCitations = citations.filter(c => affectedCitationIds.includes(c.id));

        // If no explicit links, find citations by matching author surname + year
        if (affectedCitations.length === 0 && referenceToDelete.year) {
          const authors = safeAuthorsArray(referenceToDelete.authors);
          const firstAuthor = authors?.[0] || '';
          // Extract surname (handles "Smith, J." -> "Smith" or "Smith J" -> "Smith")
          const surname = firstAuthor.split(/[,\s]/)[0];
          const year = referenceToDelete.year;

          if (surname) {
            // Match citations containing author surname and year
            // e.g., "(Bender et al., 2021)" or "Bender et al., 2021"
            affectedCitations = citations.filter(c => {
              const text = c.rawText.toLowerCase();
              return text.includes(surname.toLowerCase()) && text.includes(year);
            });
            logger.info(`[CitationReference] Found ${affectedCitations.length} citations by text match for "${surname}" (${year})`);
          }
        }

        // Only create DELETE changes for citations that are TRULY orphaned
        // (not being renumbered to a new valid text)
        const trulyOrphanedCitations = affectedCitations.filter(c => !renumberedCitationIds.has(c.id));
        logger.info(`[CitationReference] ${affectedCitations.length} affected citations, ${trulyOrphanedCitations.length} truly orphaned`);

        // Store citation ID and position info for ID-based lookup during export
        for (const citation of trulyOrphanedCitations) {
          if (citation.rawText) {
            await tx.citationChange.create({
              data: {
                documentId: actualDocumentId,
                citationId: citation.id,
                changeType: 'DELETE',
                beforeText: citation.rawText,
                afterText: '', // Empty for deletions - no "after" text
                // Store position info in metadata for ID-based lookup during export
                metadata: {
                  citationId: citation.id,
                  startOffset: citation.startOffset,
                  endOffset: citation.endOffset
                },
                appliedBy: 'system',
                isReverted: false
              }
            });
          }
        }

        // Create CitationChange records for renumbered citations (unique text changes only)
        const uniqueRenumberChanges = new Map<string, string>();
        for (const update of citationUpdates) {
          // Skip if already have this old->new mapping
          if (!uniqueRenumberChanges.has(update.oldRawText)) {
            uniqueRenumberChanges.set(update.oldRawText, update.newRawText);
          }
        }

        if (uniqueRenumberChanges.size > 0) {
          const renumberChanges = [...uniqueRenumberChanges.entries()].map(([oldText, newText]) => ({
            documentId: actualDocumentId,
            citationId: null,
            changeType: 'RENUMBER' as const,
            beforeText: oldText,
            afterText: newText,
            appliedBy: 'system',
            isReverted: false
          }));

          await tx.citationChange.createMany({ data: renumberChanges });
        }

        // Update fullHtml and fullText in DocumentContent with renumbered citations
        // Uses updateCitationNumbersInHtmlWithDeletion which properly handles ranges like [3-5]
        if (referenceToDelete.document.documentContent && oldToNewNumber.size > 0) {
          const updateData: { fullHtml?: string; fullText?: string } = {};

          // Convert Map<number, number | null> to the format the helper expects
          // Filter out null values for renumbering, keep track of deleted numbers
          const renumberMap = new Map<number, number>();
          for (const [oldNum, newNum] of oldToNewNumber) {
            if (newNum !== null) {
              renumberMap.set(oldNum, newNum);
            }
          }

          if (referenceToDelete.document.documentContent.fullHtml) {
            updateData.fullHtml = this.updateCitationNumbersInHtml(
              referenceToDelete.document.documentContent.fullHtml,
              renumberMap,
              true // isDeletion = true to handle orphaned citations
            );
          }

          if (referenceToDelete.document.documentContent.fullText) {
            updateData.fullText = this.updateCitationNumbersInHtml(
              referenceToDelete.document.documentContent.fullText,
              renumberMap,
              true // isDeletion = true
            );
          }

          if (Object.keys(updateData).length > 0) {
            await tx.editorialDocumentContent.update({
              where: { documentId: actualDocumentId },
              data: updateData
            });

            logger.info(`[CitationReference] Updated documentContent after delete with renumbered citations`);
          }
        }
      });

      // IMPORTANT: Rebuild citation-reference links after renumbering
      // The links need to match the NEW reference numbers in citation text
      // Use the actual document ID, not the param (which could be a job ID)
      // Note: This runs after the main transaction commits. If it fails,
      // the delete is complete but links may be stale.
      const actualDocId = referenceToDelete.document.id;
      let linksCreated = 0;
      let linkRebuildWarning: string | undefined;
      try {
        linksCreated = await this.rebuildCitationLinks(actualDocId, tenantId);
      } catch (linkError) {
        const errorMessage = linkError instanceof Error ? linkError.message : 'Unknown error';
        linkRebuildWarning = `Citation-reference links may be stale. Error: ${errorMessage}. Refresh to reconcile.`;
        logger.warn(`[CitationReference] rebuildCitationLinks failed - ${linkRebuildWarning}`, linkError instanceof Error ? linkError : undefined);
      }

      res.json({
        success: true,
        data: {
          message: 'Reference deleted successfully',
          deletedReferenceId: referenceId,
          deletedPosition,
          affectedCitations: affectedCitationIds.length,
          remainingReferences: remainingReferences.length,
          linksRebuilt: linksCreated,
          ...(linkRebuildWarning && { warning: linkRebuildWarning })
        }
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Rebuild citation-reference links based on current sortKey values
   * Called after operations that change reference numbering (delete, reorder)
   * @param tx Optional transaction client - if provided, runs within existing transaction
   */
  private async rebuildCitationLinks(
    documentId: string,
    tenantId: string,
    tx?: TransactionClient
  ): Promise<number> {
    const db = tx || prisma;
    const document = await db.editorialDocument.findFirst({
      where: { id: documentId, tenantId },
      include: {
        citations: { orderBy: [{ paragraphIndex: 'asc' }, { startOffset: 'asc' }] },
        referenceListEntries: { orderBy: { sortKey: 'asc' } }
      }
    });

    if (!document) return 0;

    // Build reference number to ID map from current sortKey values
    const refNumToId = new Map<number, string>();
    for (const ref of document.referenceListEntries) {
      const num = parseInt(ref.sortKey) || 0;
      refNumToId.set(num, ref.id);
      logger.debug(`[CitationReference] rebuildLinks: ref ${num} -> ${ref.id.substring(0, 8)}`);
    }

    // Build author-year key to ID map for parenthetical citations
    // Keys like "Smith 2020", "Smith & Jones 2021", "Smith et al. 2022"
    // Known limitations (best-effort matching):
    // - Multi-particle names ("van der Berg") may not match correctly
    // - Non-standard punctuation variations may fail
    // - Citations with page numbers ("Smith, 2020, p. 45") will not match
    const authorYearToId = new Map<string, string>();
    for (const ref of document.referenceListEntries) {
      if (ref.authors && ref.year) {
        // Use parseAuthorsToArray to handle both string and object author formats
        const authors = parseAuthorsToArray(ref.authors);
        if (authors.length > 0 && authors[0].lastName) {
          // Extract surname only (handles "Bender EM" -> "Bender")
          let firstAuthor = authors[0].lastName.split(',')[0].split(' ')[0].trim();
          const year = ref.year;

          // Single author: "Smith 2020"
          if (authors.length === 1) {
            const key = `${firstAuthor} ${year}`.toLowerCase();
            authorYearToId.set(key, ref.id);
            logger.info(`[CitationReference] rebuildLinks: Added key "${key}" -> ref ${ref.id.substring(0, 8)}`);
          }
          // Two authors: "Smith & Jones 2020", "Smith and Jones 2020"
          else if (authors.length === 2) {
            // Extract surname only (handles "Gebru T" -> "Gebru")
            const secondAuthor = authors[1].lastName.split(',')[0].split(' ')[0].trim();
            const keys = [
              `${firstAuthor} & ${secondAuthor} ${year}`.toLowerCase(),
              `${firstAuthor} and ${secondAuthor} ${year}`.toLowerCase(),
              `${firstAuthor}, ${secondAuthor} ${year}`.toLowerCase()
            ];
            keys.forEach(key => authorYearToId.set(key, ref.id));
            logger.info(`[CitationReference] rebuildLinks: Added keys for 2-author ref: "${keys[0]}" -> ref ${ref.id.substring(0, 8)}`);
          }
          // 3+ authors: "Smith et al. 2020"
          else {
            const keys = [
              `${firstAuthor} et al. ${year}`.toLowerCase(),
              `${firstAuthor} et al ${year}`.toLowerCase()
            ];
            keys.forEach(key => authorYearToId.set(key, ref.id));
            logger.info(`[CitationReference] rebuildLinks: Added keys for 3+ author ref: "${keys[0]}" -> ref ${ref.id.substring(0, 8)}`);
          }
        }
      }
    }

    // Create links for all citations
    const linkData: { citationId: string; referenceListEntryId: string }[] = [];
    logger.info(`[CitationReference] rebuildLinks: Processing ${document.citations.length} citations`);
    for (const citation of document.citations) {
      logger.info(`[CitationReference] rebuildLinks: Citation "${citation.rawText.substring(0, 40)}" type=${citation.citationType}`);

      // Use citationType as the primary signal to choose matching strategy,
      // not just text heuristics — prevents year-number false positives
      const isNumericType = ['NUMERIC', 'FOOTNOTE', 'ENDNOTE'].includes(citation.citationType);
      if (isNumericType) {
        // Handle numeric citations (e.g., "[1]", "[1,2]", "[3-5]")
        const nums = this.expandCitationNumbers(citation.rawText);
        for (const num of nums) {
          const refId = refNumToId.get(num);
          if (refId) {
            linkData.push({
              citationId: citation.id,
              referenceListEntryId: refId
            });
            logger.debug(`[CitationReference] rebuildLinks: citation "${citation.rawText}" -> ref ${num}`);
          }
        }
      }
      // Handle parenthetical/narrative author-year citations (e.g., "(Smith, 2020)", "(Smith & Jones, 2021)")
      else if (citation.citationType === 'PARENTHETICAL' || citation.citationType === 'NARRATIVE') {
        // Normalize citation text for matching:
        // "(Bommasani, R. et al., 2026)" -> "bommasani et al. 2026"
        const normalizedText = citation.rawText
          .replace(/[()[\]]/g, '') // Remove brackets
          .replace(/,\s*[A-Z]\.\s*/g, ' ') // Remove initials like ", R. " -> " "
          .replace(/\s+[A-Z]\.\s*/g, ' ') // Remove initials like " R. " -> " "
          .replace(/,\s*(\d{4})/g, ' $1') // "Smith, 2020" -> "Smith 2020"
          .replace(/\s+/g, ' ') // Collapse multiple spaces
          .trim()
          .toLowerCase();

        logger.info(`[CitationReference] rebuildLinks: Trying to match citation "${citation.rawText}" -> normalized: "${normalizedText}"`);

        const refId = authorYearToId.get(normalizedText);
        if (refId) {
          linkData.push({
            citationId: citation.id,
            referenceListEntryId: refId
          });
          logger.info(`[CitationReference] rebuildLinks: MATCHED author-year citation "${citation.rawText}" -> ref ${refId.substring(0, 8)}`);
        } else {
          logger.warn(`[CitationReference] rebuildLinks: NO MATCH for citation "${citation.rawText}" (normalized: "${normalizedText}")`);
        }
      }
    }

    // Delete existing links and create new ones atomically
    const refIds = document.referenceListEntries.map(r => r.id);

    // If we have a transaction client, use it directly
    // Otherwise wrap in a new transaction for atomicity
    const doLinkUpdates = async (client: TransactionClient) => {
      if (refIds.length > 0) {
        await client.referenceListEntryCitation.deleteMany({
          where: { referenceListEntryId: { in: refIds } }
        });
      }

      if (linkData.length > 0) {
        await client.referenceListEntryCitation.createMany({
          data: linkData,
          skipDuplicates: true
        });
      }
    };

    if (tx) {
      // Already inside a transaction - use provided client directly
      await doLinkUpdates(tx);
    } else {
      // No transaction provided - create new one for atomicity
      await prisma.$transaction(async (newTx) => {
        await doLinkUpdates(newTx);
      });
    }

    logger.info(`[CitationReference] rebuildLinks: Created ${linkData.length} links for document ${documentId}`);
    return linkData.length;
  }

  /**
   * PATCH /api/v1/citation-management/document/:documentId/reference/:referenceId
   * Edit a reference
   *
   * Request body is validated by editReferenceSchema middleware:
   * - authors: string[] (min 1 author if provided)
   * - year: 4-digit string
   * - title: string (1-1000 chars)
   * - journalName: string (1-500 chars)
   * - volume, issue, pages: string (max 50 chars)
   * - doi: valid DOI format (10.xxxx/...)
   * - url: valid URL format
   * - publisher: string (max 500 chars)
   */
  /**
   * PATCH /api/v1/citation-management/document/:documentId/reference/:referenceId
   * Edit a reference
   *
   * NOTE: The :documentId param can be either a document ID or a job ID.
   */
  async editReference(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId, referenceId } = req.params;
      // Body is pre-validated by editReferenceSchema middleware
      const updates: EditReferenceBody = req.body;
      const { tenantId } = req.user!;

      logger.info(`[CitationReference] Editing reference ${referenceId} in document ${documentId}`);

      // Resolve the document ID (handles both document ID and job ID)
      const baseDoc = await resolveDocumentSimple(documentId, tenantId);
      if (!baseDoc) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' }
        });
        return;
      }
      const resolvedDocId = baseDoc.id;

      const reference = await prisma.referenceListEntry.findUnique({
        where: { id: referenceId },
        include: {
          document: { include: { citations: true } }
        }
      });

      if (!reference) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Reference not found' }
        });
        return;
      }

      // CRITICAL: Verify tenant ownership
      if (reference.document.tenantId !== tenantId) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Reference not found' }
        });
        return;
      }

      // Verify document ID matches (comparing resolved ID)
      if (reference.documentId !== resolvedDocId) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_DOCUMENT', message: 'Reference does not belong to this document' }
        });
        return;
      }

      // Update the reference with validated fields
      // Note: authors is a JSON field in Prisma, so we need to handle the type appropriately
      const updatedReference = await prisma.referenceListEntry.update({
        where: { id: referenceId },
        data: {
          authors: updates.authors !== undefined ? updates.authors : undefined,
          year: updates.year !== undefined ? updates.year : undefined,
          title: updates.title !== undefined ? updates.title : undefined,
          journalName: updates.journalName !== undefined ? updates.journalName : undefined,
          volume: updates.volume !== undefined ? updates.volume : undefined,
          issue: updates.issue !== undefined ? updates.issue : undefined,
          pages: updates.pages !== undefined ? updates.pages : undefined,
          doi: updates.doi !== undefined ? (updates.doi || null) : undefined, // Empty string clears DOI
          url: updates.url !== undefined ? (updates.url || null) : undefined, // Empty string clears URL
          publisher: updates.publisher !== undefined ? updates.publisher : undefined,
        }
      });

      // Regenerate formatted field based on document's reference list style
      const styleCode = normalizeStyleCode(reference.document.referenceListStyle);
      const formattedColumn = getFormattedColumn(styleCode);

      logger.info(`[CitationReference] Regenerating formatted text for reference ${referenceId} with style ${styleCode} (column: ${formattedColumn})`);

      // Build ReferenceEntry object for formatting
      const entryForFormatting = {
        id: updatedReference.id,
        sortKey: updatedReference.sortKey,
        authors: parseAuthorsToArray(updatedReference.authors),
        year: updatedReference.year,
        title: updatedReference.title,
        sourceType: updatedReference.sourceType,
        journalName: updatedReference.journalName,
        volume: updatedReference.volume,
        issue: updatedReference.issue,
        pages: updatedReference.pages,
        publisher: updatedReference.publisher,
        doi: updatedReference.doi,
        url: updatedReference.url,
        enrichmentSource: updatedReference.enrichmentSource,
        enrichmentConfidence: updatedReference.enrichmentConfidence
      };

      // Call formatReference to regenerate the formatted text
      // On failure, continue without formatted text update but still create REFERENCE_EDIT records
      let formatResult: { formatted: string } | null = null;
      try {
        formatResult = await referenceListService.formatReference(entryForFormatting, styleCode);
        logger.info(`[CitationReference] Format result received successfully`);
      } catch (formatError) {
        logger.error(`[CitationReference] formatReference failed - continuing without formatted text update:`, formatError instanceof Error ? formatError : undefined);
        // formatResult remains null, which is handled below
      }

      // Check if any field changed - store for potential revert
      const oldAuthors = reference.authors;
      const oldYear = reference.year;
      const oldTitle = reference.title;
      const oldPublisher = reference.publisher;
      const newAuthors = updatedReference.authors;
      const newYear = updatedReference.year;

      const authorsChanged = JSON.stringify(oldAuthors) !== JSON.stringify(newAuthors);
      const yearChanged = oldYear !== newYear;

      logger.debug(`[CitationReference] Change detection: authorsChanged=${authorsChanged}, yearChanged=${yearChanged}, oldYear=${oldYear}, newYear=${newYear}`);

      // If the old formatted text is missing, generate it now so export can find/replace
      // This handles references that were uploaded before formatted text generation was implemented
      let oldFormattedText = (reference as Record<string, unknown>)[formattedColumn] as string | null;
      if (!oldFormattedText) {
        logger.info(`[CitationReference] Old formatted text missing for ${formattedColumn}, generating from old values...`);
        try {
          const oldEntryForFormatting = {
            id: reference.id,
            sortKey: reference.sortKey,
            authors: parseAuthorsToArray(oldAuthors),
            year: oldYear,
            title: oldTitle,
            sourceType: reference.sourceType,
            journalName: reference.journalName,
            volume: reference.volume,
            issue: reference.issue,
            pages: reference.pages,
            publisher: oldPublisher,
            doi: reference.doi,
            url: reference.url,
            enrichmentSource: reference.enrichmentSource,
            enrichmentConfidence: reference.enrichmentConfidence
          };
          const oldFormatResult = await referenceListService.formatReference(oldEntryForFormatting, styleCode);
          oldFormattedText = oldFormatResult.formatted;
          logger.info(`[CitationReference] Generated old formatted text: "${oldFormattedText?.substring(0, 80)}..."`);
        } catch {
          logger.warn(`[CitationReference] Failed to generate old formatted text, export may not update reference section`);
        }
      }

      // Prepare reference edit metadata for change tracking
      // Use the generated oldFormattedText for the current style column
      const referenceEditMetadata = {
        referenceId: referenceId,
        oldValues: {
          authors: oldAuthors,
          year: oldYear,
          title: oldTitle,
          publisher: oldPublisher,
          journalName: reference.journalName,
          volume: reference.volume,
          issue: reference.issue,
          pages: reference.pages,
          doi: reference.doi,
          url: reference.url,
          // Use generated oldFormattedText for the appropriate style column
          formattedApa: formattedColumn === 'formattedApa' ? oldFormattedText : reference.formattedApa,
          formattedMla: formattedColumn === 'formattedMla' ? oldFormattedText : reference.formattedMla,
          formattedChicago: formattedColumn === 'formattedChicago' ? oldFormattedText : reference.formattedChicago,
          formattedVancouver: formattedColumn === 'formattedVancouver' ? oldFormattedText : reference.formattedVancouver,
          formattedIeee: formattedColumn === 'formattedIeee' ? oldFormattedText : reference.formattedIeee
        },
        newValues: {
          authors: newAuthors,
          year: newYear,
          title: updatedReference.title,
          publisher: updatedReference.publisher,
          journalName: updatedReference.journalName,
          volume: updatedReference.volume,
          issue: updatedReference.issue,
          pages: updatedReference.pages,
          doi: updatedReference.doi,
          url: updatedReference.url
        }
      };

      // Wrap all DB writes in a single transaction to ensure consistency
      // This includes: formatted text update (if available), change record creation, and in-text citation changes
      const { finalReference, citationChangesCreated } = await prisma.$transaction(async (tx) => {
        // Update the reference - conditionally include formatted text if formatResult exists
        const updateData: Prisma.ReferenceListEntryUpdateInput = {
          isEdited: true,
          editedAt: new Date()
        };

        // Only update formatted text if formatting succeeded
        if (formatResult) {
          // Use type assertion since formattedColumn is a valid column name from getFormattedColumn
          (updateData as Record<string, unknown>)[formattedColumn] = formatResult.formatted;
        }

        const finalRef = await tx.referenceListEntry.update({
          where: { id: referenceId },
          data: updateData
        });

        logger.info(`[CitationReference] Reference ${referenceId} updated${formatResult ? ' and reformatted' : ' (formatting skipped)'} with ${styleCode} style`);

        // Create a reference edit change record (no citationId - this is for the reference itself)
        await tx.citationChange.create({
          data: {
            documentId: resolvedDocId,
            citationId: null, // null means this is a reference-level change
            changeType: 'REFERENCE_EDIT',
            beforeText: `Reference: ${oldTitle}`,
            afterText: `Reference: ${updatedReference.title}`,
            metadata: referenceEditMetadata as unknown as Prisma.InputJsonValue,
            appliedBy: 'user',
            isReverted: false
          }
        });
        logger.info(`[CitationReference] Created REFERENCE_EDIT change record for reference ${referenceId}`);

        let changesCreated = 0;

        // If author or year changed, also create changes for linked in-text citations
        if (authorsChanged || yearChanged) {
          logger.info(`[CitationReference] Author/year changed, updating linked in-text citations`);

          // Find citations linked to this reference
          let linkedCitations = await tx.referenceListEntryCitation.findMany({
            where: { referenceListEntryId: referenceId },
            include: {
              citation: true
            }
          });

          logger.info(`[CitationReference] Found ${linkedCitations.length} linked citations`);

          // If no links found but document has citations, rebuild links and retry
          // This ensures links are always up-to-date even if they were missing or broken
          if (linkedCitations.length === 0 && reference.document.citations.length > 0) {
            logger.info(`[CitationReference] No links found, rebuilding citation-reference links...`);

            // Rebuild links within the transaction
            const linksCreated = await this.rebuildCitationLinks(resolvedDocId, tenantId, tx);
            logger.info(`[CitationReference] Rebuilt ${linksCreated} links, retrying find...`);

            // Retry finding linked citations
            linkedCitations = await tx.referenceListEntryCitation.findMany({
              where: { referenceListEntryId: referenceId },
              include: {
                citation: true
              }
            });
            logger.info(`[CitationReference] After rebuild: Found ${linkedCitations.length} linked citations`);
          }

          // Format new author text for in-text citation
          const newAuthorText = formatAuthorsForInTextCitation(parseAuthorsToArray(newAuthors), styleCode);
          const processedCitationIds = new Set<string>();

          // Process linked citations
          for (const link of linkedCitations) {
            const citation = link.citation;
            logger.info(`[CitationReference] Processing linked citation ${citation.id}, type=${citation.citationType}`);

            // Only update PARENTHETICAL (author-year) citations
            if (citation.citationType === 'PARENTHETICAL') {
              // Generate new citation text based on updated author/year
              const newCitationText = `(${newAuthorText}, ${newYear || 'n.d.'})`;

              // Create CitationChange record (beforeText uses actual citation.rawText)
              await tx.citationChange.create({
                data: {
                  documentId: resolvedDocId,
                  citationId: citation.id,
                  changeType: 'REFERENCE_EDIT',
                  beforeText: citation.rawText,
                  afterText: newCitationText,
                  metadata: { referenceId } as unknown as Prisma.InputJsonValue,
                  appliedBy: 'user',
                  isReverted: false
                }
              });

              // IMPORTANT: Also update Citation.rawText so rebuildCitationLinks can match it later
              // This ensures that if rebuildCitationLinks runs after a delete, the citation text
              // matches the updated reference author/year
              await tx.citation.update({
                where: { id: citation.id },
                data: { rawText: newCitationText }
              });

              processedCitationIds.add(citation.id);
              changesCreated++;
              logger.info(`[CitationReference] Created CitationChange and updated Citation.rawText for ${citation.id}: "${citation.rawText}" -> "${newCitationText}"`);
            }
          }

          // Final warning if still no links after rebuild
          if (linkedCitations.length === 0 && reference.document.citations.length > 0) {
            logger.warn(`[CitationReference] Still no linked citations found for reference ${referenceId} after rebuild. Citation format may not match reference author/year.`);
          }
        }

        return { finalReference: finalRef, citationChangesCreated: changesCreated };
      });

      res.json({
        success: true,
        data: {
          message: citationChangesCreated > 0
            ? `Reference updated successfully. ${citationChangesCreated} in-text citation(s) will be updated.`
            : 'Reference updated successfully',
          reference: {
            id: finalReference.id,
            authors: finalReference.authors,
            year: finalReference.year,
            title: finalReference.title,
            journalName: finalReference.journalName,
            volume: finalReference.volume,
            issue: finalReference.issue,
            pages: finalReference.pages,
            doi: finalReference.doi,
            url: finalReference.url,
            publisher: finalReference.publisher,
            // Only include formatted text if formatting succeeded
            ...(formatResult ? { [formattedColumn]: formatResult.formatted } : {}),
            isEdited: finalReference.isEdited,
            editedAt: finalReference.editedAt
          },
          citationChangesCreated
        }
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/v1/citation-management/document/:documentId/reset-changes
   * Reset all citation changes for a document (clears partial resequencing)
   *
   * NOTE: The :documentId param can be either a document ID or a job ID.
   */
  async resetChanges(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const { tenantId } = req.user!;

      logger.info(`[CitationReference] Resetting citation changes for ${documentId}`);

      // Resolve document (handles both document ID and job ID)
      const document = await resolveDocumentSimple(documentId, tenantId);

      if (!document) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' }
        });
        return;
      }

      const resolvedDocId = document.id;

      // First, find and revert any REFERENCE_EDIT changes
      // Order by appliedAt ASC to get the earliest (original) change first for each reference
      const referenceEditChanges = await prisma.citationChange.findMany({
        where: {
          documentId: resolvedDocId,
          changeType: 'REFERENCE_EDIT',
          isReverted: false,
          citationId: null // Reference-level changes have null citationId
        },
        orderBy: { appliedAt: 'asc' }
      });

      // Group by referenceId and only use the EARLIEST change's oldValues (true original state)
      // This handles the case where a reference was edited multiple times
      const earliestChangeByRefId = new Map<string, typeof referenceEditChanges[0]>();
      for (const change of referenceEditChanges) {
        if (change.metadata && typeof change.metadata === 'object') {
          const metadata = change.metadata as { referenceId?: string };
          if (metadata.referenceId && !earliestChangeByRefId.has(metadata.referenceId)) {
            earliestChangeByRefId.set(metadata.referenceId, change);
          }
        }
      }

      // Wrap entire revert + delete in a transaction to ensure atomicity
      // If any revert fails, the entire operation rolls back
      const { referencesReverted, changesDeleted } = await prisma.$transaction(async (tx) => {
        let reverted = 0;

        // Batch revert all references concurrently to reduce N+1 queries
        const revertPromises: Promise<unknown>[] = [];
        for (const [refId, change] of earliestChangeByRefId) {
          const metadata = change.metadata as {
            referenceId?: string;
            oldValues?: {
              authors?: unknown;
              year?: string | null;
              title?: string;
              publisher?: string | null;
              journalName?: string | null;
              volume?: string | null;
              issue?: string | null;
              pages?: string | null;
              doi?: string | null;
              url?: string | null;
              formattedApa?: string | null;
              formattedMla?: string | null;
              formattedChicago?: string | null;
              formattedVancouver?: string | null;
              formattedIeee?: string | null;
            };
          };

          if (metadata.oldValues) {
            revertPromises.push(
              tx.referenceListEntry.update({
                where: { id: refId },
                data: {
                  authors: metadata.oldValues.authors as Prisma.InputJsonValue,
                  year: metadata.oldValues.year,
                  title: metadata.oldValues.title || '',
                  publisher: metadata.oldValues.publisher,
                  journalName: metadata.oldValues.journalName,
                  volume: metadata.oldValues.volume,
                  issue: metadata.oldValues.issue,
                  pages: metadata.oldValues.pages,
                  doi: metadata.oldValues.doi,
                  url: metadata.oldValues.url,
                  formattedApa: metadata.oldValues.formattedApa,
                  formattedMla: metadata.oldValues.formattedMla,
                  formattedChicago: metadata.oldValues.formattedChicago,
                  formattedVancouver: metadata.oldValues.formattedVancouver,
                  formattedIeee: metadata.oldValues.formattedIeee,
                  isEdited: false,
                  editedAt: null
                }
              })
            );
            reverted++;
          }
        }
        if (revertPromises.length > 0) {
          await Promise.all(revertPromises);
          logger.info(`[CitationReference] Batch-reverted ${reverted} references to original values`);
        }

        // Delete all CitationChange records for this document
        const result = await tx.citationChange.deleteMany({
          where: { documentId: resolvedDocId }
        });

        return { referencesReverted: reverted, changesDeleted: result.count };
      });

      logger.info(`[CitationReference] Deleted ${changesDeleted} CitationChange records, reverted ${referencesReverted} references for document ${resolvedDocId}`);

      res.json({
        success: true,
        data: {
          message: `Reset complete. Deleted ${changesDeleted} change records, reverted ${referencesReverted} reference(s).`,
          deletedCount: changesDeleted,
          referencesReverted
        }
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/v1/citation-management/document/:documentId/dismiss-changes
   * Dismiss specific changes by their IDs.
   * For DELETE changes: performs a full undo (recreates reference, restores citations, restores HTML).
   * For other changes: marks as reverted (soft dismiss).
   */
  async dismissChanges(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      // Validated by Zod schema: 1-100 UUIDs required
      const { changeIds } = req.body as { changeIds: string[] };
      const { tenantId } = req.user!;

      logger.info(`[CitationReference] Dismissing ${changeIds.length} changes for document ${documentId}`);

      const document = await resolveDocumentSimple(documentId, tenantId);

      if (!document) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' }
        });
        return;
      }

      const resolvedDocId = document.id;

      // Fetch the actual changes to check if any are DELETE type
      const changes = await prisma.citationChange.findMany({
        where: {
          id: { in: changeIds },
          documentId: resolvedDocId,
          isReverted: false
        }
      });

      if (changes.length === 0) {
        res.json({
          success: true,
          data: { message: 'No changes to dismiss', dismissedCount: 0 }
        });
        return;
      }

      // Check for DELETE changes that need full undo (appliedBy: 'user' means it's the reference deletion)
      const deleteChanges = changes.filter(c => c.changeType === 'DELETE' && c.appliedBy === 'user');
      const nonDeleteChangeIds = changes.filter(c => !(c.changeType === 'DELETE' && c.appliedBy === 'user')).map(c => c.id);

      let totalDismissed = 0;
      let referencesRestored = 0;
      let linkRebuildWarning: string | undefined;

      // Handle full undo for DELETE changes
      for (const deleteChange of deleteChanges) {
        const metadata = deleteChange.metadata as Record<string, unknown> | null;
        const deletedPosition = (metadata?.position as number) || 0;
        const hasFullData = !!metadata?.referenceData;

        // Build reference data: from stored metadata (new format) or parsed from beforeText (legacy)
        let refData: Record<string, unknown>;
        let refId: string;
        let storedCitationUpdates: Array<{ id: string; oldRawText: string; newRawText: string }>;
        let oldFullHtml: string | null;
        let oldFullText: string | null;

        if (hasFullData) {
          refData = metadata!.referenceData as Record<string, unknown>;
          refId = metadata!.referenceId as string;
          storedCitationUpdates = (metadata!.citationUpdates || []) as Array<{ id: string; oldRawText: string; newRawText: string }>;
          oldFullHtml = metadata!.oldFullHtml as string | null;
          oldFullText = metadata!.oldFullText as string | null;
        } else {
          // Legacy DELETE change: parse reference from beforeText
          logger.info(`[CitationReference] Legacy DELETE change ${deleteChange.id}: parsing reference from beforeText`);
          const parsed = this.parseReferenceFromBeforeText(deleteChange.beforeText || '', deletedPosition);
          // Use a fractional sortKey that slots BEFORE the current ref at this position
          // e.g., position 2 → "0001.5" so it sorts between "0001" and "0002"
          const insertSortKey = deletedPosition > 1
            ? String(deletedPosition - 1).padStart(4, '0') + '.5'
            : '0000.5';
          refData = {
            ...parsed,
            sortKey: insertSortKey,
            enrichmentSource: 'restored',
            enrichmentConfidence: 0,
          };
          refId = randomUUID();
          storedCitationUpdates = [];
          oldFullHtml = null;
          oldFullText = null;

          // For legacy changes (without stored citationUpdates), find related system-generated
          // DELETE changes within a 5-second window to restore citation text.
          // This window groups changes that were created atomically in the same operation.
          const deleteAppliedAt = deleteChange.appliedAt;
          const timeWindowMs = 5000;
          const windowStart = new Date(deleteAppliedAt.getTime() - timeWindowMs);
          const windowEnd = new Date(deleteAppliedAt.getTime() + timeWindowMs);
          const relatedSystemDeletes = await prisma.citationChange.findMany({
            where: {
              documentId: resolvedDocId,
              changeType: 'DELETE',
              appliedBy: 'system',
              appliedAt: { gte: windowStart, lte: windowEnd },
              citationId: { not: null }
            }
          });
          for (const sysDel of relatedSystemDeletes) {
            if (sysDel.citationId && sysDel.beforeText) {
              storedCitationUpdates.push({
                id: sysDel.citationId,
                oldRawText: sysDel.beforeText,
                newRawText: ''
              });
            }
          }
          logger.info(`[CitationReference] Found ${relatedSystemDeletes.length} related system DELETE changes for citation restoration`);
        }

        logger.info(`[CitationReference] Full undo of DELETE change ${deleteChange.id}: restoring reference at position ${deletedPosition} (${hasFullData ? 'full metadata' : 'legacy parsed'})`);

        await prisma.$transaction(async (tx) => {
          // 1. Use a temporary sortKey to avoid conflicts, will be fixed in step 2
          await tx.referenceListEntry.create({
            data: {
              id: refId,
              documentId: resolvedDocId,
              sortKey: '9999', // Temporary, overwritten in step 2
              authors: (refData.authors || []) as Prisma.InputJsonValue,
              year: (refData.year as string) || null,
              title: (refData.title as string) || '',
              sourceType: (refData.sourceType as string) && (refData.sourceType as string) !== 'unknown'
                ? (refData.sourceType as string) : 'journal_article',
              journalName: (refData.journalName as string) || null,
              volume: (refData.volume as string) || null,
              issue: (refData.issue as string) || null,
              pages: (refData.pages as string) || null,
              publisher: (refData.publisher as string) || null,
              doi: (refData.doi as string) || null,
              url: (refData.url as string) || null,
              enrichmentSource: (refData.enrichmentSource as string) || 'manual',
              enrichmentConfidence: (refData.enrichmentConfidence as number) || 0,
              formattedApa: (refData.formattedApa as string) || null,
              formattedMla: (refData.formattedMla as string) || null,
              formattedChicago: (refData.formattedChicago as string) || null,
              formattedVancouver: (refData.formattedVancouver as string) || null,
              formattedIeee: (refData.formattedIeee as string) || null,
            }
          });
          logger.info(`[CitationReference] Recreated ReferenceListEntry ${refId}`);

          // 2. Insert the restored ref at its original position and re-number all
          // Get existing refs (excluding the restored one) in their current order
          const existingRefs = await tx.referenceListEntry.findMany({
            where: { documentId: resolvedDocId, id: { not: refId } },
            orderBy: { sortKey: 'asc' }
          });

          // Insert restored ref at its original position (1-indexed)
          const insertIdx = Math.max(0, Math.min(deletedPosition - 1, existingRefs.length));
          const ordered = [...existingRefs];
          ordered.splice(insertIdx, 0, { id: refId } as typeof existingRefs[0]);

          // Assign sequential sortKeys concurrently
          if (ordered.length > 0) {
            await Promise.all(ordered.map((ref, i) =>
              tx.referenceListEntry.update({
                where: { id: ref.id },
                data: { sortKey: String(i + 1).padStart(4, '0') }
              })
            ));
            logger.info(`[CitationReference] Inserted restored ref at position ${deletedPosition}, re-sorted ${ordered.length} references`);
          }

          // 3. Restore citation rawText values from stored citationUpdates
          // Restore ALL affected citations: both DELETE-cleared (rawText='') and RENUMBER-updated ones
          // Group by oldRawText to batch updates and reduce N+1 queries
          const citationsByOldText = new Map<string, string[]>();
          for (const update of storedCitationUpdates) {
            const ids = citationsByOldText.get(update.oldRawText) || [];
            ids.push(update.id);
            citationsByOldText.set(update.oldRawText, ids);
          }
          for (const [oldRawText, ids] of citationsByOldText) {
            const result = await tx.citation.updateMany({
              where: { id: { in: ids } },
              data: { rawText: oldRawText }
            });
            if (result.count > 0) {
              logger.info(`[CitationReference] Batch-restored ${result.count} citations to rawText="${oldRawText}"`);
            }
          }

          // 4. Restore fullHtml/fullText from stored originals (only available for new-format changes)
          if (oldFullHtml || oldFullText) {
            const updateData: { fullHtml?: string; fullText?: string } = {};
            if (oldFullHtml) updateData.fullHtml = oldFullHtml;
            if (oldFullText) updateData.fullText = oldFullText;

            await tx.editorialDocumentContent.update({
              where: { documentId: resolvedDocId },
              data: updateData
            });
            logger.info(`[CitationReference] Restored fullHtml/fullText from stored originals`);
          }

          // 5. Mark the DELETE change and all related system-generated changes as reverted.
          // The 5-second time window is a legacy heuristic to group the main DELETE with
          // system-generated RENUMBER changes that were created in the same operation.
          // We narrow with appliedBy='system' so that only machine-generated side-effects
          // are bulk-reverted — the main DELETE change is reverted by ID.
          await tx.citationChange.update({
            where: { id: deleteChange.id },
            data: { isReverted: true }
          });

          const deleteAppliedAt = deleteChange.appliedAt;
          const timeWindowMs = 5000;
          const windowStart = new Date(deleteAppliedAt.getTime() - timeWindowMs);
          const windowEnd = new Date(deleteAppliedAt.getTime() + timeWindowMs);

          await tx.citationChange.updateMany({
            where: {
              documentId: resolvedDocId,
              isReverted: false,
              appliedBy: 'system',
              appliedAt: { gte: windowStart, lte: windowEnd },
              changeType: { in: ['DELETE', 'RENUMBER'] }
            },
            data: { isReverted: true }
          });
          logger.info(`[CitationReference] Marked DELETE and related system RENUMBER changes as reverted`);
        }, { timeout: 30000 });

        // 6. Rebuild citation-reference links outside the transaction
        try {
          await this.rebuildCitationLinks(resolvedDocId, tenantId);
          logger.info(`[CitationReference] Rebuilt citation-reference links after restore`);
        } catch (linkError) {
          const errorMessage = linkError instanceof Error ? linkError.message : 'Unknown error';
          linkRebuildWarning = `Citation-reference links may be stale after restore. Error: ${errorMessage}. Refresh to reconcile.`;
          logger.warn(`[CitationReference] rebuildCitationLinks failed after restore - ${linkRebuildWarning}`, linkError instanceof Error ? linkError : undefined);
        }

        referencesRestored++;
        totalDismissed++;
      }

      // Handle non-DELETE changes with simple soft dismiss
      if (nonDeleteChangeIds.length > 0) {
        const result = await prisma.citationChange.updateMany({
          where: {
            id: { in: nonDeleteChangeIds },
            documentId: resolvedDocId,
            isReverted: false
          },
          data: { isReverted: true }
        });
        totalDismissed += result.count;
      }

      logger.info(`[CitationReference] Dismissed ${totalDismissed} changes (${referencesRestored} DELETE undone) for document ${resolvedDocId}`);

      res.json({
        success: true,
        data: {
          message: referencesRestored > 0
            ? `Restored ${referencesRestored} deleted reference(s) and dismissed ${totalDismissed} change(s)`
            : `Dismissed ${totalDismissed} change(s)`,
          dismissedCount: totalDismissed,
          referencesRestored,
          ...(linkRebuildWarning && { warning: linkRebuildWarning })
        }
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/v1/citation-management/document/:documentId/create-links
   * Create citation-reference links for existing documents that don't have them
   *
   * NOTE: The :documentId param can be either a document ID or a job ID.
   */
  async createCitationLinks(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const { tenantId } = req.user!;

      logger.info(`[CitationReference] Creating citation-reference links for ${documentId}`);

      // Resolve document (handles both document ID and job ID)
      const baseDoc = await resolveDocumentSimple(documentId, tenantId);

      if (!baseDoc) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' }
        });
        return;
      }

      const document = await prisma.editorialDocument.findFirst({
        where: { id: baseDoc.id, tenantId },
        include: {
          citations: { orderBy: [{ paragraphIndex: 'asc' }, { startOffset: 'asc' }] },
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

      // === Links are the source of truth (tracker) ===
      // Preserve healthy links. Detect and repair corrupted links using fullHtml as ground truth.

      const refNumToId = new Map<number, string>();
      for (const ref of document.referenceListEntries) {
        const num = parseInt(ref.sortKey) || 0;
        refNumToId.set(num, ref.id);
      }

      // Get existing links
      const existingLinks = await prisma.referenceListEntryCitation.findMany({
        where: { citationId: { in: document.citations.map(c => c.id) } }
      });
      const citationLinks = new Map<string, string[]>();
      for (const link of existingLinks) {
        const refs = citationLinks.get(link.citationId) || [];
        refs.push(link.referenceListEntryId);
        citationLinks.set(link.citationId, refs);
      }

      // Detect corruption: duplicate rawText across citations that don't already have links.
      // IMPORTANT: Repeated citations like (2) appearing twice are LEGITIMATE (same ref cited
      // at different positions). Only flag corruption when citations lack links AND have duplicates,
      // indicating a failed reorder/delete that didn't update rawTexts properly.
      const numericCits = document.citations.filter(c => c.citationType === 'NUMERIC');
      const citsWithLinks = numericCits.filter(c => citationLinks.has(c.id) && (citationLinks.get(c.id)?.length || 0) > 0);
      const citsWithoutLinks = numericCits.filter(c => !citationLinks.has(c.id) || (citationLinks.get(c.id)?.length || 0) === 0);

      // Only check for duplicates among citations WITHOUT links (those are potentially corrupted)
      const rawTextCounts = new Map<string, number>();
      for (const c of citsWithoutLinks) {
        rawTextCounts.set(c.rawText, (rawTextCounts.get(c.rawText) || 0) + 1);
      }
      // Corruption = unlinked citations with duplicate rawTexts AND most citations lack links
      // If most citations already have links, the duplicates are legitimate repeated citations
      const hasDuplicates = [...rawTextCounts.values()].some(count => count > 1) &&
        citsWithoutLinks.length > citsWithLinks.length;

      // Load fullHtml to find actual citation markers in the document
      const docContent = await prisma.editorialDocumentContent.findUnique({
        where: { documentId: baseDoc.id }
      });
      const fullHtml = docContent?.fullHtml || '';

      // Extract actual citation numbers from fullHtml (parenthetical: "(1)", "(2)" etc.)
      const citationPattern = /(?:\((\d+)\)|\[(\d+)\])/g;
      const foundInHtml: { num: number; pos: number }[] = [];
      let match;
      while ((match = citationPattern.exec(fullHtml)) !== null) {
        const num = parseInt(match[1] || match[2], 10);
        // Only consider numbers within the reference range (avoid year numbers etc.)
        if (num >= 1 && num <= document.referenceListEntries.length) {
          foundInHtml.push({ num, pos: match.index });
        }
      }

      let rawTextUpdated = 0;
      let linksRepaired = 0;
      let linksCreated = 0;

      // If corruption detected AND we can match citations to fullHtml markers, repair
      if (hasDuplicates && foundInHtml.length >= numericCits.length) {
        logger.info(`[CitationReference] Detected corrupted rawText (duplicates found, ${citsWithoutLinks.length} unlinked). Repairing using fullHtml (${foundInHtml.length} markers found)`);

        // Citations are ordered by reading position (paragraphIndex, startOffset)
        // fullHtml markers are ordered by position in HTML
        // Match them 1:1 by reading order
        const numericCitations = numericCits;

        for (let i = 0; i < numericCitations.length && i < foundInHtml.length; i++) {
          const citation = numericCitations[i];
          const htmlMarker = foundInHtml[i];
          // Preserve original delimiter style (brackets vs parentheses)
          const useBrackets = citation.rawText.trim().startsWith('[');
          const expectedRawText = useBrackets ? `[${htmlMarker.num}]` : `(${htmlMarker.num})`;
          const expectedRefId = refNumToId.get(htmlMarker.num);

          // Update rawText if stale
          if (citation.rawText !== expectedRawText) {
            logger.info(`[CitationReference] Repairing rawText for citation ${citation.id}: "${citation.rawText}" → "${expectedRawText}"`);
            await prisma.citation.update({
              where: { id: citation.id },
              data: { rawText: expectedRawText }
            });
            citation.rawText = expectedRawText;
            rawTextUpdated++;
          }

          // Repair link if pointing to wrong reference
          if (expectedRefId) {
            const currentRefs = citationLinks.get(citation.id) || [];
            if (currentRefs.length !== 1 || currentRefs[0] !== expectedRefId) {
              // Delete wrong links for this citation
              await prisma.referenceListEntryCitation.deleteMany({
                where: { citationId: citation.id }
              });
              // Create correct link
              await prisma.referenceListEntryCitation.create({
                data: { citationId: citation.id, referenceListEntryId: expectedRefId }
              });
              linksRepaired++;
              logger.info(`[CitationReference] Repaired link for citation ${citation.id}: now → ref ${htmlMarker.num}`);
            }
          }
        }
      } else {
        // No corruption — preserve existing links, only add missing ones

        // Phase 1: For citations WITH healthy links, refresh rawText from the linked ref's position
        const refIdToNumber = new Map<string, number>();
        for (const ref of document.referenceListEntries) {
          refIdToNumber.set(ref.id, parseInt(ref.sortKey) || 0);
        }

        for (const citation of document.citations) {
          const linkedRefIds = citationLinks.get(citation.id);
          if (linkedRefIds && linkedRefIds.length > 0 && citation.citationType === 'NUMERIC') {
            const nums = linkedRefIds
              .map(refId => refIdToNumber.get(refId))
              .filter((n): n is number => n !== undefined)
              .sort((a, b) => a - b);

            if (nums.length > 0) {
              // Preserve original delimiter style (brackets vs parentheses)
              const useBrackets = citation.rawText.trim().startsWith('[');
              const inner = nums.length === 1 ? `${nums[0]}` : nums.join(', ');
              const expectedRawText = useBrackets ? `[${inner}]` : `(${inner})`;

              if (citation.rawText !== expectedRawText) {
                logger.info(`[CitationReference] Refreshing rawText for citation ${citation.id}: "${citation.rawText}" → "${expectedRawText}"`);
                await prisma.citation.update({
                  where: { id: citation.id },
                  data: { rawText: expectedRawText }
                });
                citation.rawText = expectedRawText;
                rawTextUpdated++;
              }
            }
          }
        }

        // Phase 2: For citations WITHOUT links, create links based on rawText number
        const newLinkData: { citationId: string; referenceListEntryId: string }[] = [];
        for (const citation of document.citations) {
          const linkedRefIds = citationLinks.get(citation.id);
          if ((!linkedRefIds || linkedRefIds.length === 0) && citation.citationType === 'NUMERIC') {
            // Use extractCitationNumbers to handle ranges like "[3-5]" → [3,4,5]
            const nums = extractCitationNumbers(citation.rawText);
            for (const num of nums) {
              const refId = refNumToId.get(num);
              if (refId) {
                newLinkData.push({ citationId: citation.id, referenceListEntryId: refId });
              }
            }
          }
        }

        if (newLinkData.length > 0) {
          await prisma.referenceListEntryCitation.createMany({
            data: newLinkData,
            skipDuplicates: true
          });
          linksCreated = newLinkData.length;
        }
      }

      logger.info(`[CitationReference] Refresh complete for ${documentId}: ${rawTextUpdated} rawText updated, ${linksRepaired} links repaired, ${linksCreated} new links`);

      res.json({
        success: true,
        data: {
          message: `Refreshed: ${rawTextUpdated} rawText updated, ${linksRepaired} links repaired, ${linksCreated} new links`,
          rawTextUpdated,
          linksRepaired,
          linksCreated
        }
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/v1/citation-management/document/:documentId/resequence
   * Resequence references by first appearance in text
   *
   * NOTE: The :documentId param can be either a document ID or a job ID.
   */
  async resequenceByAppearance(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const { tenantId } = req.user!;

      logger.info(`[CitationReference] Resequencing references by appearance for ${documentId}`);

      // Resolve document (handles both document ID and job ID)
      const baseDoc = await resolveDocumentSimple(documentId, tenantId);

      if (!baseDoc) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' }
        });
        return;
      }

      const document = await prisma.editorialDocument.findFirst({
        where: { id: baseDoc.id, tenantId },
        include: {
          citations: {
            orderBy: [{ paragraphIndex: 'asc' }, { startOffset: 'asc' }]
          },
          referenceListEntries: {
            orderBy: { sortKey: 'asc' }
          },
          documentContent: true
        }
      });

      if (!document) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' }
        });
        return;
      }

      // Separately fetch citation-reference links for this document
      // Get all reference IDs for this document first
      const refIds = document.referenceListEntries.map(r => r.id);
      const citationLinks = refIds.length > 0 ? await prisma.referenceListEntryCitation.findMany({
        where: {
          referenceListEntryId: { in: refIds }
        }
      }) : [];

      // USE ID-BASED LINKS between citations and references
      // 1. Build a map of reference ID -> reference number
      const refIdToNumber = new Map<string, number>();
      const refIdToEntry = new Map<string, typeof document.referenceListEntries[0]>();
      for (const ref of document.referenceListEntries) {
        const num = parseInt(ref.sortKey) || 0;
        refIdToNumber.set(ref.id, num);
        refIdToEntry.set(ref.id, ref);
        logger.debug(`[CitationReference] Reference: sortKey=${ref.sortKey} (num=${num}), id=${ref.id.substring(0, 8)}`);
      }

      // 2. Build a map of citation ID -> linked reference IDs
      const citationToRefs = new Map<string, string[]>();
      for (const link of citationLinks) {
        const refs = citationToRefs.get(link.citationId) || [];
        refs.push(link.referenceListEntryId);
        citationToRefs.set(link.citationId, refs);
      }

      logger.info(`[CitationReference] Found ${citationLinks.length} citation-reference links`);

      // 3. Get appearance order from citation positions using ID-based links
      const referenceAppearances: { refId: string; position: number; citationId: string; refNum: number }[] = [];

      for (const citation of document.citations) {
        // Get linked references via the junction table
        const linkedRefIds = citationToRefs.get(citation.id) || [];

        logger.debug(`[CitationReference] Citation: id=${citation.id.substring(0, 8)}, pos=${citation.startOffset}, linkedRefs=${linkedRefIds.length}`);

        for (const refId of linkedRefIds) {
          const refNum = refIdToNumber.get(refId) || 0;
          referenceAppearances.push({
            refId,
            position: citation.startOffset,
            citationId: citation.id,
            refNum
          });
          logger.info(`[CitationReference]   -> Linked to ref ${refId.substring(0, 8)} (num=${refNum})`);
        }

        // Fallback: If no links exist, try to extract number from rawText (for numeric citations)
        if (linkedRefIds.length === 0 && citation.citationType === 'NUMERIC') {
          const nums = citation.rawText.match(/\d+/g);
          logger.debug(`[CitationReference]   -> FALLBACK: extracted ${nums?.length || 0} numbers`);
          if (nums) {
            for (const numStr of nums) {
              const num = parseInt(numStr, 10);
              // Find reference with this number
              for (const [refId, refNum] of refIdToNumber) {
                if (refNum === num) {
                  referenceAppearances.push({
                    refId,
                    position: citation.startOffset,
                    citationId: citation.id,
                    refNum
                  });
                  logger.debug(`[CitationReference]   -> FALLBACK matched num=${num} to ref ${refId.substring(0, 8)}`);
                  break;
                }
              }
            }
          }
        }
      }

      // Sort by position to get order of first appearance
      referenceAppearances.sort((a, b) => a.position - b.position);

      logger.info(`[CitationReference] Found ${referenceAppearances.length} reference appearances from ${document.citations.length} citations`);

      // Log the appearance order for debugging
      logger.info(`[CitationReference] Appearance order (sorted by position):`);
      for (const ra of referenceAppearances) {
        logger.debug(`[CitationReference]   pos=${ra.position}: refNum=${ra.refNum}`);
      }

      // Build appearance order mapping using reference IDs
      const refIdFirstAppearance = new Map<string, { order: number; position: number }>();
      let appearanceOrder = 0;

      for (const ra of referenceAppearances) {
        if (!refIdFirstAppearance.has(ra.refId)) {
          appearanceOrder++;
          refIdFirstAppearance.set(ra.refId, { order: appearanceOrder, position: ra.position });
        }
      }

      // Add uncited references at the end (by their current order)
      for (const ref of document.referenceListEntries) {
        if (!refIdFirstAppearance.has(ref.id)) {
          appearanceOrder++;
          refIdFirstAppearance.set(ref.id, { order: appearanceOrder, position: Infinity });
        }
      }

      // Create old-to-new mapping (old number -> new number)
      const oldToNewNumber = new Map<number, number>();
      // Also create refId-to-new mapping for ID-based updates
      const refIdToNewNumber = new Map<string, number>();

      for (const [refId, info] of refIdFirstAppearance) {
        const oldNum = refIdToNumber.get(refId) || 0;
        oldToNewNumber.set(oldNum, info.order);
        refIdToNewNumber.set(refId, info.order);
      }

      logger.info(`[CitationReference] Mapping: ${JSON.stringify(Object.fromEntries(oldToNewNumber))}`);

      // Collect reference renumbering changes
      const referenceUpdates: { id: string; oldNum: number; newNum: number; rawText: string }[] = [];
      for (const ref of document.referenceListEntries) {
        const oldNum = parseInt(ref.sortKey) || 0;
        const newNum = oldToNewNumber.get(oldNum) || oldNum;
        if (oldNum !== newNum) {
          // Get reference text for the CitationChange record
          const refText = ref.formattedApa || ref.title || `Reference ${oldNum}`;
          referenceUpdates.push({ id: ref.id, oldNum, newNum, rawText: refText });
        }
      }

      // Calculate citation updates before the transaction
      const citationUpdates: { id: string; oldRawText: string; newRawText: string }[] = [];
      for (const citation of document.citations) {
        if (citation.citationType !== 'NUMERIC') continue;
        const newRawText = this.updateCitationNumbers(citation.rawText, oldToNewNumber);
        if (newRawText !== citation.rawText) {
          citationUpdates.push({ id: citation.id, oldRawText: citation.rawText, newRawText });
        }
      }

      // Create all CitationChange records data
      const allChanges: Prisma.CitationChangeCreateManyInput[] = [];

      // Add reference renumbering changes (for reference section track changes)
      // Note: citationId is null for reference-only changes since CitationChange doesn't have referenceId
      for (const refUpdate of referenceUpdates) {
        allChanges.push({
          documentId,
          citationId: null, // Reference changes don't link to a specific citation
          changeType: 'RENUMBER',
          beforeText: `[${refUpdate.oldNum}] ${refUpdate.rawText}`,
          afterText: `[${refUpdate.newNum}] ${refUpdate.rawText}`,
          appliedBy: 'system',
          isReverted: false
        });
      }

      // Add citation renumbering changes (for in-text citation track changes)
      for (const citUpdate of citationUpdates) {
        allChanges.push({
          documentId,
          citationId: citUpdate.id,
          changeType: 'RENUMBER',
          beforeText: citUpdate.oldRawText,
          afterText: citUpdate.newRawText,
          appliedBy: 'system',
          isReverted: false
        });
      }

      // Execute ALL updates in a single transaction to prevent partial state
      const operations: PrismaPromise<unknown>[] = [];

      // 1. Update reference sortKeys
      for (const ref of document.referenceListEntries) {
        const oldNum = parseInt(ref.sortKey) || 0;
        const newNum = oldToNewNumber.get(oldNum) || oldNum;
        operations.push(
          prisma.referenceListEntry.update({
            where: { id: ref.id },
            data: { sortKey: String(newNum).padStart(4, '0') }
          })
        );
      }

      // 2. Update citation rawText
      for (const update of citationUpdates) {
        operations.push(
          prisma.citation.update({
            where: { id: update.id },
            data: { rawText: update.newRawText }
          })
        );
      }

      // 3. Update fullHtml and fullText in DocumentContent with new citation numbers
      // Uses updateCitationNumbersInHtml which properly handles ranges like [3-5]
      if (document.documentContent && oldToNewNumber.size > 0) {
        const updateData: { fullHtml?: string; fullText?: string } = {};

        if (document.documentContent.fullHtml) {
          updateData.fullHtml = this.updateCitationNumbersInHtml(document.documentContent.fullHtml, oldToNewNumber);
        }

        if (document.documentContent.fullText) {
          updateData.fullText = this.updateCitationNumbersInHtml(document.documentContent.fullText, oldToNewNumber);
        }

        if (Object.keys(updateData).length > 0) {
          operations.push(
            prisma.editorialDocumentContent.update({
              where: { documentId },
              data: updateData
            })
          );

          logger.info(`[CitationReference] Updated documentContent with citation number changes`);
        }
      }

      // 4. Create CitationChange records for track changes
      if (allChanges.length > 0) {
        operations.push(
          prisma.citationChange.createMany({ data: allChanges })
        );
      }

      // Execute as single atomic transaction
      if (operations.length > 0) {
        await prisma.$transaction(operations);
      }

      // IMPORTANT: Rebuild citation-reference links after resequencing
      // Note: This runs outside the main transaction. If it fails, the main changes
      // are already committed but links may be stale. Log warning for reconciliation.
      let linksCreated = 0;
      let linkRebuildWarning: string | undefined;
      try {
        linksCreated = await this.rebuildCitationLinks(document.id, tenantId);
      } catch (linkError) {
        const errorMessage = linkError instanceof Error ? linkError.message : 'Unknown error';
        linkRebuildWarning = `Citation-reference links may be stale. Error: ${errorMessage}. Refresh to reconcile.`;
        logger.warn(`[CitationReference] rebuildCitationLinks failed after resequence - ${linkRebuildWarning}`, linkError instanceof Error ? linkError : undefined);
      }

      logger.info(`[CitationReference] Resequenced: ${referenceUpdates.length} references, ${citationUpdates.length} citations, ${linksCreated} links for document ${documentId}`);

      res.json({
        success: true,
        data: {
          message: 'References resequenced by appearance order',
          mapping: Object.fromEntries(oldToNewNumber),
          citationsUpdated: citationUpdates.length,
          linksRebuilt: linksCreated,
          ...(linkRebuildWarning && { warning: linkRebuildWarning })
        }
      });
    } catch (error) {
      next(error);
    }
  }

  // ============================================
  // Helper Methods
  // ============================================

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Rebuild styled citation text using the number from newRawText.
   * Detects the format of the existing afterText (superscript, bracket, parenthesis)
   * and produces the same format with the new number.
   * Author-year formats are left unchanged since reorder doesn't affect them.
   */
  private rebuildStyledText(afterText: string, newRawText: string): string {
    const SUPERSCRIPT_DIGITS = ['⁰', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹'];
    const SUPER_TO_DIGIT: Record<string, string> = {
      '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4',
      '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9'
    };

    // Extract all numbers from newRawText, expanding ranges: "(3)" → [3], "(1, 2)" → [1, 2], "[3-5]" → [3, 4, 5]
    const allNums = extractCitationNumbers(newRawText);
    if (allNums.length === 0) return afterText; // Can't extract numbers, leave unchanged

    // Helper: convert a single number to superscript
    const toSuperscript = (n: number): string =>
      String(n).split('').map(d => SUPERSCRIPT_DIGITS[parseInt(d, 10)]).join('');

    // Detect format of afterText
    // Superscript: all chars are superscript digits or common separators (comma, space)
    const isSuperscript = afterText.length > 0 &&
      [...afterText].every(ch => ch in SUPER_TO_DIGIT || ch === ',' || ch === ' ');
    if (isSuperscript && [...afterText].some(ch => ch in SUPER_TO_DIGIT)) {
      // Detect separator from original afterText
      const hasSep = afterText.includes(',');
      return allNums.map(toSuperscript).join(hasSep ? ',' : '');
    }

    // Bracket format: [N] or [N, M] or [N-M] (digits with commas, hyphens, en-dashes, spaces)
    if (/^\[[\d\s,\-–—]+\]$/.test(afterText)) {
      const inner = afterText.slice(1, -1);
      const isRange = inner.match(/[-–—]/) && !inner.includes(',');
      return `[${isRange ? this.formatNumberList(allNums) : allNums.join(', ')}]`;
    }

    // Parenthesis format: (N) or (N, M) or (N-M)
    if (/^\([\d\s,\-–—]+\)$/.test(afterText)) {
      const inner = afterText.slice(1, -1);
      const isRange = inner.match(/[-–—]/) && !inner.includes(',');
      return `(${isRange ? this.formatNumberList(allNums) : allNums.join(', ')})`;
    }

    // Author-year or unrecognized format — leave unchanged
    return afterText;
  }

  private updateCitationNumbers(rawText: string, oldToNewMap: Map<number, number>): string {
    let updated = rawText.replace(/\[(\d+(?:\s*[-–—,]\s*\d+)*)\]/g, (_match, nums) => {
      const newNums = this.remapNumbers(nums, oldToNewMap);
      return `[${newNums}]`;
    });

    updated = updated.replace(/\((\d+(?:\s*[-–—,]\s*\d+)*)\)/g, (_match, nums) => {
      const newNums = this.remapNumbers(nums, oldToNewMap);
      return `(${newNums})`;
    });

    return updated;
  }

  /**
   * Parse reference data from DELETE change beforeText for legacy undo support.
   * Handles APA format: "[N] Authors (Year). Title" and plain: "Authors (Year). Title"
   */
  private parseReferenceFromBeforeText(beforeText: string, _position: number): Record<string, unknown> {
    // Strip [N] prefix if present
    let text = beforeText.replace(/^\[\d+\]\s*/, '').trim();

    // Try to extract year: "(2021)" pattern
    let year: string | null = null;
    const yearMatch = text.match(/\((\d{4})\)/);
    if (yearMatch) {
      year = yearMatch[1];
    }

    // Try to split: "Authors (Year). Title..."
    let authorsStr = '';
    let title = text;

    if (yearMatch) {
      const yearIdx = text.indexOf(yearMatch[0]);
      authorsStr = text.substring(0, yearIdx).trim().replace(/,\s*$/, '');
      // Title is everything after "(Year). "
      const afterYear = text.substring(yearIdx + yearMatch[0].length).replace(/^\.\s*/, '').trim();
      if (afterYear) {
        title = afterYear;
      }
    }

    // Parse authors into array
    const authors: string[] = [];
    if (authorsStr) {
      // Split by ", " but keep "LastName, F." together
      // Simple approach: split by "., " which separates APA authors
      const parts = authorsStr.split(/\.,\s*/);
      for (const part of parts) {
        const cleaned = part.trim().replace(/\.$/, '').trim();
        if (cleaned) {
          authors.push(cleaned.includes('.') ? cleaned : cleaned + '.');
        }
      }
      // If no splits worked, use the whole string as one author
      if (authors.length === 0 && authorsStr) {
        authors.push(authorsStr);
      }
    }

    const formattedText = beforeText.replace(/^\[\d+\]\s*/, '').trim() || null;
    return {
      authors: authors.length > 0 ? authors : [],
      year,
      title: title || beforeText,
      sourceType: 'journal_article',
      formattedApa: formattedText,
      formattedMla: formattedText,
      formattedChicago: formattedText,
      formattedVancouver: formattedText,
      formattedIeee: formattedText,
    };
  }

  private updateCitationNumbersWithDeletion(rawText: string, oldToNewMap: Map<number, number | null>): string {
    // When all numbers in a citation are deleted:
    // - Single citation like [1] or (1) → remove entirely (empty string)
    // - Multiple citation like [1,2] with only some deleted → keep remaining numbers
    let updated = rawText.replace(/\[(\d+(?:\s*[-–—,]\s*\d+)*)\]/g, (_match, nums) => {
      const newNums = this.remapNumbersWithDeletion(nums, oldToNewMap);
      if (newNums.length === 0) return ''; // Remove citation entirely
      return `[${this.formatNumberList(newNums)}]`;
    });

    updated = updated.replace(/\((\d+(?:\s*[-–—,]\s*\d+)*)\)/g, (_match, nums) => {
      const newNums = this.remapNumbersWithDeletion(nums, oldToNewMap);
      if (newNums.length === 0) return ''; // Remove citation entirely
      return `(${this.formatNumberList(newNums)})`;
    });

    return updated;
  }

  private remapNumbers(numStr: string, oldToNewMap: Map<number, number>): string {
    const result: number[] = [];
    const parts = numStr.split(',').map(p => p.trim());

    for (const part of parts) {
      if (/[-–—]/.test(part)) {
        const rangeParts = part.split(/[-–—]/).map(n => parseInt(n.trim()));
        for (let i = rangeParts[0]; i <= rangeParts[1]; i++) {
          const newNum = oldToNewMap.get(i);
          if (newNum !== undefined) {
            result.push(newNum);
          }
        }
      } else {
        const num = parseInt(part);
        const newNum = oldToNewMap.get(num);
        if (newNum !== undefined) {
          result.push(newNum);
        }
      }
    }

    return this.formatNumberList(result);
  }

  private remapNumbersWithDeletion(numStr: string, oldToNewMap: Map<number, number | null>): number[] {
    const result: number[] = [];
    const parts = numStr.split(',').map(p => p.trim());

    for (const part of parts) {
      if (/[-–—]/.test(part)) {
        const rangeParts = part.split(/[-–—]/).map(n => parseInt(n.trim()));
        for (let i = rangeParts[0]; i <= rangeParts[1]; i++) {
          const newNum = oldToNewMap.get(i);
          if (newNum !== null && newNum !== undefined) {
            result.push(newNum);
          }
        }
      } else {
        const num = parseInt(part);
        const newNum = oldToNewMap.get(num);
        if (newNum !== null && newNum !== undefined) {
          result.push(newNum);
        }
      }
    }

    return result;
  }

  private formatNumberList(nums: number[]): string {
    if (nums.length === 0) return '';
    if (nums.length === 1) return nums[0].toString();

    const sorted = [...new Set(nums)].sort((a, b) => a - b);
    const ranges: string[] = [];
    let rangeStart = sorted[0];
    let rangeEnd = sorted[0];

    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] === rangeEnd + 1) {
        rangeEnd = sorted[i];
      } else {
        ranges.push(rangeStart === rangeEnd ? `${rangeStart}` : `${rangeStart}-${rangeEnd}`);
        rangeStart = sorted[i];
        rangeEnd = sorted[i];
      }
    }
    ranges.push(rangeStart === rangeEnd ? `${rangeStart}` : `${rangeStart}-${rangeEnd}`);

    return ranges.join(',');
  }

  /**
   * Update citation numbers in full HTML/text content
   * Handles all citation formats: [3], [3-5], [1,2,3], (3), (3-5), etc.
   * Uses placeholder-based replacement to avoid double-replacement issues
   */
  private updateCitationNumbersInHtml(text: string, oldToNewMap: Map<number, number>, isDeletion = false): string {
    // Track original citations and their replacements
    const replacements: { original: string; replacement: string }[] = [];

    // Pattern matches: [1], [1-3], [1,2,3], [1, 3-5, 7], etc.
    const bracketPattern = /\[(\d+(?:\s*[-–—,]\s*\d+)*)\]/g;
    const parenPattern = /\((\d+(?:\s*[-–—,]\s*\d+)*)\)/g;

    // Helper to remap numbers within a citation
    const remapAndFormat = (numStr: string): string | null => {
      const result: number[] = [];
      const parts = numStr.split(',').map(p => p.trim());

      for (const part of parts) {
        if (/[-–—]/.test(part)) {
          const rangeParts = part.split(/[-–—]/).map(n => parseInt(n.trim()));
          if (rangeParts.length === 2 && !isNaN(rangeParts[0]) && !isNaN(rangeParts[1])) {
            for (let i = rangeParts[0]; i <= rangeParts[1]; i++) {
              const newNum = oldToNewMap.get(i);
              if (newNum !== undefined && newNum !== null) {
                result.push(newNum);
              }
            }
          }
        } else {
          const num = parseInt(part);
          if (!isNaN(num)) {
            const newNum = oldToNewMap.get(num);
            if (newNum !== undefined && newNum !== null) {
              result.push(newNum);
            }
          }
        }
      }

      if (result.length === 0 && isDeletion) return null; // Indicates orphaned
      if (result.length === 0) return numStr; // Keep original if no mapping found

      return this.formatNumberList(result);
    };

    // Helper: clean up whitespace around deleted citations
    // "text (1). More" → "text. More" (not "text . More")
    const cleanDeletion = (fullText: string, matchStart: number, matchEnd: number): { start: number; end: number } => {
      let start = matchStart;
      let end = matchEnd;
      // If there's a space before the deleted citation, consume it
      if (start > 0 && fullText[start - 1] === ' ') {
        start--;
      } else if (start === 0 && end < fullText.length && fullText[end] === ' ') {
        // Citation at text start: consume trailing space instead
        end++;
      }
      return { start, end };
    };

    // Process bracket citations [N]
    // When all numbers deleted: remove citation and adjacent space
    let result = '';
    let lastIndex = 0;
    let bracketMatch: RegExpExecArray | null;
    bracketPattern.lastIndex = 0;
    while ((bracketMatch = bracketPattern.exec(text)) !== null) {
      const remapped = remapAndFormat(bracketMatch[1]);
      if (remapped === null) {
        // Remove citation and clean up adjacent space
        const { start } = cleanDeletion(text, bracketMatch.index, bracketMatch.index + bracketMatch[0].length);
        result += text.slice(lastIndex, start);
        lastIndex = bracketMatch.index + bracketMatch[0].length;
        replacements.push({ original: bracketMatch[0], replacement: '' });
      } else {
        const newCitation = `[${remapped}]`;
        result += text.slice(lastIndex, bracketMatch.index) + newCitation;
        lastIndex = bracketMatch.index + bracketMatch[0].length;
        if (newCitation !== bracketMatch[0]) {
          replacements.push({ original: bracketMatch[0], replacement: newCitation });
        }
      }
    }
    result += text.slice(lastIndex);

    // Process parenthetical citations (N)
    // When all numbers deleted: remove citation and adjacent space
    const textAfterBrackets = result;
    result = '';
    lastIndex = 0;
    let parenMatch: RegExpExecArray | null;
    parenPattern.lastIndex = 0;
    while ((parenMatch = parenPattern.exec(textAfterBrackets)) !== null) {
      const remapped = remapAndFormat(parenMatch[1]);
      if (remapped === null) {
        // Remove citation and clean up adjacent space
        const { start } = cleanDeletion(textAfterBrackets, parenMatch.index, parenMatch.index + parenMatch[0].length);
        result += textAfterBrackets.slice(lastIndex, start);
        lastIndex = parenMatch.index + parenMatch[0].length;
        replacements.push({ original: parenMatch[0], replacement: '' });
      } else {
        const newCitation = `(${remapped})`;
        result += textAfterBrackets.slice(lastIndex, parenMatch.index) + newCitation;
        lastIndex = parenMatch.index + parenMatch[0].length;
        if (newCitation !== parenMatch[0]) {
          replacements.push({ original: parenMatch[0], replacement: newCitation });
        }
      }
    }
    result += textAfterBrackets.slice(lastIndex);

    if (replacements.length > 0) {
      logger.info(`[CitationReference] Updated ${replacements.length} citations in HTML content`);
    }

    return result;
  }

  /**
   * Expand citation numbers including ranges
   * E.g., "[3-5]" -> [3, 4, 5], "[1,2]" -> [1, 2], "[3–5]" (en-dash) -> [3, 4, 5]
   *
   * Only processes text that looks like numeric citations (starts with [ or contains only numbers).
   * Excludes year-like numbers (1900-2099) to avoid matching parenthetical citations like "(Bender et al., 2021)".
   */
  private expandCitationNumbers(rawText: string): number[] {
    // Only process if it looks like a numeric citation (starts with [ or is just numbers)
    // Skip text that contains author names (letters) mixed with years
    const trimmedText = rawText.trim();

    // If text starts with [ it's likely a numeric citation like [1], [1,2], [3-5]
    // If text starts with ( it might be parenthetical author-year like (Smith, 2020)
    if (trimmedText.startsWith('(') && /[a-zA-Z]/.test(trimmedText)) {
      // Contains letters + starts with ( = likely author-year citation, not numeric
      return [];
    }

    const numbers: number[] = [];
    // Remove brackets/parentheses
    const inner = rawText.replace(/[\[\]()]/g, '');
    const parts = inner.split(/\s*,\s*/);

    for (const part of parts) {
      const trimmed = part.trim();
      // Check for range like "3-5" or "3–5" (en-dash) or "3—5" (em-dash)
      const rangeMatch = trimmed.match(/^(\d+)\s*[-–—]\s*(\d+)$/);
      if (rangeMatch) {
        const start = parseInt(rangeMatch[1], 10);
        const end = parseInt(rangeMatch[2], 10);
        // Skip year-like numbers (typically reference lists don't have 1900+ references)
        if (start >= 1900 || end >= 1900) {
          continue;
        }
        // Expand range (with safety limit of 100)
        for (let i = start; i <= end && i < start + 100; i++) {
          numbers.push(i);
        }
      } else {
        const num = parseInt(trimmed, 10);
        // Skip NaN and year-like numbers (1900-2099)
        if (!isNaN(num) && num < 1900) {
          numbers.push(num);
        }
      }
    }
    return numbers;
  }
}

export const citationReferenceController = new CitationReferenceController();
