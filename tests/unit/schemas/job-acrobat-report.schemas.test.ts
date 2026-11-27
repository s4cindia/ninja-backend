import { describe, it, expect } from 'vitest';
import {
  jobAcrobatReportUploadUrlSchema,
  jobAcrobatReportConfirmSchema,
} from '../../../src/schemas/job-acrobat-report.schemas';

const UPLOAD_ID = '6f1c2a54-9d3e-4b7a-8c11-2e5f0a9b7c3d';

describe('job Acrobat report schemas', () => {
  it('accepts .html / .htm file names only', () => {
    const body = jobAcrobatReportUploadUrlSchema.body;
    expect(body.safeParse({ filename: 'report.html' }).success).toBe(true);
    expect(body.safeParse({ filename: 'REPORT.HTM' }).success).toBe(true);
    expect(body.safeParse({ filename: 'report.pdf' }).success).toBe(false);
    expect(body.safeParse({ filename: '' }).success).toBe(false);
  });

  it('confirm: requires the uploadId issued by upload-url, as a UUID (never a path)', () => {
    const body = jobAcrobatReportConfirmSchema.body;
    expect(body.safeParse({ uploadId: UPLOAD_ID, originalFileName: 'r.html' }).success).toBe(true);
    expect(body.safeParse({ originalFileName: 'r.html' }).success).toBe(false);
    expect(body.safeParse({ uploadId: '../other-job/x', originalFileName: 'r.html' }).success).toBe(false);
  });

  it('confirm: operatorCounts is optional, but complete and non-negative when given', () => {
    const body = jobAcrobatReportConfirmSchema.body;
    const base = { uploadId: UPLOAD_ID, originalFileName: 'r.html' };
    expect(
      body.safeParse({ ...base, operatorCounts: { passed: 30, failed: 0, needsManualCheck: 2, skipped: 0 } }).success,
    ).toBe(true);
    expect(body.safeParse({ ...base, operatorCounts: { passed: 30, failed: 0 } }).success).toBe(false);
    expect(
      body.safeParse({ ...base, operatorCounts: { passed: 30, failed: -1, needsManualCheck: 2, skipped: 0 } }).success,
    ).toBe(false);
  });
});
