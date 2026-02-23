/**
 * CitationReferenceController Unit Tests
 *
 * Tests for citation/reference helper methods:
 * - expandCitationNumbers (range expansion)
 * - remapCitationNumbers (citation text remapping)
 * - remapNumberList (year filtering)
 * - updateCitationNumbersWithDeletion (orphan handling)
 */

import { describe, it, expect } from 'vitest';

// Test the helper logic directly by recreating the functions
// (since they are private methods on the controller class)

/**
 * Expand citation numbers from text like "[1-3]" to [1, 2, 3]
 * Handles: [1], [1,2], [1-3], [1,3-5]
 */
function expandCitationNumbers(text: string): number[] {
  const nums: number[] = [];

  // Match bracketed citations
  const bracketMatch = text.match(/\[([^\]]+)\]/);
  if (bracketMatch) {
    const inner = bracketMatch[1];
    // Split by comma
    const parts = inner.split(/\s*,\s*/);
    for (const part of parts) {
      const trimmed = part.trim();
      // Check for range (e.g., "1-3", "1–3", "1—3")
      const rangeMatch = trimmed.match(/^(\d+)\s*[-–—]\s*(\d+)$/);
      if (rangeMatch) {
        const start = parseInt(rangeMatch[1], 10);
        const end = parseInt(rangeMatch[2], 10);
        for (let i = start; i <= end && i < start + 100; i++) {
          nums.push(i);
        }
      } else {
        const num = parseInt(trimmed, 10);
        if (!isNaN(num)) {
          nums.push(num);
        }
      }
    }
  }

  return nums;
}

/**
 * Remap citation numbers based on old->new mapping
 */
function remapCitationNumbers(text: string, oldToNew: Map<number, number | null>): string {
  return text.replace(/\[([^\]]+)\]/g, (_match, inner) => {
    const parts = inner.split(/\s*,\s*/);
    const newNums: number[] = [];

    for (const part of parts) {
      const trimmed = part.trim();
      const rangeMatch = trimmed.match(/^(\d+)\s*[-–—]\s*(\d+)$/);
      if (rangeMatch) {
        const start = parseInt(rangeMatch[1], 10);
        const end = parseInt(rangeMatch[2], 10);
        for (let i = start; i <= end && i < start + 100; i++) {
          const newNum = oldToNew.get(i);
          if (newNum !== null && newNum !== undefined) {
            newNums.push(newNum);
          }
        }
      } else {
        const num = parseInt(trimmed, 10);
        if (!isNaN(num)) {
          const newNum = oldToNew.get(num);
          if (newNum !== null && newNum !== undefined) {
            newNums.push(newNum);
          }
        }
      }
    }

    if (newNums.length === 0) return '[orphaned]';

    // Sort and collapse to ranges
    const sorted = [...new Set(newNums)].sort((a, b) => a - b);
    return `[${collapseToRanges(sorted)}]`;
  });
}

/**
 * Collapse sorted numbers to ranges
 */
function collapseToRanges(nums: number[]): string {
  if (nums.length === 0) return '';
  if (nums.length === 1) return String(nums[0]);

  const ranges: string[] = [];
  let start = nums[0];
  let end = nums[0];

  for (let i = 1; i < nums.length; i++) {
    if (nums[i] === end + 1) {
      end = nums[i];
    } else {
      ranges.push(start === end ? String(start) : `${start}-${end}`);
      start = nums[i];
      end = nums[i];
    }
  }
  ranges.push(start === end ? String(start) : `${start}-${end}`);

  return ranges.join(',');
}

/**
 * Remap number list with year filtering
 */
function remapNumberList(numStr: string, oldToNewMap: Map<number, number>): string {
  const result: number[] = [];
  const parts = numStr.split(/\s*,\s*/);

  const isLikelyYear = (n: number) => n >= 1900 && n <= 2100;

  for (const part of parts) {
    const trimmed = part.trim();
    const rangeMatch = trimmed.match(/^(\d+)\s*[-–—]\s*(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);

      // If range looks like years, skip remapping entirely
      if (isLikelyYear(start) && isLikelyYear(end)) {
        result.push(start);
        continue;
      }

      for (let i = start; i <= end && i < start + 100; i++) {
        const newNum = oldToNewMap.get(i);
        if (newNum !== undefined) {
          result.push(newNum);
        }
      }
    } else {
      const num = parseInt(trimmed, 10);
      if (!isNaN(num)) {
        // Skip year-like numbers
        if (isLikelyYear(num)) {
          result.push(num);
          continue;
        }

        const newNum = oldToNewMap.get(num);
        if (newNum !== undefined) {
          result.push(newNum);
        } else {
          result.push(num);
        }
      }
    }
  }

  return result.join(',');
}

