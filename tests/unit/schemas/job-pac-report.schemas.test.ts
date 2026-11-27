import { describe, it, expect } from 'vitest';
import { jobPacReportConfirmSchema } from '../../../src/schemas/job-pac-report.schemas';

const body = jobPacReportConfirmSchema.body;
const base = { originalFileName: 'pac.pdf', mimeType: 'application/pdf' };

describe('jobPacReportConfirmSchema', () => {
  it('accepts a UUID uploadId, and (transitionally) none at all', () => {
    expect(body.safeParse({ ...base, uploadId: '6f1c2b0e-3d4a-4b5c-8d9e-0f1a2b3c4d5e' }).success).toBe(true);
    expect(body.safeParse(base).success).toBe(true);
  });

  it('rejects an uploadId that is not a UUID (it becomes part of an S3 key)', () => {
    expect(body.safeParse({ ...base, uploadId: '../../other-job' }).success).toBe(false);
  });
});
