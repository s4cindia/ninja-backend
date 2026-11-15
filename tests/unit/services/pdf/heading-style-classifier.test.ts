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