describe('expandCitationNumbers', () => {
  it('should expand single number', () => {
    expect(expandCitationNumbers('[1]')).toEqual([1]);
    expect(expandCitationNumbers('[5]')).toEqual([5]);
  });

  it('should expand comma-separated numbers', () => {
    expect(expandCitationNumbers('[1,2]')).toEqual([1, 2]);
    expect(expandCitationNumbers('[1, 3, 5]')).toEqual([1, 3, 5]);
  });

  it('should expand ranges', () => {
    expect(expandCitationNumbers('[1-3]')).toEqual([1, 2, 3]);
    expect(expandCitationNumbers('[5-8]')).toEqual([5, 6, 7, 8]);
  });

  it('should handle en-dash and em-dash', () => {
    expect(expandCitationNumbers('[1–3]')).toEqual([1, 2, 3]);
    expect(expandCitationNumbers('[1—3]')).toEqual([1, 2, 3]);
  });

  it('should handle mixed format', () => {
    expect(expandCitationNumbers('[1,3-5]')).toEqual([1, 3, 4, 5]);
    expect(expandCitationNumbers('[1-2, 5, 8-10]')).toEqual([1, 2, 5, 8, 9, 10]);
  });

  it('should return empty array for no numbers', () => {
    expect(expandCitationNumbers('(Smith, 2020)')).toEqual([]);
    expect(expandCitationNumbers('text')).toEqual([]);
  });

  it('should limit range expansion to 100 numbers', () => {
    const result = expandCitationNumbers('[1-150]');
    expect(result.length).toBe(100);
    expect(result[99]).toBe(100);
  });
});

describe('remapCitationNumbers', () => {
  it('should remap single citation when ref 2 is deleted', () => {
    // When ref 2 is deleted: 1->1, 2->null (deleted), 3->2
    const map = new Map<number, number | null>([[1, 1], [2, null], [3, 2]]);

    expect(remapCitationNumbers('[1]', map)).toBe('[1]');
    expect(remapCitationNumbers('[2]', map)).toBe('[orphaned]');
    expect(remapCitationNumbers('[3]', map)).toBe('[2]');
  });

  it('should remap ranges correctly', () => {
    // When ref 2 is deleted: 1->1, 2->null, 3->2, 4->3
    const map = new Map<number, number | null>([
      [1, 1], [2, null], [3, 2], [4, 3]
    ]);

    expect(remapCitationNumbers('[1-4]', map)).toBe('[1-3]');
    expect(remapCitationNumbers('[2-3]', map)).toBe('[2]');
  });

  it('should handle multiple comma-separated numbers', () => {
    const map = new Map<number, number | null>([
      [1, 1], [2, null], [3, 2], [5, 4]
    ]);

    // [1,3,5] remaps to [1,2,4] which stays as non-consecutive
    expect(remapCitationNumbers('[1,3,5]', map)).toBe('[1-2,4]');
    expect(remapCitationNumbers('[1,2]', map)).toBe('[1]');
  });

  it('should mark as orphaned when all refs deleted', () => {
    const map = new Map<number, number | null>([[2, null], [3, null]]);

    expect(remapCitationNumbers('[2,3]', map)).toBe('[orphaned]');
  });

  it('should collapse consecutive numbers to ranges', () => {
    // After remapping: [1,2,3,5,6,7] -> [1,2,3,4,5,6] which are all consecutive
    const map = new Map<number, number | null>([
      [1, 1], [2, 2], [3, 3], [5, 4], [6, 5], [7, 6]
    ]);

    // [1,2,3,4,5,6] collapses to [1-6]
    expect(remapCitationNumbers('[1,2,3,5,6,7]', map)).toBe('[1-6]');
  });
});

