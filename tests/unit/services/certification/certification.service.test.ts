import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    job: { findUnique: vi.fn() },
    jobExternalAcrobatReport: { findUnique: vi.fn() },
    jobExternalPacReport: { findUnique: vi.fn() },
    jobCertification: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
  },
}));

vi.mock('../../../../src/services/certification/remediated-file-hash', () => ({
  getCurrentRemediatedFileHash: vi.fn(),
}));

import { Prisma } from '@prisma/client';
import prisma from '../../../../src/lib/prisma';
import { getCurrentRemediatedFileHash } from '../../../../src/services/certification/remediated-file-hash';
import { AppError } from '../../../../src/utils/app-error';
import {
  certifyJob,
  getCertificationState,
  revokeCertification,
  acrobatRuleKey,
  type CertifyInput,
} from '../../../../src/services/certification/certification.service';

const db = prisma as unknown as {
  job: { findUnique: ReturnType<typeof vi.fn> };
  jobExternalAcrobatReport: { findUnique: ReturnType<typeof vi.fn> };
  jobExternalPacReport: { findUnique: ReturnType<typeof vi.fn> };
  jobCertification: {
    findFirst: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
};
const hash = getCurrentRemediatedFileHash as unknown as ReturnType<typeof vi.fn>;

const SHA = 'a'.repeat(64);
const T_ACROBAT = new Date('2026-11-28T10:00:00Z');
const T_PAC = new Date('2026-11-28T10:05:00Z');

const TAB = { category: 'Page Content', rule: 'Tab order', ruleId: 'TabOrder', status: 'Failed', description: 'x' };
const HEADERS = { category: 'Tables', rule: 'Headers', ruleId: 'TableHeaders', status: 'Failed', description: 'y' };

function acrobatReport(over: Record<string, unknown> = {}) {
  return {
    id: 'acro-1', s3Key: 'acro-key', updatedAt: T_ACROBAT, remediatedSha256: SHA,
    failed: 0, failedManually: 0, failedRules: [], ...over,
  };
}
function pacReport(over: Record<string, unknown> = {}) {
  return { id: 'pac-1', s3Key: 'pac-key', updatedAt: T_PAC, remediatedSha256: SHA, fail: 0, ...over };
}
function input(over: Partial<CertifyInput> = {}): CertifyInput {
  return { certifiedById: 'tl-1', acrobatWaivers: [], pacPdfUaErrors: 0, pacWaivers: [], ...over };
}
function activeCert(over: Record<string, unknown> = {}) {
  return {
    id: 'cert-1', jobId: 'job-1', pdfSha256: SHA, revokedAt: null,
    acrobatReportS3Key: 'acro-key', acrobatReportUpdatedAt: T_ACROBAT,
    pacReportS3Key: 'pac-key', pacReportUpdatedAt: T_PAC, ...over,
  };
}
async function blockedCodes(p: Promise<unknown>): Promise<string[]> {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  expect(err).toMatchObject({ statusCode: 422, code: 'CERTIFICATION_BLOCKED' });
  return ((err as AppError).details as { problems: { code: string }[] }).problems.map((x) => x.code);
}

beforeEach(() => {
  vi.clearAllMocks();
  db.job.findUnique.mockResolvedValue({ id: 'job-1', type: 'PDF_ACCESSIBILITY' });
  hash.mockResolvedValue({ sha256: SHA, fileRef: 'job-storage/job-1/remediated/x.pdf' });
  db.jobExternalAcrobatReport.findUnique.mockResolvedValue(acrobatReport());
  db.jobExternalPacReport.findUnique.mockResolvedValue(pacReport());
  db.jobCertification.findFirst.mockResolvedValue(null);
  db.jobCertification.updateMany.mockResolvedValue({ count: 1 });
  db.jobCertification.create.mockImplementation(async ({ data }: { data: object }) => ({ id: 'cert-new', ...data }));
});

describe('certifyJob', () => {
  it('certifies a clean job, pinning the PDF hash and both evidence uploads', async () => {
    const cert = await certifyJob('job-1', input({ acrobatNotes: '  checked all  ' }));

    expect(db.jobCertification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        jobId: 'job-1',
        pdfSha256: SHA,
        remediatedFileRef: 'job-storage/job-1/remediated/x.pdf',
        certifiedById: 'tl-1',
        acrobatNotes: 'checked all',
        acrobatReportId: 'acro-1', acrobatReportS3Key: 'acro-key', acrobatReportUpdatedAt: T_ACROBAT,
        acrobatFailed: 0, acrobatWaivers: [],
        pacReportId: 'pac-1', pacReportS3Key: 'pac-key', pacReportUpdatedAt: T_PAC,
        pacFail: 0, pacPdfUaErrorsAttested: 0, pacWaivers: [],
      }),
    });
    expect(cert.id).toBe('cert-new');
  });

  it('accepts waived Acrobat failures and records who/when/why per rule', async () => {
    db.jobExternalAcrobatReport.findUnique.mockResolvedValue(acrobatReport({ failed: 2, failedRules: [TAB, HEADERS] }));

    await certifyJob('job-1', input({
      acrobatWaivers: [
        { ruleKey: 'TabOrder', reason: 'Known false positive on pages without links (QC F-21)' },
        { ruleKey: 'TableHeaders', reason: 'Layout table, artifacted in the tag tree' },
      ],
    }));

    const data = db.jobCertification.create.mock.calls[0][0].data;
    expect(data.acrobatFailed).toBe(2);
    expect(data.acrobatWaivers).toEqual([
      expect.objectContaining({ ruleKey: 'TabOrder', category: 'Page Content', rule: 'Tab order', waivedById: 'tl-1', reason: expect.stringContaining('F-21') }),
      expect.objectContaining({ ruleKey: 'TableHeaders', waivedById: 'tl-1', waivedAt: expect.any(String) }),
    ]);
  });

  it('accepts PAC failures waived per check, counts summing to the occurrence total', async () => {
    // PAC's fail counts occurrences: 24 = 13 of one list error + 11 of a contrast check.
    db.jobExternalPacReport.findUnique.mockResolvedValue(pacReport({ fail: 24 }));

    await certifyJob('job-1', input({
      pacWaivers: [
        { check: 'List item content', count: 13, reason: 'Run-in list labels; reviewed, reads correctly' },
        { check: '  Contrast  ', count: 11, reason: 'Decorative text, artifacted' },
      ],
    }));

    const data = db.jobCertification.create.mock.calls[0][0].data;
    expect(data.pacFail).toBe(24);
    expect(data.pacWaivers).toEqual([
      { check: 'List item content', count: 13, reason: 'Run-in list labels; reviewed, reads correctly', waivedById: 'tl-1', waivedAt: expect.any(String) },
      { check: 'Contrast', count: 11, reason: 'Decorative text, artifacted', waivedById: 'tl-1', waivedAt: expect.any(String) },
    ]);
  });

  it.each([
    ['too few', [{ check: 'List item content', count: 13, reason: 'covers only part' }]],
    ['too many', [{ check: 'List item content', count: 13, reason: 'r1 reason' }, { check: 'Contrast', count: 12, reason: 'r2 reason' }]],
    ['none', []],
  ])('blocks when the waived counts do not sum to the fail count (%s)', async (_label, pacWaivers) => {
    db.jobExternalPacReport.findUnique.mockResolvedValue(pacReport({ fail: 24 }));
    expect(await blockedCodes(certifyJob('job-1', input({ pacWaivers })))).toEqual(['PAC_WAIVER_COUNT_MISMATCH']);
  });

  it('blocks a check waived twice (case-insensitive), even if the counts add up', async () => {
    db.jobExternalPacReport.findUnique.mockResolvedValue(pacReport({ fail: 24 }));
    const codes = await blockedCodes(certifyJob('job-1', input({
      pacWaivers: [
        { check: 'Contrast', count: 12, reason: 'first half' },
        { check: 'contrast ', count: 12, reason: 'second half' },
      ],
    })));
    expect(codes).toEqual(['PAC_WAIVER_DUPLICATE_CHECK']);
  });

  it('reports every unmet rule together, and creates nothing', async () => {
    db.jobExternalAcrobatReport.findUnique.mockResolvedValue(acrobatReport({ failed: 2, failedRules: [TAB, HEADERS] }));
    db.jobExternalPacReport.findUnique.mockResolvedValue(pacReport({ fail: 2 }));

    const codes = await blockedCodes(certifyJob('job-1', input({
      acrobatWaivers: [
        { ruleKey: 'TabOrder', reason: 'False positive' },
        { ruleKey: 'FigAltText', reason: 'This rule did not fail' },
      ],
      pacPdfUaErrors: 1,
      pacWaivers: [{ check: 'Contrast', count: 1, reason: 'only one of two' }],
    })));

    expect(codes.sort()).toEqual([
      'ACROBAT_FAILURE_NOT_WAIVED', // TableHeaders
      'ACROBAT_WAIVER_FOR_PASSING_RULE', // FigAltText
      'PAC_PDFUA_ERRORS',
      'PAC_WAIVER_COUNT_MISMATCH',
    ]);
    expect(db.jobCertification.create).not.toHaveBeenCalled();
  });

  it('requires both reports', async () => {
    db.jobExternalAcrobatReport.findUnique.mockResolvedValue(null);
    db.jobExternalPacReport.findUnique.mockResolvedValue(null);
    expect((await blockedCodes(certifyJob('job-1', input()))).sort()).toEqual(['ACROBAT_REPORT_MISSING', 'PAC_REPORT_MISSING']);
  });

  it('rejects reports with remediatedSha256 = null (uploaded before any remediated file)', async () => {
    db.jobExternalAcrobatReport.findUnique.mockResolvedValue(acrobatReport({ remediatedSha256: null }));
    db.jobExternalPacReport.findUnique.mockResolvedValue(pacReport({ remediatedSha256: null }));
    expect((await blockedCodes(certifyJob('job-1', input()))).sort()).toEqual(['ACROBAT_REPORT_NOT_BOUND', 'PAC_REPORT_NOT_BOUND']);
  });

  it('rejects reports produced for an earlier version of the PDF', async () => {
    db.jobExternalPacReport.findUnique.mockResolvedValue(pacReport({ remediatedSha256: 'b'.repeat(64) }));
    expect(await blockedCodes(certifyJob('job-1', input()))).toEqual(['PAC_REPORT_STALE']);
  });

  it('refuses a job with no remediated file', async () => {
    hash.mockResolvedValue(null);
    expect(await blockedCodes(certifyJob('job-1', input()))).toContain('NO_REMEDIATED_FILE');
  });

  it('refuses Acrobat failures it cannot identify (operator-entered counts, no rule table)', async () => {
    db.jobExternalAcrobatReport.findUnique.mockResolvedValue(acrobatReport({ failed: 2, failedRules: [] }));
    expect(await blockedCodes(certifyJob('job-1', input()))).toEqual(['ACROBAT_FAILURES_UNIDENTIFIED']);
  });

  it('counts Failed manually as a failure that needs a waiver', async () => {
    const manual = { ...TAB, status: 'Failed manually' };
    db.jobExternalAcrobatReport.findUnique.mockResolvedValue(acrobatReport({ failed: 0, failedManually: 1, failedRules: [manual] }));
    expect(await blockedCodes(certifyJob('job-1', input()))).toEqual(['ACROBAT_FAILURE_NOT_WAIVED']);
  });

  it('requires a known PAC fail count', async () => {
    db.jobExternalPacReport.findUnique.mockResolvedValue(pacReport({ fail: null }));
    expect(await blockedCodes(certifyJob('job-1', input()))).toEqual(['PAC_FAIL_COUNT_MISSING']);
  });

  it('409s while a still-valid certification exists', async () => {
    db.jobCertification.findFirst.mockResolvedValue(activeCert());
    await expect(certifyJob('job-1', input())).rejects.toMatchObject({ statusCode: 409, code: 'ALREADY_CERTIFIED' });
    expect(db.jobCertification.updateMany).not.toHaveBeenCalled();
  });

  it('revokes a stale active certification (PDF changed) and certifies the new file', async () => {
    db.jobCertification.findFirst.mockResolvedValue(activeCert({ pdfSha256: 'old'.padEnd(64, '0') }));

    await certifyJob('job-1', input());

    expect(db.jobCertification.updateMany).toHaveBeenCalledWith({
      where: { jobId: 'job-1', revokedAt: null, id: 'cert-1' },
      data: expect.objectContaining({ revokedReason: 'pdf-changed', revokedById: null }),
    });
    expect(db.jobCertification.create).toHaveBeenCalled();
  });

  it('maps a lost concurrent race (partial unique index) to 409', async () => {
    db.jobCertification.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'x' }),
    );
    await expect(certifyJob('job-1', input())).rejects.toMatchObject({ statusCode: 409, code: 'ALREADY_CERTIFIED' });
  });

  it('refuses non-PDF jobs and unknown jobs', async () => {
    db.job.findUnique.mockResolvedValueOnce({ id: 'job-1', type: 'EPUB_ACCESSIBILITY' });
    await expect(certifyJob('job-1', input())).rejects.toMatchObject({ statusCode: 400, code: 'NOT_A_PDF_JOB' });
    db.job.findUnique.mockResolvedValueOnce(null);
    await expect(certifyJob('job-1', input())).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('getCertificationState', () => {
  function history(active: Record<string, unknown> | null, revokedAfter = false) {
    db.jobCertification.findFirst.mockResolvedValue(active);
    db.jobCertification.findMany.mockResolvedValue(
      active ? [{ ...active, revokedAt: revokedAfter ? new Date() : null }] : [],
    );
  }

  it('keeps a valid certification active, without consulting team membership', async () => {
    history(activeCert());
    const state = await getCertificationState('job-1');
    expect(state.active).toMatchObject({ id: 'cert-1' });
    expect(db.jobCertification.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ['pdf-changed', () => hash.mockResolvedValue({ sha256: 'c'.repeat(64), fileRef: 'k' })],
    ['pdf-changed', () => hash.mockResolvedValue(null)],
    ['acrobat-report-deleted', () => db.jobExternalAcrobatReport.findUnique.mockResolvedValue(null)],
    ['acrobat-report-replaced', () => db.jobExternalAcrobatReport.findUnique.mockResolvedValue(acrobatReport({ s3Key: 'new-key' }))],
    ['pac-report-deleted', () => db.jobExternalPacReport.findUnique.mockResolvedValue(null)],
    ['pac-report-replaced', () => db.jobExternalPacReport.findUnique.mockResolvedValue(pacReport({ updatedAt: new Date('2026-11-28T11:00:00Z') }))],
  ])('revokes on read with reason %s', async (reason, change) => {
    history(activeCert(), true);
    change();

    const state = await getCertificationState('job-1');

    expect(db.jobCertification.updateMany).toHaveBeenCalledWith({
      where: { jobId: 'job-1', revokedAt: null, id: 'cert-1' },
      data: expect.objectContaining({ revokedReason: reason }),
    });
    expect(state.active).toBeNull();
    expect(state.history).toHaveLength(1);
  });

  it('a stale read that lost a race to revoke + re-certify leaves the new certification alone', async () => {
    // Read loaded cert-1; meanwhile another request revoked it and issued cert-2.
    history(activeCert(), true);
    hash.mockResolvedValue({ sha256: 'c'.repeat(64), fileRef: 'k' });
    db.jobCertification.updateMany.mockResolvedValue({ count: 0 });

    await getCertificationState('job-1');

    // Scoped to cert-1: cannot match cert-2.
    expect(db.jobCertification.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { jobId: 'job-1', revokedAt: null, id: 'cert-1' } }),
    );
  });

  it('does no hashing when there is no active certification', async () => {
    history(null);
    expect(await getCertificationState('job-1')).toEqual({ active: null, history: [] });
    expect(hash).not.toHaveBeenCalled();
  });
});

describe('revokeCertification', () => {
  it('records the manual reason and who revoked', async () => {
    await revokeCertification('job-1', 'tl-1', '  customer asked for changes  ');
    expect(db.jobCertification.updateMany).toHaveBeenCalledWith({
      where: { jobId: 'job-1', revokedAt: null },
      data: expect.objectContaining({ revokedById: 'tl-1', revokedReason: 'manual: customer asked for changes' }),
    });
  });

  it('404s when nothing is active', async () => {
    db.jobCertification.updateMany.mockResolvedValue({ count: 0 });
    await expect(revokeCertification('job-1', 'tl-1', 'whatever')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('acrobatRuleKey', () => {
  it('uses the rule id, falling back to category / rule', () => {
    expect(acrobatRuleKey(TAB)).toBe('TabOrder');
    expect(acrobatRuleKey({ ruleId: null, category: 'Tables', rule: 'Summary' })).toBe('Tables / Summary');
  });
});
