import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    job: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  },
}));
vi.mock('../../../../src/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import prisma from '../../../../src/lib/prisma';
import { pacReportService } from '../../../../src/services/pdf/pac-report.service';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';

/**
 * Regression coverage for a real bug Codex found on PR #577's review, which
 * applies equally to the already-merged veraPDF integration (PR #574):
 * TESTABLE_CONDITIONS was a single static set with no way to tell "this
 * validator ran and found nothing" apart from "this validator never ran at
 * all" for a given audit — so a condition only veraPDF/pdfa11y can test
 * would be classified PASS purely because the tool happened to be
 * unavailable for that specific job, a false PDF/UA-compliance result.
 *
 * Fix: veraPdfRan/pdfa11yRan flags are persisted per-audit into
 * auditReport.metadata, and the report only counts a tool's conditions as
 * testable when that flag is true for THIS job.
 */

function mockJob(overrides: {
  issues?: AuditIssue[];
  veraPdfRan?: boolean;
  pdfa11yRan?: boolean;
}) {
  return {
    id: 'job-1',
    status: 'COMPLETED',
    input: { fileName: 'test.pdf' },
    output: {
      auditReport: {
        fileName: 'test.pdf',
        issues: overrides.issues ?? [],
        metadata: {
          isTagged: true,
          veraPdfRan: overrides.veraPdfRan ?? false,
          pdfa11yRan: overrides.pdfa11yRan ?? false,
        },
      },
    },
  };
}

function findCondition(report: Awaited<ReturnType<typeof pacReportService.generateReport>>, id: string) {
  for (const cp of report.checkpoints) {
    const found = cp.conditions.find((c) => c.id === id);
    if (found) return found;
  }
  return undefined;
}

describe('PacReportService.generateReport — veraPDF/pdfa11y ran-flag gating', () => {
  beforeEach(() => {
    vi.mocked(prisma.job.findUnique).mockResolvedValue(null as never);
    vi.mocked(prisma.job.update).mockResolvedValue({} as never);
  });

  it('marks a pdfa11y-only condition UNTESTED (not PASS) when pdfa11y did not run for this audit', async () => {
    vi.mocked(prisma.job.findFirst).mockResolvedValue(mockJob({ pdfa11yRan: false }) as never);

    const report = await pacReportService.generateReport('job-1', 'tenant-1');
    const condition = findCondition(report, '28-011'); // pdfa11y-only condition

    expect(condition?.status).toBe('UNTESTED');
  });

  it('marks the same pdfa11y-only condition PASS when pdfa11y DID run and found nothing', async () => {
    vi.mocked(prisma.job.findFirst).mockResolvedValue(mockJob({ pdfa11yRan: true }) as never);

    const report = await pacReportService.generateReport('job-1', 'tenant-1');
    const condition = findCondition(report, '28-011');

    expect(condition?.status).toBe('PASS');
  });

  it('still reports FAIL for a pdfa11y-only condition with a real issue, even if pdfa11yRan is somehow false', async () => {
    const issue: AuditIssue = {
      id: 'pdfa11y-28-011',
      source: 'pdfa11y',
      severity: 'serious',
      code: 'MATTERHORN-28-011',
      message: 'Link annotation not enclosed in a Link structure element',
      matterhornCheckpoint: '28-011',
      matterhornHow: 'M',
    };
    vi.mocked(prisma.job.findFirst).mockResolvedValue(mockJob({ issues: [issue], pdfa11yRan: false }) as never);

    const report = await pacReportService.generateReport('job-1', 'tenant-1');
    const condition = findCondition(report, '28-011');

    expect(condition?.status).toBe('FAIL');
    expect(condition?.source).toBe('pdfa11y');
  });

  it('applies the same ran-flag gating to a veraPDF-only condition', async () => {
    vi.mocked(prisma.job.findFirst).mockResolvedValue(mockJob({ veraPdfRan: false }) as never);
    const report1 = await pacReportService.generateReport('job-1', 'tenant-1');
    expect(findCondition(report1, '31-009')?.status).toBe('UNTESTED'); // font-not-embedded, veraPDF-only

    vi.mocked(prisma.job.findFirst).mockResolvedValue(mockJob({ veraPdfRan: true }) as never);
    const report2 = await pacReportService.generateReport('job-1', 'tenant-1');
    expect(findCondition(report2, '31-009')?.status).toBe('PASS');
  });

  it('keeps a Ninja-native condition PASS regardless of veraPdfRan/pdfa11yRan (Ninja always runs)', async () => {
    vi.mocked(prisma.job.findFirst).mockResolvedValue(
      mockJob({ veraPdfRan: false, pdfa11yRan: false }) as never,
    );

    const report = await pacReportService.generateReport('job-1', 'tenant-1');
    const condition = findCondition(report, '07-001'); // Ninja-native (DisplayDocTitle)

    expect(condition?.status).toBe('PASS');
  });

  it('reports 01-005 as UNTESTED (not a false PASS) when no UNTAGGED-CONTENT issue is present', async () => {
    // CodeRabbit finding, confirmed real: pdf-structure.validator.ts's
    // untagged-content check only scans painted PATHS (pdf-artifact-
    // tagger.ts), not Do/BI/sh -- a tagged PDF whose only untagged content
    // is an image, inline image, or shading produces no issue there at
    // all. 01-005 is deliberately NOT in NINJA_TESTABLE_CONDITIONS, so the
    // no-failure-found case correctly falls back to UNTESTED instead of
    // claiming full condition coverage this codebase doesn't have yet.
    vi.mocked(prisma.job.findFirst).mockResolvedValue(mockJob({}) as never);

    const report = await pacReportService.generateReport('job-1', 'tenant-1');

    expect(findCondition(report, '01-005')?.status).toBe('UNTESTED');
  });

  it('still reports 01-005 as FAIL when a real UNTAGGED-CONTENT issue is present, despite the partial-coverage UNTESTED default', async () => {
    const issue: AuditIssue = {
      id: 'untagged-1',
      source: 'pdf-structure',
      severity: 'moderate',
      code: 'UNTAGGED-CONTENT',
      message: '2 vector-graphics region(s) on this page are neither tagged as real content nor marked as an artifact',
      matterhornCheckpoint: '01-005',
      matterhornHow: 'M',
      pageNumber: 1,
      location: 'Page 1',
    };
    vi.mocked(prisma.job.findFirst).mockResolvedValue(mockJob({ issues: [issue] }) as never);

    const report = await pacReportService.generateReport('job-1', 'tenant-1');
    const condition = findCondition(report, '01-005');

    expect(condition?.status).toBe('FAIL');
    expect(condition?.source).toBe('ninja');
  });
});
