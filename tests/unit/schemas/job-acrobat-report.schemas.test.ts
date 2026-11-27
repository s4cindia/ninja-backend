import { describe, it, expect } from 'vitest';
import {
  jobAcrobatReportUploadUrlSchema,
  jobAcrobatReportConfirmSchema,
} from '../../../src/schemas/job-acrobat-report.schemas';

describe('job Acrobat report schemas', () => {
  it('accepts .html / .htm file names only', () => {
    const body = jobAcrobatReportUploadUrlSchema.body;
    expect(body.safeParse({ filename: 'report.html' }).success).toBe(true);
    expect(body.safeParse({ filename: 'REPORT.HTM' }).success).toBe(true);
    expect(body.safeParse({ filename: 'report.pdf' }).success).toBe(false);
    expect(body.safeParse({ filename: '' }).success).toBe(false);
  });

  it('confirm: operatorCounts is optional, but complete and non-negative when given', () => {
    const body = jobAcrobatReportConfirmSchema.body;
    expect(body.safeParse({ originalFileName: 'r.html' }).success).toBe(true);
    expect(
      body.safeParse({
        originalFileName: 'r.html',
        operatorCounts: { passed: 30, failed: 0, needsManualCheck: 2, skipped: 0 },
      }).success,
    ).toBe(true);
    expect(
      body.safeParse({ originalFileName: 'r.html', operatorCounts: { passed: 30, failed: 0 } }).success,
    ).toBe(false);
    expect(
      body.safeParse({
        originalFileName: 'r.html',
        operatorCounts: { passed: 30, failed: -1, needsManualCheck: 2, skipped: 0 },
      }).success,
    ).toBe(false);
  });
});
