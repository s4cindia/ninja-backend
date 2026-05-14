import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

vi.mock('../../../../src/lib/prisma', async () => {
  const actual = await vi.importActual<typeof import('@prisma/client')>('@prisma/client');
  return {
    default: {
      issueDismissal: {
        create: vi.fn(),
        findUnique: vi.fn(),
        findMany: vi.fn(),
        delete: vi.fn(),
      },
      job: {
        findUnique: vi.fn(),
      },
    },
    Prisma: actual.Prisma,
  };
});

vi.mock('../../../../src/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import prisma, { Prisma } from '../../../../src/lib/prisma';
import {
  computeInstanceKey,
  createDismissal,
  deleteDismissal,
  listDismissals,
  getDismissalMap,
  resolveDismissalJobId,
} from '../../../../src/services/issues/issue-dismissal.service';

const mCreate = prisma.issueDismissal.create as ReturnType<typeof vi.fn>;
const mFindUnique = prisma.issueDismissal.findUnique as ReturnType<typeof vi.fn>;
const mFindMany = prisma.issueDismissal.findMany as ReturnType<typeof vi.fn>;
const mDelete = prisma.issueDismissal.delete as ReturnType<typeof vi.fn>;
const mJobFindUnique = prisma.job.findUnique as ReturnType<typeof vi.fn>;

function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '5.22.0',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('computeInstanceKey', () => {
  it('is stable — same inputs produce the same key', () => {
    const a = computeInstanceKey('PRH-HASHTAG-NOT-CAMEL-CASE', 'ch1.xhtml', 'msg');
    const b = computeInstanceKey('PRH-HASHTAG-NOT-CAMEL-CASE', 'ch1.xhtml', 'msg');
    expect(a).toBe(b);
  });

  it('changes when the message changes', () => {
    const a = computeInstanceKey('CODE', 'loc', 'message one');
    const b = computeInstanceKey('CODE', 'loc', 'message two');
    expect(a).not.toBe(b);
  });

  it('changes when the code changes', () => {
    const a = computeInstanceKey('CODE-A', 'loc', 'msg');
    const b = computeInstanceKey('CODE-B', 'loc', 'msg');
    expect(a).not.toBe(b);
  });

  it('changes when the location changes', () => {
    const a = computeInstanceKey('CODE', 'ch1.xhtml', 'msg');
    const b = computeInstanceKey('CODE', 'ch2.xhtml', 'msg');
    expect(a).not.toBe(b);
  });

  it('does not collide across the field boundary', () => {
    // 'A' + 'BC' vs 'AB' + 'C' must NOT hash the same.
    const a = computeInstanceKey('A', 'BC', 'msg');
    const b = computeInstanceKey('AB', 'C', 'msg');
    expect(a).not.toBe(b);
  });

  it('is delimiter-ambiguity safe — a literal pipe in a field cannot collide', () => {
    // A naive `${code}|${location}|${message}` join would make these
    // two tuples serialise identically; JSON-array serialisation must not.
    const a = computeInstanceKey('A|B', 'loc', 'msg');
    const b = computeInstanceKey('A', 'B|loc', 'msg');
    expect(a).not.toBe(b);
  });

  it('produces a 64-char hex sha256 digest', () => {
    const key = computeInstanceKey('CODE', 'loc', 'msg');
    expect(key).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('createDismissal', () => {
  it('computes the instanceKey and inserts a row', async () => {
    const row = { id: 'd1', jobId: 'job-1', code: 'CODE', instanceKey: 'k' };
    mCreate.mockResolvedValue(row);

    const result = await createDismissal({
      jobId: 'job-1',
      userId: 'user-1',
      code: 'CODE',
      location: 'ch1.xhtml',
      message: 'msg',
      reason: 'known false positive',
    });

    expect(result).toBe(row);
    const callArg = mCreate.mock.calls[0][0].data;
    expect(callArg.jobId).toBe('job-1');
    expect(callArg.dismissedBy).toBe('user-1');
    expect(callArg.reason).toBe('known false positive');
    expect(callArg.instanceKey).toBe(computeInstanceKey('CODE', 'ch1.xhtml', 'msg'));
  });

  it('stores reason as null when omitted', async () => {
    mCreate.mockResolvedValue({ id: 'd1' });
    await createDismissal({
      jobId: 'job-1',
      userId: 'user-1',
      code: 'CODE',
      location: 'loc',
      message: 'msg',
    });
    expect(mCreate.mock.calls[0][0].data.reason).toBeNull();
  });

  it('is idempotent — a P2002 unique violation resolves to the existing row', async () => {
    const existing = { id: 'd-existing', jobId: 'job-1', instanceKey: 'k' };
    mCreate.mockRejectedValue(p2002());
    mFindUnique.mockResolvedValue(existing);

    const result = await createDismissal({
      jobId: 'job-1',
      userId: 'user-1',
      code: 'CODE',
      location: 'loc',
      message: 'msg',
    });

    expect(result).toBe(existing);
    expect(mFindUnique).toHaveBeenCalledWith({
      where: {
        jobId_instanceKey: {
          jobId: 'job-1',
          instanceKey: computeInstanceKey('CODE', 'loc', 'msg'),
        },
      },
    });
  });

  it('rethrows non-P2002 Prisma errors', async () => {
    const otherErr = new Prisma.PrismaClientKnownRequestError('FK violation', {
      code: 'P2003',
      clientVersion: '5.22.0',
    });
    mCreate.mockRejectedValue(otherErr);
    await expect(
      createDismissal({ jobId: 'job-1', userId: 'u', code: 'C', location: 'l', message: 'm' }),
    ).rejects.toThrow(/FK violation/);
  });

  it('rethrows when P2002 fires but the existing row cannot be found (race)', async () => {
    mCreate.mockRejectedValue(p2002());
    mFindUnique.mockResolvedValue(null);
    await expect(
      createDismissal({ jobId: 'job-1', userId: 'u', code: 'C', location: 'l', message: 'm' }),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  });
});

describe('deleteDismissal', () => {
  it('deletes a dismissal that belongs to the job', async () => {
    mFindUnique.mockResolvedValue({ id: 'd1', jobId: 'job-1' });
    mDelete.mockResolvedValue({ id: 'd1' });

    await deleteDismissal('job-1', 'd1', 'user-1');
    expect(mDelete).toHaveBeenCalledWith({ where: { id: 'd1' } });
  });

  it('throws 404 when the dismissal belongs to a different job (IDOR guard)', async () => {
    mFindUnique.mockResolvedValue({ id: 'd1', jobId: 'OTHER-job' });
    await expect(deleteDismissal('job-1', 'd1', 'user-1')).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(mDelete).not.toHaveBeenCalled();
  });

  it('throws 404 when the dismissal does not exist', async () => {
    mFindUnique.mockResolvedValue(null);
    await expect(deleteDismissal('job-1', 'missing', 'user-1')).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(mDelete).not.toHaveBeenCalled();
  });
});

describe('listDismissals', () => {
  it('lists all dismissals for a job, newest first', async () => {
    const rows = [{ id: 'd1' }, { id: 'd2' }];
    mFindMany.mockResolvedValue(rows);

    const result = await listDismissals('job-1');
    expect(result).toBe(rows);
    expect(mFindMany).toHaveBeenCalledWith({
      where: { jobId: 'job-1' },
      orderBy: { dismissedAt: 'desc' },
    });
  });

  it('filters by code when supplied', async () => {
    mFindMany.mockResolvedValue([]);
    await listDismissals('job-1', { code: 'PRH-HASHTAG-NOT-CAMEL-CASE' });
    expect(mFindMany).toHaveBeenCalledWith({
      where: { jobId: 'job-1', code: 'PRH-HASHTAG-NOT-CAMEL-CASE' },
      orderBy: { dismissedAt: 'desc' },
    });
  });
});

describe('getDismissalMap', () => {
  it('returns a Map keyed by instanceKey', async () => {
    mFindMany.mockResolvedValue([
      { id: 'd1', instanceKey: 'key-a', dismissedBy: 'u1' },
      { id: 'd2', instanceKey: 'key-b', dismissedBy: 'u2' },
    ]);

    const map = await getDismissalMap('job-1');
    expect(map.size).toBe(2);
    expect(map.get('key-a')?.id).toBe('d1');
    expect(map.get('key-b')?.id).toBe('d2');
  });

  it('returns an empty Map when the job has no dismissals', async () => {
    mFindMany.mockResolvedValue([]);
    const map = await getDismissalMap('job-1');
    expect(map.size).toBe(0);
  });
});

describe('resolveDismissalJobId', () => {
  it('returns the job id itself when the job has no sourceJobId', async () => {
    mJobFindUnique.mockResolvedValue({ input: { fileName: 'book.epub' } });
    const resolved = await resolveDismissalJobId('job-1');
    expect(resolved).toBe('job-1');
  });

  it('returns input.sourceJobId for a re-audit job', async () => {
    mJobFindUnique.mockResolvedValue({
      input: { sourceJobId: 'original-job', auditType: 'reaudit' },
    });
    const resolved = await resolveDismissalJobId('reaudit-job');
    expect(resolved).toBe('original-job');
  });

  it('falls back to the job id when the job is not found', async () => {
    mJobFindUnique.mockResolvedValue(null);
    const resolved = await resolveDismissalJobId('job-1');
    expect(resolved).toBe('job-1');
  });

  it('ignores a non-string / empty sourceJobId', async () => {
    mJobFindUnique.mockResolvedValue({ input: { sourceJobId: '' } });
    expect(await resolveDismissalJobId('job-1')).toBe('job-1');
  });
});
