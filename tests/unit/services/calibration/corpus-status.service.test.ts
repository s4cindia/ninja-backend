import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    corpusDocument: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    calibrationRun: {
      findMany: vi.fn(),
    },
    annotationSession: {
      groupBy: vi.fn(),
    },
    zone: {
      groupBy: vi.fn(),
    },
    user: {
      findMany: vi.fn(),
    },
    $queryRaw: vi.fn(),
  },
}));

import prisma from '../../../../src/lib/prisma';
import {
  deriveStatus,
  listCorpusStatus,
  updateDocumentStatus,
} from '../../../../src/services/calibration/corpus-status.service';

const mDocFindMany = prisma.corpusDocument.findMany as ReturnType<typeof vi.fn>;
const mDocFindUnique = prisma.corpusDocument.findUnique as ReturnType<typeof vi.fn>;
const mDocUpdate = prisma.corpusDocument.update as ReturnType<typeof vi.fn>;
const mRunFindMany = prisma.calibrationRun.findMany as ReturnType<typeof vi.fn>;
const mSessionGroupBy = prisma.annotationSession.groupBy as ReturnType<typeof vi.fn>;
const mZoneGroupBy = prisma.zone.groupBy as ReturnType<typeof vi.fn>;
const mUserFindMany = prisma.user.findMany as ReturnType<typeof vi.fn>;
const mQueryRaw = prisma.$queryRaw as ReturnType<typeof vi.fn>;

describe('deriveStatus', () => {
  it('returns NOT_STARTED when pagesAnnotated is 0', () => {
    expect(deriveStatus(0, 100, null)).toBe('NOT_STARTED');
  });

  it('returns IN_PROGRESS when pagesAnnotated < pageCount', () => {
    expect(deriveStatus(45, 100, null)).toBe('IN_PROGRESS');
  });

  it('returns COMPLETED when pagesAnnotated == pageCount', () => {
    expect(deriveStatus(100, 100, null)).toBe('COMPLETED');
  });

  it('returns COMPLETED when pagesAnnotated exceeds pageCount (defensive)', () => {
    expect(deriveStatus(120, 100, null)).toBe('COMPLETED');
  });

  it('returns IN_PROGRESS when pageCount is null/0 but pages annotated', () => {
    expect(deriveStatus(5, null, null)).toBe('IN_PROGRESS');
    expect(deriveStatus(5, 0, null)).toBe('IN_PROGRESS');
  });

  it('override takes precedence over derivation', () => {
    expect(deriveStatus(0, 100, 'BLOCKED')).toBe('BLOCKED');
    expect(deriveStatus(50, 100, 'PENDING_REVIEW')).toBe('PENDING_REVIEW');
    expect(deriveStatus(100, 100, 'IN_PROGRESS')).toBe('IN_PROGRESS');
  });

  it('ignores invalid override value and falls back to derivation', () => {
    expect(deriveStatus(50, 100, 'GARBAGE')).toBe('IN_PROGRESS');
  });
});