describe('remapNumberList with year filtering', () => {
  it('should skip year-like numbers (1900-2100)', () => {
    const map = new Map<number, number>([[1, 2], [2, 3]]);

    // Year 2020 should not be remapped
    expect(remapNumberList('2020', map)).toBe('2020');
    expect(remapNumberList('2023', map)).toBe('2023');
    expect(remapNumberList('1999', map)).toBe('1999');
  });

  it('should remap non-year numbers', () => {
    const map = new Map<number, number>([[1, 2], [2, 3], [3, 4]]);

    expect(remapNumberList('1', map)).toBe('2');
    expect(remapNumberList('1,2,3', map)).toBe('2,3,4');
  });

  it('should handle mixed years and citation numbers', () => {
    const map = new Map<number, number>([[1, 2], [2, 3]]);

    // In "(2020, 2021)" the years should be preserved
    expect(remapNumberList('2020, 2021', map)).toBe('2020,2021');

    // But "[1, 2]" should be remapped
    expect(remapNumberList('1, 2', map)).toBe('2,3');
  });

  it('should skip year-like ranges', () => {
    const map = new Map<number, number>([[2020, 1], [2021, 2]]);

    // Range "2020-2023" looks like years, should preserve start only
    expect(remapNumberList('2020-2023', map)).toBe('2020');
  });

  it('should remap non-year ranges', () => {
    const map = new Map<number, number>([[1, 10], [2, 20], [3, 30]]);

    expect(remapNumberList('1-3', map)).toBe('10,20,30');
  });
});

describe('collapseToRanges', () => {
  it('should handle single number', () => {
    expect(collapseToRanges([1])).toBe('1');
  });

  it('should handle consecutive numbers', () => {
    expect(collapseToRanges([1, 2, 3])).toBe('1-3');
    expect(collapseToRanges([5, 6, 7, 8])).toBe('5-8');
  });

  it('should handle non-consecutive numbers', () => {
    expect(collapseToRanges([1, 3, 5])).toBe('1,3,5');
  });

  it('should handle mixed ranges', () => {
    expect(collapseToRanges([1, 2, 3, 7, 8, 9])).toBe('1-3,7-9');
    expect(collapseToRanges([1, 2, 5, 6, 7, 10])).toBe('1-2,5-7,10');
  });

  it('should handle empty array', () => {
    expect(collapseToRanges([])).toBe('');
  });
});

// ============================================
// dismissChanges Schema Validation Tests
// ============================================

import { z } from 'zod';

// Recreate the schema for testing validation logic
const dismissChangesSchema = z.object({
  changeIds: z.array(z.string().uuid('Invalid change ID format'))
    .min(1, 'At least one change ID is required')
    .max(100, 'Cannot dismiss more than 100 changes at once')
});

describe('dismissChanges schema validation', () => {
  it('should accept valid changeIds array with UUIDs', () => {
    const validInput = {
      changeIds: [
        '550e8400-e29b-41d4-a716-446655440000',
        '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
      ]
    };
    const result = dismissChangesSchema.safeParse(validInput);
    expect(result.success).toBe(true);
  });

  it('should reject empty changeIds array', () => {
    const invalidInput = { changeIds: [] };
    const result = dismissChangesSchema.safeParse(invalidInput);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('At least one change ID is required');
    }
  });

  it('should reject missing changeIds', () => {
    const invalidInput = {};
    const result = dismissChangesSchema.safeParse(invalidInput);
    expect(result.success).toBe(false);
  });

  it('should reject non-UUID strings', () => {
    const invalidInput = { changeIds: ['not-a-uuid', 'also-not-valid'] };
    const result = dismissChangesSchema.safeParse(invalidInput);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('Invalid change ID format');
    }
  });

  it('should reject array with more than 100 items', () => {
    const tooManyIds = Array.from({ length: 101 }, (_, i) =>
      `550e8400-e29b-41d4-a716-${String(i).padStart(12, '0')}`
    );
    const invalidInput = { changeIds: tooManyIds };
    const result = dismissChangesSchema.safeParse(invalidInput);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('Cannot dismiss more than 100 changes at once');
    }
  });

  it('should accept exactly 100 items', () => {
    const maxIds = Array.from({ length: 100 }, (_, i) =>
      `550e8400-e29b-41d4-a716-${String(i).padStart(12, '0')}`
    );
    const validInput = { changeIds: maxIds };
    const result = dismissChangesSchema.safeParse(validInput);
    expect(result.success).toBe(true);
  });

  it('should reject mixed valid and invalid UUIDs', () => {
    const invalidInput = {
      changeIds: [
        '550e8400-e29b-41d4-a716-446655440000',
        'invalid-uuid'
      ]
    };
    const result = dismissChangesSchema.safeParse(invalidInput);
    expect(result.success).toBe(false);
  });
});
