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
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { referenceReorderingService } from '../../services/citation/reference-reordering.service';

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
          referenceListEntries: { orderBy: { sortKey: 'asc' } }
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
            rawText: r.formattedApa || `${(r.authors as string[])?.join(', ') || 'Unknown'} (${r.year || 'n.d.'}). ${r.title || 'Untitled'}`,
            citationCount: r.citationIds.length
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
          document: {
            include: {
              referenceListEntries: { orderBy: { sortKey: 'asc' } },
              citations: true
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
      const affectedCitationIds = referenceToDelete.citationIds;

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

      // Delete the reference
      await prisma.referenceListEntry.delete({ where: { id: referenceId } });

      // Renumber remaining references
      const remainingReferences = await prisma.referenceListEntry.findMany({
        where: { documentId },
        orderBy: { sortKey: 'asc' }
      });

      await prisma.$transaction(
        remainingReferences.map((ref, index) =>
          prisma.referenceListEntry.update({
            where: { id: ref.id },
            data: { sortKey: String(index + 1).padStart(4, '0') }
          })
        )
      );

      // Update citation numbers
      const citations = await prisma.citation.findMany({ where: { documentId } });
      const citationUpdates: { id: string; newRawText: string }[] = [];

      for (const citation of citations) {
        if (citation.citationType !== 'NUMERIC') continue;
        const newRawText = this.updateCitationNumbersWithDeletion(citation.rawText, oldToNewNumber);
        if (newRawText !== citation.rawText) {
          citationUpdates.push({ id: citation.id, newRawText });
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
      }

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
   */
  async editReference(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId, referenceId } = req.params;
      const updates = req.body;
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

      // Update the reference
      const updatedReference = await prisma.referenceListEntry.update({
        where: { id: referenceId },
        data: {
          authors: updates.authors ?? reference.authors,
          year: updates.year ?? reference.year,
          title: updates.title ?? reference.title,
          journalName: updates.journalName ?? reference.journalName,
          volume: updates.volume ?? reference.volume,
          issue: updates.issue ?? reference.issue,
          pages: updates.pages ?? reference.pages,
          doi: updates.doi ?? reference.doi,
          url: updates.url ?? reference.url,
          publisher: updates.publisher ?? reference.publisher,
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

      const totalReferences = document.referenceListEntries.length;
      const fullText = document.fullText || '';

      // Find citations in text
      const citationPattern = /\((\d+)\)|\[(\d+)\]/g;
      const textCitationOrder: { num: number; position: number }[] = [];
      let match;
      while ((match = citationPattern.exec(fullText)) !== null) {
        const num = parseInt(match[1] || match[2]);
        if (num >= 1 && num <= totalReferences) {
          textCitationOrder.push({ num, position: match.index });
        }
      }

      // Build appearance order mapping
      const numberFirstAppearance = new Map<number, { order: number; position: number }>();
      let appearanceOrder = 0;

      for (const tc of textCitationOrder) {
        if (!numberFirstAppearance.has(tc.num)) {
          appearanceOrder++;
          numberFirstAppearance.set(tc.num, { order: appearanceOrder, position: tc.position });
        }
      }

      // Add uncited references at the end
      for (let i = 1; i <= totalReferences; i++) {
        if (!numberFirstAppearance.has(i)) {
          appearanceOrder++;
          numberFirstAppearance.set(i, { order: appearanceOrder, position: Infinity });
        }
      }

      // Create old-to-new mapping
      const oldToNewNumber = new Map<number, number>();
      for (const [oldNum, info] of numberFirstAppearance) {
        oldToNewNumber.set(oldNum, info.order);
      }

      // Update references
      await prisma.$transaction(
        document.referenceListEntries.map(ref => {
          const oldNum = parseInt(ref.sortKey) || 0;
          const newNum = oldToNewNumber.get(oldNum) || oldNum;
          return prisma.referenceListEntry.update({
            where: { id: ref.id },
            data: { sortKey: String(newNum).padStart(4, '0') }
          });
        })
      );

      // Update citations
      const citationUpdates: { id: string; newRawText: string }[] = [];
      for (const citation of document.citations) {
        if (citation.citationType !== 'NUMERIC') continue;
        const newRawText = this.updateCitationNumbers(citation.rawText, oldToNewNumber);
        if (newRawText !== citation.rawText) {
          citationUpdates.push({ id: citation.id, newRawText });
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
      }

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
}

export const citationReferenceController = new CitationReferenceController();
