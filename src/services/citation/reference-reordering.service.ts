/**
 * Reference Reordering Service
 * Handles reordering references and updating all in-text citations
 */

import { logger } from '../../lib/logger';
import { ReferenceEntry, InTextCitation } from './ai-citation-detector.service';
import { AppError } from '../../utils/app-error';

export interface ReorderOperation {
  referenceId: string;
  oldPosition: number;
  newPosition: number;
}

export interface ReorderResult {
  updatedReferences: ReferenceEntry[];
  updatedCitations: InTextCitation[];
  changes: {
    referenceId: string;
    oldNumber: number;
    newNumber: number;
    affectedCitations: string[]; // Citation IDs
  }[];
}

class ReferenceReorderingService {
  /**
   * Reorder a single reference and update all in-text citations
   */
  async reorderReference(
    references: ReferenceEntry[],
    citations: InTextCitation[],
    referenceId: string,
    newPosition: number
  ): Promise<ReorderResult> {
    logger.info(`[Reference Reordering] Moving reference ${referenceId} to position ${newPosition}`);

    const refIndex = references.findIndex(r => r.id === referenceId);
    if (refIndex === -1) {
      throw AppError.notFound(`Reference ${referenceId} not found`, 'REFERENCE_NOT_FOUND');
    }

    // Create new reference array
    const reorderedRefs = [...references];
    const [movedRef] = reorderedRefs.splice(refIndex, 1);
    reorderedRefs.splice(newPosition - 1, 0, movedRef);

    // Renumber all references
    const numberMapping = new Map<number, number>();
    reorderedRefs.forEach((ref, idx) => {
      const newNum = idx + 1;
      numberMapping.set(ref.number!, newNum);
      ref.number = newNum;
    });

    // Update all in-text citations
    const updatedCitations = citations.map(citation => {
      if (citation.type !== 'numeric') return citation;

      const updatedNumbers = citation.numbers.map(num =>
        numberMapping.get(num) || num
      );

      return {
        ...citation,
        numbers: updatedNumbers,
        text: this.formatCitationText(updatedNumbers, citation.format)
      };
    });

    // Track changes
    const changes = reorderedRefs.map((ref, idx) => ({
      referenceId: ref.id,
      oldNumber: idx + 1,
      newNumber: ref.number!,
      affectedCitations: citations
        .filter(c => c.linkedRefId === ref.id)
        .map(c => c.id)
    })).filter(c => c.oldNumber !== c.newNumber);

    return {
      updatedReferences: reorderedRefs,
      updatedCitations,
      changes
    };
  }

  /**
   * Batch reorder references
   */
  async reorderMultiple(
    references: ReferenceEntry[],
    citations: InTextCitation[],
    operations: ReorderOperation[]
  ): Promise<ReorderResult> {
    logger.info(`[Reference Reordering] Batch reordering ${operations.length} references`);

    let currentRefs = [...references];
    let currentCitations = [...citations];
    const allChanges: ReorderResult['changes'] = [];

    for (const operation of operations) {
      const result = await this.reorderReference(
        currentRefs,
        currentCitations,
        operation.referenceId,
        operation.newPosition
      );

      currentRefs = result.updatedReferences;
      currentCitations = result.updatedCitations;
      allChanges.push(...result.changes);
    }

    return {
      updatedReferences: currentRefs,
      updatedCitations: currentCitations,
      changes: allChanges
    };
  }

  /**
   * Sort references alphabetically by first author
   */
  async sortAlphabetically(
    references: ReferenceEntry[],
    citations: InTextCitation[]
  ): Promise<ReorderResult> {
    logger.info('[Reference Reordering] Sorting references alphabetically');

    const sortedRefs = [...references].sort((a, b) => {
      const authorA = a.components.authors?.[0] || '';
      const authorB = b.components.authors?.[0] || '';
      return authorA.localeCompare(authorB);
    });

    // Create operations for reordering
    const operations: ReorderOperation[] = sortedRefs.map((ref, newIdx) => {
      const oldIdx = references.findIndex(r => r.id === ref.id);
      return {
        referenceId: ref.id,
        oldPosition: oldIdx + 1,
        newPosition: newIdx + 1
      };
    });

    return this.reorderMultiple(references, citations, operations);
  }

