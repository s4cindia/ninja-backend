import { describe, it, expect, vi } from 'vitest';
import { remediationService } from '../../../../src/services/epub/remediation.service';
import type { RemediationTask } from '../../../../src/services/epub/remediation.service';

vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    job: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn(), create: vi.fn() },
    validationResult: { findMany: vi.fn().mockResolvedValue([]) },
    issue: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    $transaction: vi.fn((cb: (tx: unknown) => Promise<unknown>) => cb({})),
  },
}));
vi.mock('../../../../src/services/epub/epub-audit.service', () => ({ epubAuditService: {} }));
vi.mock('../../../../src/services/validation/wcag-criteria.service', () => ({ wcagCriteriaService: {} }));
vi.mock('../../../../src/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

type PrivateService = {
  findResolvedIssues: (
    tasks: RemediationTask[],
    newIssues: Array<{ code: string; location?: string }>
  ) => string[];
};

describe('remediationService.findResolvedIssues — stillPending semantics', () => {
  const svc = remediationService as unknown as PrivateService;

  it('returns issue codes whose code:location key is absent from the new audit', () => {
    const tasks: RemediationTask[] = [
      { id: 't1', issueCode: 'EPUB-META-001', location: 'chapter1.xhtml', status: 'pending', severity: 'serious', description: '', filePath: '' },
      { id: 't2', issueCode: 'EPUB-META-002', location: 'chapter2.xhtml', status: 'pending', severity: 'moderate', description: '', filePath: '' },
    ];
    const newIssues = [{ code: 'EPUB-META-002', location: 'chapter2.xhtml' }];

    const resolved = svc.findResolvedIssues(tasks, newIssues);
    expect(resolved).toContain('EPUB-META-001');
    expect(resolved).not.toContain('EPUB-META-002');
  });

  it('counts an already-completed task as resolved when its issue is absent from new audit', () => {
    // Edge case: task.status === 'completed' but issue is still resolved
    // stillPending = originalIssues - resolvedIssueCodes.length should include this
    const tasks: RemediationTask[] = [
      { id: 't1', issueCode: 'EPUB-META-001', location: 'chapter1.xhtml', status: 'completed', severity: 'serious', description: '', filePath: '' },
      { id: 't2', issueCode: 'EPUB-META-002', location: 'chapter2.xhtml', status: 'pending', severity: 'moderate', description: '', filePath: '' },
    ];
    // Both issues gone from new audit
    const newIssues: Array<{ code: string; location?: string }> = [];

    const resolved = svc.findResolvedIssues(tasks, newIssues);
    // Both are resolved regardless of original task status
    expect(resolved).toContain('EPUB-META-001');
    expect(resolved).toContain('EPUB-META-002');

    // stillPending = originalIssues(2) - resolvedCount(2) = 0
    const stillPending = tasks.length - resolved.length;
    expect(stillPending).toBe(0);
  });

  it('does not count a task as resolved when its issue still appears in the new audit', () => {
    const tasks: RemediationTask[] = [
      { id: 't1', issueCode: 'EPUB-META-001', location: 'chapter1.xhtml', status: 'pending', severity: 'serious', description: '', filePath: '' },
    ];
    const newIssues = [{ code: 'EPUB-META-001', location: 'chapter1.xhtml' }];

    const resolved = svc.findResolvedIssues(tasks, newIssues);
    expect(resolved).toHaveLength(0);

    // stillPending = 1 - 0 = 1
    const stillPending = tasks.length - resolved.length;
    expect(stillPending).toBe(1);
  });
});
