/**
 * Audit-pipeline dismissal integration.
 *
 * The audit pipeline calls `attachDismissals(jobId, issues)` at the
 * end of a run. This suite feeds a fixture issue list plus a
 * pre-existing set of dismissals and asserts the matching issue
 * carries `dismissedAt` / `dismissedBy`, while non-matching issues
 * are explicitly nulled.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    issueDismissal: { findMany: vi.fn() },
  },
}));

vi.mock('../../../../src/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import prisma from '../../../../src/lib/prisma';
import {
  attachDismissals,
  computeInstanceKey,
  type DismissableIssue,
} from '../../../../src/services/issues/issue-dismissal.service';

const mFindMany = prisma.issueDismissal.findMany as ReturnType<typeof vi.fn>;

/** Build a stored dismissal row matching the given issue content. */
function dismissalRow(
  code: string,
  location: string,
  message: string,
  overrides: Partial<{ dismissedBy: string; dismissedAt: Date }> = {},
) {
  return {
    id: `d-${code}`,
    jobId: 'job-1',
    code,
    location,
    instanceKey: computeInstanceKey(code, location, message),
    dismissedBy: overrides.dismissedBy ?? 'operator-1',
    dismissedAt: overrides.dismissedAt ?? new Date('2026-05-01T10:00:00.000Z'),
    reason: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('attachDismissals', () => {
  it('attaches dismissedAt/dismissedBy to the issue whose content matches a dismissal', async () => {
    mFindMany.mockResolvedValue([
      dismissalRow('PRH-HASHTAG-NOT-CAMEL-CASE', 'ch1.xhtml', 'hashtag #brand not camelCase'),
    ]);

    const issues: DismissableIssue[] = [
      {
        code: 'PRH-HASHTAG-NOT-CAMEL-CASE',
        location: 'ch1.xhtml',
        message: 'hashtag #brand not camelCase',
      },
      { code: 'EPUB-IMG-001', location: 'ch2.xhtml', message: 'missing alt text' },
    ];

    const matched = await attachDismissals('job-1', issues);

    expect(matched).toBe(1);
    expect(issues[0].dismissedAt).toBe('2026-05-01T10:00:00.000Z');
    expect(issues[0].dismissedBy).toBe('operator-1');
    // Non-matching issue is explicitly nulled, not left undefined.
    expect(issues[1].dismissedAt).toBeNull();
    expect(issues[1].dismissedBy).toBeNull();
  });

  it('nulls every issue when the job has no dismissals (deleted-dismissal revert path)', async () => {
    mFindMany.mockResolvedValue([]);

    const issues: DismissableIssue[] = [
      { code: 'CODE-A', location: 'a.xhtml', message: 'msg a' },
      { code: 'CODE-B', location: 'b.xhtml', message: 'msg b' },
    ];

    const matched = await attachDismissals('job-1', issues);

    expect(matched).toBe(0);
    expect(issues.every((i) => i.dismissedAt === null && i.dismissedBy === null)).toBe(true);
  });

  it('does NOT match when the message changed (content-derived key re-fires)', async () => {
    // A dismissal exists for the OLD message; the re-audit produced a
    // new message for the same code+location, so the key differs and
    // the dismissal must not carry through.
    mFindMany.mockResolvedValue([
      dismissalRow('PRH-LANG-INLINE-NOT-MARKED', 'ch1.xhtml', 'old message text'),
    ]);

    const issues: DismissableIssue[] = [
      {
        code: 'PRH-LANG-INLINE-NOT-MARKED',
        location: 'ch1.xhtml',
        message: 'new message text after content edit',
      },
    ];

    const matched = await attachDismissals('job-1', issues);

    expect(matched).toBe(0);
    expect(issues[0].dismissedAt).toBeNull();
  });

  it('matches an issue with no location against a dismissal stored with empty location', async () => {
    mFindMany.mockResolvedValue([dismissalRow('RSC-005', '', 'epubcheck warning')]);

    const issues: DismissableIssue[] = [
      { code: 'RSC-005', message: 'epubcheck warning' }, // location omitted
    ];

    const matched = await attachDismissals('job-1', issues);
    expect(matched).toBe(1);
    expect(issues[0].dismissedAt).not.toBeNull();
  });

  it('attaches each dismissal to only its own matching instance', async () => {
    mFindMany.mockResolvedValue([
      dismissalRow('CODE', 'ch1.xhtml', 'first instance', { dismissedBy: 'op-a' }),
      dismissalRow('CODE', 'ch2.xhtml', 'second instance', { dismissedBy: 'op-b' }),
    ]);

    const issues: DismissableIssue[] = [
      { code: 'CODE', location: 'ch1.xhtml', message: 'first instance' },
      { code: 'CODE', location: 'ch2.xhtml', message: 'second instance' },
      { code: 'CODE', location: 'ch3.xhtml', message: 'third instance — not dismissed' },
    ];

    const matched = await attachDismissals('job-1', issues);

    expect(matched).toBe(2);
    expect(issues[0].dismissedBy).toBe('op-a');
    expect(issues[1].dismissedBy).toBe('op-b');
    expect(issues[2].dismissedBy).toBeNull();
  });

  it('handles an empty issue list without error', async () => {
    mFindMany.mockResolvedValue([dismissalRow('CODE', 'loc', 'msg')]);
    const matched = await attachDismissals('job-1', []);
    expect(matched).toBe(0);
  });
});