  /**
   * Sort references by year (newest first or oldest first)
   */
  async sortByYear(
    references: ReferenceEntry[],
    citations: InTextCitation[],
    order: 'asc' | 'desc' = 'desc'
  ): Promise<ReorderResult> {
    logger.info(`[Reference Reordering] Sorting references by year (${order})`);

    const sortedRefs = [...references].sort((a, b) => {
      const yearA = parseInt(a.components.year || '0');
      const yearB = parseInt(b.components.year || '0');
      return order === 'desc' ? yearB - yearA : yearA - yearB;
    });

    const operations: ReorderOperation[] = sortedRefs.map((ref, newIdx) => {
      const oldIdx = references.findIndex(r => r.id === ref.id);
      return {
        referenceId: ref.id,
        oldPosition: oldIdx + 1,
        newPosition: newIdx + 1
      };
    });

    return this.reorderMultiple(references, citations, operations);
  }

  /**
   * Sort references by first appearance in text
   */
  async sortByAppearance(
    references: ReferenceEntry[],
    citations: InTextCitation[]
  ): Promise<ReorderResult> {
    logger.info('[Reference Reordering] Sorting references by appearance order');

    // Find first citation for each reference
    const firstAppearance = new Map<string, number>();

    citations
      .sort((a, b) => {
        if (a.position.paragraph !== b.position.paragraph) {
          return a.position.paragraph - b.position.paragraph;
        }
        return a.position.startChar - b.position.startChar;
      })
      .forEach((citation, idx) => {
        if (citation.linkedRefId && !firstAppearance.has(citation.linkedRefId)) {
          firstAppearance.set(citation.linkedRefId, idx);
        }
      });

    // Sort references by first appearance
    const sortedRefs = [...references].sort((a, b) => {
      const appearA = firstAppearance.get(a.id) ?? Infinity;
      const appearB = firstAppearance.get(b.id) ?? Infinity;
      return appearA - appearB;
    });

    const operations: ReorderOperation[] = sortedRefs.map((ref, newIdx) => {
      const oldIdx = references.findIndex(r => r.id === ref.id);
      return {
        referenceId: ref.id,
        oldPosition: oldIdx + 1,
        newPosition: newIdx + 1
      };
    });

    return this.reorderMultiple(references, citations, operations);
  }

  /**
   * Format citation text based on numbers and format
   */
  private formatCitationText(numbers: number[], format: string): string {
    if (numbers.length === 0) return '';

    if (format === 'superscript') {
      return numbers.map(n => this.toSuperscript(n)).join(',');
    }

    const numberText = this.formatNumberRange(numbers);

    if (format === 'bracket') {
      return `[${numberText}]`;
    } else if (format === 'parenthesis') {
      return `(${numberText})`;
    }

    return numberText;
  }

  /**
   * Format number range (e.g., [1,2,3,4,5] -> "1-5", [1,3,5] -> "1,3,5")
   */
  private formatNumberRange(numbers: number[]): string {
    if (numbers.length === 0) return '';
    if (numbers.length === 1) return numbers[0].toString();

    const sorted = [...numbers].sort((a, b) => a - b);
    const ranges: string[] = [];
    let start = sorted[0];
    let end = sorted[0];

    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] === end + 1) {
        end = sorted[i];
      } else {
        ranges.push(start === end ? `${start}` : `${start}-${end}`);
        start = sorted[i];
        end = sorted[i];
      }
    }

    ranges.push(start === end ? `${start}` : `${start}-${end}`);
    return ranges.join(',');
  }

  /**
   * Convert number to superscript
   */
  private toSuperscript(num: number): string {
    const superscriptMap: Record<string, string> = {
      '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
      '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹'
    };
    return num.toString().split('').map(d => superscriptMap[d] || d).join('');
  }
}

export const referenceReorderingService = new ReferenceReorderingService();
