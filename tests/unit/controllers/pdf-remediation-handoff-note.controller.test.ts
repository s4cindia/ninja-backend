/**
 * PdfRemediationController.getHandoffNote
 *
 * A factual cover note for handing a remediated file to an external QC
 * partner -- every field read from the job's own real records (score,
 * combinedIssues, PdfAutoRemediationRun, TeamReview), nothing templated or
 * inferred. Confirms the (code, disposition) grouping doesn't collapse a
 * code's differently-dispositioned instances into one count, and that a
 * missing optional record (no auto-remediation run, no team review) comes
 * back as null rather than a crash.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Response } from 'express';
import { pdfRemediationController } from '../../../src/controllers/pdf-remediation.controller';
import { AuthenticatedRequest } from '../../../src/types/authenticated-request';
import prisma from '../../../src/lib/prisma';

vi.mock('../../../src/lib/prisma', () => ({
  default: {
    job: { findFirst: vi.fn() },
    pdfAutoRemediationRun: { findUnique: vi.fn() },
    teamReview: { findFirst: vi.fn() },
  },
}));
vi.mock('../../../src/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function makeRes(): Response {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

function makeReq(): AuthenticatedRequest {
  return {
    params: { jobId: 'job-1' },
    user: { id: 'user-1', tenantId: 'tenant-1' },
  } as unknown as AuthenticatedRequest;
}

describe('PdfRemediationController.getHandoffNote', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 404 when the job does not exist or belongs to another tenant', async () => {
    vi.mocked(prisma.job.findFirst).mockResolvedValue(null);

    const req = makeReq();
    const res = makeRes();
    await pdfRemediationController.getHandoffNote(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('groups remaining issues by (code, disposition) separately -- the same code with two different dispositions stays two rows, not one merged count', async () => {
    vi.mocked(prisma.job.findFirst).mockResolvedValue({
      id: 'job-1',
      input: { fileName: 'Karsaklian_189165_9781606497623.pdf' },
      output: {
        score: 97,
        combinedIssues: [
          { code: 'MATTERHORN-13-001', triage: { disposition: 'auto-resolved' } },
          { code: 'MATTERHORN-13-001', triage: { disposition: 'auto-resolved' } },
          { code: 'MATTERHORN-13-001', triage: { disposition: 'manual' } },
          { code: 'TOC-STRUCTURE-MISSING', triage: { disposition: 'manual' } },
        ],
      },
    } as any);
    vi.mocked(prisma.pdfAutoRemediationRun.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.teamReview.findFirst).mockResolvedValue(null);

    const req = makeReq();
    const res = makeRes();
    await pdfRemediationController.getHandoffNote(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = (res.json as any).mock.calls[0][0];
    expect(payload.data.score).toBe(97);
    expect(payload.data.totalRemaining).toBe(4);
    expect(payload.data.remainingIssues).toEqual(
      expect.arrayContaining([
        { code: 'MATTERHORN-13-001', disposition: 'auto-resolved', count: 2 },
        { code: 'MATTERHORN-13-001', disposition: 'manual', count: 1 },
        { code: 'TOC-STRUCTURE-MISSING', disposition: 'manual', count: 1 },
      ])
    );
    expect(payload.data.remainingIssues).toHaveLength(3);
  });

  it('returns null for autoRemediation and teamReview when neither exists, rather than throwing', async () => {
    vi.mocked(prisma.job.findFirst).mockResolvedValue({
      id: 'job-1',
      input: { fileName: 'doc.pdf' },
      output: { score: 100, combinedIssues: [] },
    } as any);
    vi.mocked(prisma.pdfAutoRemediationRun.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.teamReview.findFirst).mockResolvedValue(null);

    const req = makeReq();
    const res = makeRes();
    await pdfRemediationController.getHandoffNote(req, res);

    const payload = (res.json as any).mock.calls[0][0];
    expect(payload.data.autoRemediation).toBeNull();
    expect(payload.data.teamReview).toBeNull();
    expect(payload.data.remainingIssues).toEqual([]);
  });

  it('surfaces the real auto-remediation round history and the most recent team review when both exist', async () => {
    vi.mocked(prisma.job.findFirst).mockResolvedValue({
      id: 'job-1',
      input: { fileName: 'doc.pdf' },
      output: { score: 97, combinedIssues: [] },
    } as any);
    vi.mocked(prisma.pdfAutoRemediationRun.findUnique).mockResolvedValue({
      autoRoundsCompleted: 2,
      autoMaxRounds: 10,
      autoStopReason: 'converged',
      autoCostSpentUsd: 0.0198,
      autoStoppedAt: new Date('2026-11-17T04:44:50Z'),
    } as any);
    vi.mocked(prisma.teamReview.findFirst).mockResolvedValue({
      outcome: 'OK',
      reviewedAt: new Date('2026-11-17T05:00:00Z'),
      notes: 'Looks good',
      reviewer: { firstName: 'Ambai', lastName: 'Venkatesa', email: 'avr.venkatesa@gmail.com' },
    } as any);

    const req = makeReq();
    const res = makeRes();
    await pdfRemediationController.getHandoffNote(req, res);

    const payload = (res.json as any).mock.calls[0][0];
    expect(payload.data.autoRemediation).toEqual({
      roundsCompleted: 2,
      maxRounds: 10,
      stopReason: 'converged',
      costSpentUsd: 0.0198,
      stoppedAt: new Date('2026-11-17T04:44:50Z'),
    });
    expect(payload.data.teamReview.outcome).toBe('OK');
    expect(payload.data.teamReview.reviewedBy).toBe('Ambai Venkatesa');
  });

  it('falls back to the reviewer\'s email when no first/last name is on file', async () => {
    vi.mocked(prisma.job.findFirst).mockResolvedValue({
      id: 'job-1',
      input: { fileName: 'doc.pdf' },
      output: { score: 97, combinedIssues: [] },
    } as any);
    vi.mocked(prisma.pdfAutoRemediationRun.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.teamReview.findFirst).mockResolvedValue({
      outcome: 'OK',
      reviewedAt: new Date('2026-11-17T05:00:00Z'),
      notes: null,
      reviewer: { firstName: null, lastName: null, email: 'reviewer@example.com' },
    } as any);

    const req = makeReq();
    const res = makeRes();
    await pdfRemediationController.getHandoffNote(req, res);

    const payload = (res.json as any).mock.calls[0][0];
    expect(payload.data.teamReview.reviewedBy).toBe('reviewer@example.com');
  });
});
