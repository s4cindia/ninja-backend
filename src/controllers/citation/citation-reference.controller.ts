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

import { Request, Response, NextFunction } from 'express';
import { Prisma, PrismaPromise } from '@prisma/client';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { referenceReorderingService } from '../../services/citation/reference-reordering.service';
import type { EditReferenceBody } from '../../schemas/citation.schemas';

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

export class CitationReferenceController {
  /**
   * POST /api/v1/citation-management/document/:documentId/reorder
   * Reorder references and auto-update in-text citations
   */
  async reorderReferences(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const { referenceId, newPosition, sortBy } = req.body;
      const { tenantId } = req.user!;

      logger.info(`[CitationReference] Reordering references for ${documentId}`);

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
        } else {
          newPosition++;
          oldToNewNumber.set(oldPosition, newPosition);
        }
      }

      // Use already loaded data instead of re-fetching (N+1 prevention)
      const remainingReferences = allReferences.filter(ref => ref.id !== referenceId);
      const citations = referenceToDelete.document.citations;

      // Prepare citation updates before database operations
      // Track old->new text for creating CitationChange records
      const citationUpdates: { id: string; oldRawText: string; newRawText: string }[] = [];
      for (const citation of citations) {
        if (citation.citationType !== 'NUMERIC') continue;
        const newRawText = this.updateCitationNumbersWithDeletion(citation.rawText, oldToNewNumber);
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
      await prisma.$transaction(async (tx) => {
        // Delete the reference
        await tx.referenceListEntry.delete({ where: { id: referenceId } });

        // Batch renumber remaining references using raw SQL for efficiency
        // This is O(1) instead of O(N) individual updates
        if (remainingReferences.length > 0) {
          const caseStatements = remainingReferences
            .map((ref, index) => `WHEN id = '${ref.id}' THEN '${String(index + 1).padStart(4, '0')}'`)
            .join(' ');
          const refIds = remainingReferences.map(ref => `'${ref.id}'`).join(',');

          await tx.$executeRawUnsafe(`
            UPDATE "ReferenceListEntry"
            SET "sortKey" = CASE ${caseStatements} END
            WHERE id IN (${refIds})
          `);
        }

        // Batch update citations grouped by new text value
        // Uses updateMany for groups with same target value (more efficient than individual updates)
        for (const [newRawText, ids] of citationsByNewText) {
          if (ids.length === 1) {
            await tx.citation.update({
              where: { id: ids[0] },
              data: { rawText: newRawText }
            });
          } else {
            // Batch update multiple citations with same new text
            await tx.citation.updateMany({
              where: { id: { in: ids } },
              data: { rawText: newRawText }
            });
          }
        }

        // Create CitationChange record for the deleted reference
        await tx.citationChange.create({
          data: {
            documentId,
            citationId: null,
            changeType: 'DELETE',
            beforeText: `[${deletedPosition}] ${deletedRefText}`,
            afterText: '',
            appliedBy: 'user',
            isReverted: false
          }
        });

        // Create DELETE CitationChange records for affected in-text citations
        // This handles author-year style citations like "(Bender et al., 2021)"

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

        // Store citation ID and position info for ID-based lookup during export
        for (const citation of affectedCitations) {
          if (citation.rawText) {
            await tx.citationChange.create({
              data: {
                documentId,
                citationId: citation.id,
                changeType: 'DELETE',
                beforeText: citation.rawText,
                // Store citation ID and position info for ID-based lookup
                afterText: JSON.stringify({
                  citationId: citation.id,
                  startOffset: citation.startOffset,
                  endOffset: citation.endOffset
                }),
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
            documentId,
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
              where: { documentId },
              data: updateData
            });

            logger.info(`[CitationReference] Updated documentContent after delete with renumbered citations`);
          }
        }
      });

      res.json({
        success: true,
        data: {
          message: 'Reference deleted successfully',
          deletedReferenceId: referenceId,
          deletedPosition,
          affectedCitations: affectedCitationIds.length,
          remainingReferences: remainingReferences.length
        }
      });
    } catch (error) {
      next(error);
    }
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
  async editReference(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId, referenceId } = req.params;
      // Body is pre-validated by editReferenceSchema middleware
      const updates: EditReferenceBody = req.body;
      const { tenantId } = req.user!;

      logger.info(`[CitationReference] Editing reference ${referenceId} in document ${documentId}`);

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

      if (reference.documentId !== documentId) {
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

      res.json({
        success: true,
        data: {
          message: 'Reference updated successfully',
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
            url: updatedReference.url,
            publisher: updatedReference.publisher
          }
        }
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/v1/citation-management/document/:documentId/reset-changes
   * Reset all citation changes for a document (clears partial resequencing)
   */
  async resetChanges(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const { tenantId } = req.user!;

      logger.info(`[CitationReference] Resetting citation changes for ${documentId}`);

      const document = await prisma.editorialDocument.findFirst({
        where: { id: documentId, tenantId }
      });

      if (!document) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' }
        });
        return;
      }

      // Delete all CitationChange records for this document
      const result = await prisma.citationChange.deleteMany({
        where: { documentId }
      });

      logger.info(`[CitationReference] Deleted ${result.count} CitationChange records for document ${documentId}`);

      res.json({
        success: true,
        data: {
          message: `Reset complete. Deleted ${result.count} change records.`,
          deletedCount: result.count
        }
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/v1/citation-management/document/:documentId/create-links
   * Create citation-reference links for existing documents that don't have them
   */
  async createCitationLinks(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const { tenantId } = req.user!;

      logger.info(`[CitationReference] Creating citation-reference links for ${documentId}`);

      const document = await prisma.editorialDocument.findFirst({
        where: { id: documentId, tenantId },
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

      // Build reference number to ID map
      const refNumToId = new Map<number, string>();
      for (const ref of document.referenceListEntries) {
        const num = parseInt(ref.sortKey) || 0;
        refNumToId.set(num, ref.id);
      }

      // Create links for numeric citations
      const linkData: { citationId: string; referenceListEntryId: string }[] = [];
      for (const citation of document.citations) {
        if (citation.citationType === 'NUMERIC') {
          const nums = citation.rawText.match(/\d+/g);
          if (nums) {
            for (const numStr of nums) {
              const num = parseInt(numStr, 10);
              const refId = refNumToId.get(num);
              if (refId) {
                linkData.push({
                  citationId: citation.id,
                  referenceListEntryId: refId
                });
              }
            }
          }
        }
      }

      // Delete existing links first (to reset)
      const refIds = document.referenceListEntries.map(r => r.id);
      if (refIds.length > 0) {
        await prisma.referenceListEntryCitation.deleteMany({
          where: { referenceListEntryId: { in: refIds } }
        });
      }

      // Create new links
      let linksCreated = 0;
      if (linkData.length > 0) {
        await prisma.referenceListEntryCitation.createMany({
          data: linkData,
          skipDuplicates: true
        });
        linksCreated = linkData.length;
      }

      logger.info(`[CitationReference] Created ${linksCreated} citation-reference links for document ${documentId}`);

      res.json({
        success: true,
        data: {
          message: `Created ${linksCreated} citation-reference links`,
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
   */
  async resequenceByAppearance(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const { tenantId } = req.user!;

      logger.info(`[CitationReference] Resequencing references by appearance for ${documentId}`);

      const document = await prisma.editorialDocument.findFirst({
        where: { id: documentId, tenantId },
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
        // Log each reference for debugging
        const authorName = ref.formattedApa?.split('.')[0] || ref.title?.substring(0, 20) || 'Unknown';
        logger.info(`[CitationReference] Reference: sortKey=${ref.sortKey} (num=${num}), id=${ref.id.substring(0, 8)}, author=${authorName}`);
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

        logger.info(`[CitationReference] Citation: rawText="${citation.rawText}", pos=${citation.startOffset}, linkedRefs=${linkedRefIds.length}`);

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
          logger.info(`[CitationReference]   -> FALLBACK: extracted nums=[${nums?.join(', ')}] from rawText`);
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
                  const entry = refIdToEntry.get(refId);
                  const authorName = entry?.formattedApa?.split('.')[0] || 'Unknown';
                  logger.info(`[CitationReference]   -> FALLBACK matched num=${num} to ref ${refId.substring(0, 8)} (${authorName})`);
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
        const entry = refIdToEntry.get(ra.refId);
        const authorName = entry?.formattedApa?.split('.')[0] || 'Unknown';
        logger.info(`[CitationReference]   pos=${ra.position}: refNum=${ra.refNum} (${authorName})`);
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

      logger.info(`[CitationReference] Resequenced: ${referenceUpdates.length} references, ${citationUpdates.length} citations for document ${documentId}`);

      res.json({
        success: true,
        data: {
          message: 'References resequenced by appearance order',
          mapping: Object.fromEntries(oldToNewNumber),
          citationsUpdated: citationUpdates.length
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

  private updateCitationNumbersWithDeletion(rawText: string, oldToNewMap: Map<number, number | null>): string {
    let updated = rawText.replace(/\[(\d+(?:\s*[-–—,]\s*\d+)*)\]/g, (_match, nums) => {
      const newNums = this.remapNumbersWithDeletion(nums, oldToNewMap);
      if (newNums.length === 0) return '[orphaned]';
      return `[${this.formatNumberList(newNums)}]`;
    });

    updated = updated.replace(/\((\d+(?:\s*[-–—,]\s*\d+)*)\)/g, (_match, nums) => {
      const newNums = this.remapNumbersWithDeletion(nums, oldToNewMap);
      if (newNums.length === 0) return '(orphaned)';
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

    // Process bracket citations [N]
    let result = text.replace(bracketPattern, (match, nums) => {
      const remapped = remapAndFormat(nums);
      if (remapped === null) return '[orphaned]';
      const newCitation = `[${remapped}]`;
      if (newCitation !== match) {
        replacements.push({ original: match, replacement: newCitation });
      }
      return newCitation;
    });

    // Process parenthetical citations (N)
    result = result.replace(parenPattern, (match, nums) => {
      const remapped = remapAndFormat(nums);
      if (remapped === null) return '(orphaned)';
      const newCitation = `(${remapped})`;
      if (newCitation !== match) {
        replacements.push({ original: match, replacement: newCitation });
      }
      return newCitation;
    });

    if (replacements.length > 0) {
      logger.info(`[CitationReference] Updated ${replacements.length} citations in HTML content`);
    }

    return result;
  }
}

export const citationReferenceController = new CitationReferenceController();
