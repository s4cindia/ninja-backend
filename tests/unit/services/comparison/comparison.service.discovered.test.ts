import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComparisonService } from '../../../../src/services/comparison/comparison.service';
import { ChangeStatus } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';

vi.mock('../../../../src/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

function makeMockPrisma(jobOutput: unknown) {
  return {
    job: {
      findUnique: vi.fn().mockResolvedValue(jobOutput ? { output: jobOutput } : null),
    },
  } as unknown as PrismaClient;
}

describe('ComparisonService.calculateDiscoveredFixes', () => {
  let service: ComparisonService;

  // Helper to access the private method
  function callCalculate(
    svc: ComparisonService,
    jobId: string,
    changes: { filePath: string; ruleId: string | null; status: ChangeStatus }[]
  ) {
    return (svc as unknown as {
      calculateDiscoveredFixes: typeof svc['calculateDiscoveredFixes' & keyof typeof svc];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }).calculateDiscoveredFixes(jobId, changes as any);
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 0 when the job has no output', async () => {
    service = new ComparisonService(makeMockPrisma(null));
    const result = await callCalculate(service, 'job-1', [
      { filePath: 'EPUB/chapter1.xhtml', ruleId: 'EPUB-META-001', status: ChangeStatus.APPLIED },
    ]);
    expect(result).toBe(0);
  });

  it('returns 0 when combinedIssues is absent from output', async () => {
    service = new ComparisonService(makeMockPrisma({ someOtherField: true }));
    const result = await callCalculate(service, 'job-1', [
      { filePath: 'EPUB/chapter1.xhtml', ruleId: 'EPUB-META-001', status: ChangeStatus.APPLIED },
    ]);
    expect(result).toBe(0);
  });

  it('returns 0 when combinedIssues is malformed (not an array)', async () => {
    // Malformed JSON shape — the try/catch should swallow the TypeError and return 0
    service = new ComparisonService(makeMockPrisma({ combinedIssues: 'not-an-array' }));
    const result = await callCalculate(service, 'job-1', [
      { filePath: 'EPUB/chapter1.xhtml', ruleId: 'EPUB-META-001', status: ChangeStatus.APPLIED },
    ]);
    expect(result).toBe(0);
  });

  it('does not count non-APPLIED changes as discovered', async () => {
    service = new ComparisonService(makeMockPrisma({ combinedIssues: [] }));
    const result = await callCalculate(service, 'job-1', [
      { filePath: 'chapter1.xhtml', ruleId: 'EPUB-META-001', status: ChangeStatus.FAILED },
      { filePath: 'chapter1.xhtml', ruleId: 'EPUB-META-002', status: ChangeStatus.SKIPPED },
    ]);
    expect(result).toBe(0);
  });
});
