/**
 * Pure-function tests for heading-style-classifier.ts's own helpers --
 * computeClusterSize / hasConfirmedHeadingAtSameSize (the design doc's two
 * free, no-AI-call signals) and the element-id encode/decode pair
 * fixHeadingPromoteFix's own caller depends on. The real pdfjs-walking
 * collectHeadingStyleData is covered end-to-end elsewhere (against a real
 * tagged PDF fixture) in pdf-heading-style-mismatch.validator.test.ts,
 * pdf-structure-writer-heading-promote.test.ts, and
 * ai-analysis-heading-style-mismatch-routing.test.ts -- a synthetic
 * candidate list is enough here since these two functions never touch a
 * document at all.
 */
import { describe, it, expect } from 'vitest';
import {
  computeClusterSize,
  hasConfirmedHeadingAtSameSize,
  findClusterMatchedLevel,
  buildIssueElement,
  parseIssueElement,
  findCandidateForIssue,
  CLUSTER_SIZE_DECLINE_THRESHOLD,
  type HeadingStyleCandidate,
} from '../../../../src/services/pdf/heading-style-classifier';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';

function candidate(overrides: Partial<HeadingStyleCandidate> = {}): HeadingStyleCandidate {
  return {
    pageNumber: 1,
    mcid: 0,
    fontSize: 22,
    charCount: 20,
    textSample: 'Sample',
    precedingText: '',
    followingText: '',
    ...overrides,
  };
}

describe('computeClusterSize', () => {
  it('counts every candidate (itself included) whose font size falls within tolerance of the target', () => {
    const all = [
      candidate({ fontSize: 22 }),
      candidate({ fontSize: 22.1 }), // within the 0.3pt tolerance band
      candidate({ fontSize: 21.8 }), // within tolerance on the other side
      candidate({ fontSize: 11 }),   // a different, unrelated body-text size
    ];
    expect(computeClusterSize(all, 22)).toBe(3);
  });

  it('CLUSTER_SIZE_DECLINE_THRESHOLD is exactly the confirmed decision (8)', () => {
    expect(CLUSTER_SIZE_DECLINE_THRESHOLD).toBe(8);
  });

  it('returns 0 for a font size nothing in the document shares', () => {
    const all = [candidate({ fontSize: 11 }), candidate({ fontSize: 14 })];
    expect(computeClusterSize(all, 22)).toBe(0);
  });
});

describe('hasConfirmedHeadingAtSameSize', () => {
  it('is true when a real heading exists within tolerance of the target size', () => {
    expect(hasConfirmedHeadingAtSameSize([22.05, 14], 22)).toBe(true);
  });

  it('is false when no real heading uses this size', () => {
    expect(hasConfirmedHeadingAtSameSize([14, 18], 22)).toBe(false);
  });

  it('is false for an empty heading list (a document with no confirmed headings at all)', () => {
    expect(hasConfirmedHeadingAtSameSize([], 22)).toBe(false);
  });
});

describe('findClusterMatchedLevel', () => {
  /**
   * Real bug, 2026-11-25 (see git log): the ratio cutoff alone is a sharp
   * step function -- a candidate's font size landing at ratio 1.79 vs 1.81
   * (noise-level differences between otherwise-identical runs) picks two
   * DIFFERENT levels for the same logical heading, which fixHeadingHierarchy's
   * own correct gap-closing cascade then amplifies through the rest of the
   * document. Preferring an existing, already-settled heading's own level
   * at the same font size is deterministic and usually more correct than a
   * fixed global ratio band.
   */
  it('returns the level of an existing heading at (within tolerance of) the same font size', () => {
    const existing = [{ fontSize: 14, level: 2 }, { fontSize: 22, level: 1 }];
    expect(findClusterMatchedLevel(existing, 14.1)).toBe(2);
  });

  it('returns null when no existing heading is close enough in size -- the caller falls back to the ratio cutoff', () => {
    const existing = [{ fontSize: 14, level: 2 }, { fontSize: 22, level: 1 }];
    expect(findClusterMatchedLevel(existing, 18)).toBeNull();
  });

  it('returns null for an empty existing-headings list (first heading in the document)', () => {
    expect(findClusterMatchedLevel([], 14)).toBeNull();
  });

  it('breaks a tie between two matching sizes by picking the closest font size first', () => {
    const existing = [{ fontSize: 14.0, level: 3 }, { fontSize: 14.25, level: 2 }];
    // Both are within the 0.3pt tolerance of 14.2 -- 14.25 is closer.
    expect(findClusterMatchedLevel(existing, 14.2)).toBe(2);
  });

  it('breaks an exact-distance tie by picking the smallest level, deterministically', () => {
    const existing = [{ fontSize: 14.1, level: 3 }, { fontSize: 13.9, level: 1 }];
    // Both are exactly 0.1pt away from 14.0 -- level is the only tie-break left.
    expect(findClusterMatchedLevel(existing, 14.0)).toBe(1);
  });
});

describe('buildIssueElement / parseIssueElement', () => {
  it('round-trips (pageNumber, mcid) through the element id', () => {
    const element = buildIssueElement(12, 7);
    expect(element).toBe('heading-style-mismatch_p12_mc7');
    expect(parseIssueElement(element)).toEqual({ pageNumber: 12, mcid: 7 });
  });

  it('returns null for an unrecognized element id', () => {
    expect(parseIssueElement('not-a-valid-id')).toBeNull();
    expect(parseIssueElement(undefined)).toBeNull();
  });

  it('returns null for a different validator\'s element id shape', () => {
    expect(parseIssueElement('float-interruption_r2089')).toBeNull();
  });
});

describe('findCandidateForIssue', () => {
  it('matches by (pageNumber, mcid), not array position', () => {
    const all = [candidate({ pageNumber: 1, mcid: 3 }), candidate({ pageNumber: 2, mcid: 3 }), candidate({ pageNumber: 1, mcid: 5 })];
    const issue = { element: buildIssueElement(2, 3) } as AuditIssue;

    const found = findCandidateForIssue(all, issue);
    expect(found).toBe(all[1]);
  });

  it('returns undefined when the issue has no element at all', () => {
    const all = [candidate()];
    const issue = {} as AuditIssue;

    expect(findCandidateForIssue(all, issue)).toBeUndefined();
  });
});
