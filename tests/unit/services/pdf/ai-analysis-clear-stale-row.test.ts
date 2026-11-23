/**
 * QC brief Theme A (docs/qc/2026-11-23-ninja-qc-karsaklian-brief.md):
 * clearStaleRowForReusedId. See its own doc comment in ai-analysis.service.ts
 * for the full real incident -- issue.id is a per-run sequential counter, so
 * a different finding can reuse the same id a stale "Applied" row already
 * sits under.
 *
 * deleteMany is faked against a small in-memory row array (not just
 * inspected as call args) so these tests prove real delete/preserve
 * behavior, not merely "the right object was passed to Prisma".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface FakeRow { jobId: string; issueId: string; issueFingerprint: string | null }
let rows: FakeRow[] = [];

vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    aiAnalysis: {
      deleteMany: vi.fn(async ({ where }: { where: { jobId: string; issueId: string; OR: Array<{ issueFingerprint?: { not: string } | null }> } }) => {
        const before = rows.length;
        rows = rows.filter((r) => {
          const matchesScope = r.jobId === where.jobId && r.issueId === where.issueId;
          if (!matchesScope) return true; // not in scope -- always kept
          const matchesOr = where.OR.some((clause) => {
            if (clause.issueFingerprint === null) return r.issueFingerprint === null;
            return r.issueFingerprint !== clause.issueFingerprint!.not;
          });
          return !matchesOr; // keep unless it matches the delete condition
        });
        return { count: before - rows.length };
      }),
    },
  },
}));

import { clearStaleRowForReusedId } from '../../../../src/services/pdf/ai-analysis.service';

describe('clearStaleRowForReusedId', () => {
  beforeEach(() => {
    rows = [];
  });

  it('(a) deletes a row at this issue id whose own fingerprint does not match the current one', async () => {
    rows = [{ jobId: 'job-1', issueId: 'reading-order-float-15', issueFingerprint: 'OLD-CODE:element-9' }];
    const issue = { id: 'reading-order-float-15', code: 'READING-ORDER-FLOAT-INTERRUPTION-MANUAL', element: 'float-interruption_r1491', pageNumber: 157, boundingBox: undefined };

    await clearStaleRowForReusedId('job-1', issue);

    expect(rows).toHaveLength(0);
  });

  it('(b) preserves a row at this issue id whose fingerprint DOES match the current one', async () => {
    const issue = { id: 'reading-order-float-15', code: 'READING-ORDER-FLOAT-INTERRUPTION-MANUAL', element: 'float-interruption_r1491', pageNumber: 157, boundingBox: undefined };
    rows = [{ jobId: 'job-1', issueId: 'reading-order-float-15', issueFingerprint: 'READING-ORDER-FLOAT-INTERRUPTION-MANUAL:float-interruption_r1491' }];

    await clearStaleRowForReusedId('job-1', issue);

    expect(rows).toHaveLength(1);
  });

  it('(c) deletes a pre-migration row (null fingerprint) at this issue id too, not just a mismatched one', async () => {
    rows = [{ jobId: 'job-1', issueId: 'bookmark-1', issueFingerprint: null }];
    const issue = { id: 'bookmark-1', code: 'BOOKMARK-MISSING-FRONT-MATTER', element: undefined, pageNumber: 1, boundingBox: undefined };

    await clearStaleRowForReusedId('job-1', issue);

    expect(rows).toHaveLength(0);
  });

  it('never touches a row under a different issueId or a different job, even with a mismatched fingerprint', async () => {
    rows = [
      { jobId: 'job-1', issueId: 'reading-order-float-99', issueFingerprint: 'UNRELATED' },
      { jobId: 'job-2', issueId: 'reading-order-float-15', issueFingerprint: 'UNRELATED' },
    ];
    const issue = { id: 'reading-order-float-15', code: 'READING-ORDER-FLOAT-INTERRUPTION-MANUAL', element: 'x', pageNumber: 1, boundingBox: undefined };

    await clearStaleRowForReusedId('job-1', issue);

    expect(rows).toHaveLength(2);
  });
});