describe('listCorpusStatus', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns empty rows when there are no documents', async () => {
    mDocFindMany.mockResolvedValue([]);
    const result = await listCorpusStatus();
    expect(result.rows).toEqual([]);
    expect(typeof result.generatedAt).toBe('string');
    expect(mRunFindMany).not.toHaveBeenCalled();
  });

  it('returns NOT_STARTED for a document with no calibration run or zones', async () => {
    mDocFindMany.mockResolvedValue([
      {
        id: 'doc1',
        filename: 'a.pdf',
        pageCount: 100,
        uploadedAt: new Date('2026-01-01'),
        statusNote: null,
        statusOverride: null,
        statusUpdatedAt: null,
      },
    ]);
    mRunFindMany.mockResolvedValue([]);

    const result = await listCorpusStatus();
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      documentId: 'doc1',
      pagesAnnotated: 0,
      status: 'NOT_STARTED',
      hoursSpent: 0,
      primaryAnnotator: null,
      otherAnnotatorCount: 0,
      lastUpdatedAt: null,
    });
  });

  it('aggregates pages, hours, primary annotator, and renders IN_PROGRESS', async () => {
    mDocFindMany.mockResolvedValue([
      {
        id: 'doc1',
        filename: 'crossbills.pdf',
        pageCount: 226,
        uploadedAt: new Date('2026-04-01'),
        statusNote: 'on track',
        statusOverride: null,
        statusUpdatedAt: new Date('2026-05-01T10:00:00Z'),
      },
    ]);
    mRunFindMany.mockResolvedValue([
      { id: 'run1', documentId: 'doc1' },
    ]);
    // 220 distinct verified pages
    mQueryRaw.mockResolvedValue([
      { calibrationRunId: 'run1', pagesAnnotated: BigInt(220) },
    ]);
    // 5.5 hours = 19,800,000 ms
    mSessionGroupBy.mockResolvedValue([
      { calibrationRunId: 'run1', _sum: { activeMs: 19_800_000 } },
    ]);
    mZoneGroupBy.mockImplementation((args: { by: string[] }) => {
      if (args.by.includes('verifiedBy')) {
        return Promise.resolve([
          { calibrationRunId: 'run1', verifiedBy: 'user-poorna', _count: { _all: 800 } },
          { calibrationRunId: 'run1', verifiedBy: 'user-nambi', _count: { _all: 50 } },
          // System rows are filtered out:
          { calibrationRunId: 'run1', verifiedBy: 'auto-annotation', _count: { _all: 1000 } },
        ]);
      }
      // _max updatedAt
      return Promise.resolve([
        {
          calibrationRunId: 'run1',
          _max: { updatedAt: new Date('2026-05-06T15:30:00Z') },
        },
      ]);
    });
    mUserFindMany.mockResolvedValue([
      { id: 'user-poorna', firstName: 'Poornakala', lastName: 'U', email: 'p@x.com' },
      { id: 'user-nambi', firstName: 'Nambi', lastName: 'R', email: 'n@x.com' },
    ]);

    const result = await listCorpusStatus();
    const row = result.rows[0];

    expect(row.pagesAnnotated).toBe(220);
    expect(row.status).toBe('IN_PROGRESS');
    expect(row.hoursSpent).toBe(5.5);
    expect(row.primaryAnnotator).toEqual({
      userId: 'user-poorna',
      displayName: 'Poornakala U',
      email: 'p@x.com',
    });
    expect(row.otherAnnotatorCount).toBe(1);
    // lastUpdatedAt is max(statusUpdatedAt, max zone updatedAt)
    expect(row.lastUpdatedAt).toBe('2026-05-06T15:30:00.000Z');
    expect(row.statusNote).toBe('on track');
  });

  it('override BLOCKED wins even when derivation would say COMPLETED', async () => {
    mDocFindMany.mockResolvedValue([
      {
        id: 'doc1',
        filename: 'patton.pdf',
        pageCount: 50,
        uploadedAt: new Date('2026-04-01'),
        statusNote: null,
        statusOverride: 'BLOCKED',
        statusUpdatedAt: null,
      },
    ]);
    mRunFindMany.mockResolvedValue([{ id: 'run1', documentId: 'doc1' }]);
    mQueryRaw.mockResolvedValue([
      { calibrationRunId: 'run1', pagesAnnotated: BigInt(50) },
    ]);
    mSessionGroupBy.mockResolvedValue([]);
    mZoneGroupBy.mockResolvedValue([]);
    mUserFindMany.mockResolvedValue([]);

    const result = await listCorpusStatus();
    expect(result.rows[0].status).toBe('BLOCKED');
    expect(result.rows[0].statusOverride).toBe('BLOCKED');
    expect(result.rows[0].pagesAnnotated).toBe(50);
  });

  it('returns COMPLETED when pagesAnnotated == pageCount and no override', async () => {
    mDocFindMany.mockResolvedValue([
      {
        id: 'doc1',
        filename: 'aulakh.pdf',
        pageCount: 295,
        uploadedAt: new Date('2026-03-01'),
        statusNote: null,
        statusOverride: null,
        statusUpdatedAt: null,
      },
    ]);
    mRunFindMany.mockResolvedValue([{ id: 'run1', documentId: 'doc1' }]);
    mQueryRaw.mockResolvedValue([
      { calibrationRunId: 'run1', pagesAnnotated: BigInt(295) },
    ]);
    mSessionGroupBy.mockResolvedValue([]);
    mZoneGroupBy.mockResolvedValue([]);
    mUserFindMany.mockResolvedValue([]);

    const result = await listCorpusStatus();
    expect(result.rows[0].status).toBe('COMPLETED');
  });
});

describe('updateDocumentStatus', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns null when document does not exist', async () => {
    mDocFindUnique.mockResolvedValue(null);
    const result = await updateDocumentStatus(
      'missing',
      { statusOverride: 'BLOCKED' },
      'user-1',
    );
    expect(result).toBeNull();
    expect(mDocUpdate).not.toHaveBeenCalled();
  });

  it('writes statusOverride, statusNote, and stamps updater + timestamp', async () => {
    mDocFindUnique.mockResolvedValue({ id: 'doc1' });
    mDocUpdate.mockResolvedValue({});
    // listCorpusStatus refetch — minimal happy path
    mDocFindMany.mockResolvedValue([
      {
        id: 'doc1',
        filename: 'a.pdf',
        pageCount: 100,
        uploadedAt: new Date('2026-01-01'),
        statusNote: 'fresh note',
        statusOverride: 'PENDING_REVIEW',
        statusUpdatedAt: new Date('2026-05-07T00:00:00Z'),
      },
    ]);
    mRunFindMany.mockResolvedValue([]);

    const result = await updateDocumentStatus(
      'doc1',
      { statusOverride: 'PENDING_REVIEW', statusNote: 'fresh note' },
      'user-99',
    );

    expect(mDocUpdate).toHaveBeenCalledOnce();
    const updateArg = mDocUpdate.mock.calls[0][0] as {
      where: { id: string };
      data: {
        statusOverride?: unknown;
        statusNote?: unknown;
        statusUpdatedAt?: unknown;
        statusUpdatedBy?: unknown;
      };
    };
    expect(updateArg.where.id).toBe('doc1');
    expect(updateArg.data.statusOverride).toBe('PENDING_REVIEW');
    expect(updateArg.data.statusNote).toBe('fresh note');
    expect(updateArg.data.statusUpdatedBy).toBe('user-99');
    expect(updateArg.data.statusUpdatedAt).toBeInstanceOf(Date);

    expect(result?.status).toBe('PENDING_REVIEW');
    expect(result?.statusNote).toBe('fresh note');
  });

  it('clears the override when statusOverride: null is sent', async () => {
    mDocFindUnique.mockResolvedValue({ id: 'doc1' });
    mDocUpdate.mockResolvedValue({});
    mDocFindMany.mockResolvedValue([
      {
        id: 'doc1',
        filename: 'a.pdf',
        pageCount: 100,
        uploadedAt: new Date('2026-01-01'),
        statusNote: null,
        statusOverride: null,
        statusUpdatedAt: new Date(),
      },
    ]);
    mRunFindMany.mockResolvedValue([]);

    await updateDocumentStatus('doc1', { statusOverride: null }, 'user-99');

    const updateArg = mDocUpdate.mock.calls[0][0] as {
      data: { statusOverride?: unknown };
    };
    expect(updateArg.data.statusOverride).toBeNull();
  });
});
