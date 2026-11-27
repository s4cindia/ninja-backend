import { describe, it, expect } from 'vitest';
import { certifyJobSchema } from '../../../src/schemas/certification.schemas';

const body = certifyJobSchema.body;
const base = { acrobatAttested: true, pacPdfUaErrors: 0 };

describe('certifyJobSchema', () => {
  it('requires the Acrobat attestation to be literally true', () => {
    expect(body.safeParse(base).success).toBe(true);
    expect(body.safeParse({ ...base, acrobatAttested: false }).success).toBe(false);
    expect(body.safeParse({ pacPdfUaErrors: 0 }).success).toBe(false);
  });

  it('PAC waivers are per check: name, positive whole-number count, reason', () => {
    const ok = { check: 'List item content', count: 13, reason: 'Reviewed, reads correctly' };
    expect(body.safeParse({ ...base, pacWaivers: [ok] }).success).toBe(true);
    expect(body.safeParse({ ...base, pacWaivers: [{ ...ok, count: 0 }] }).success).toBe(false);
    expect(body.safeParse({ ...base, pacWaivers: [{ ...ok, count: 2.5 }] }).success).toBe(false);
    expect(body.safeParse({ ...base, pacWaivers: [{ ...ok, check: '  ' }] }).success).toBe(false);
    expect(body.safeParse({ ...base, pacWaivers: [{ ...ok, reason: 'no' }] }).success).toBe(false);
    // The old per-occurrence shape is rejected.
    expect(body.safeParse({ ...base, pacWaivers: [{ failure: 'x', reason: 'some reason' }] }).success).toBe(false);
  });

  it('defaults both waiver lists to empty', () => {
    const parsed = body.parse(base);
    expect(parsed.acrobatWaivers).toEqual([]);
    expect(parsed.pacWaivers).toEqual([]);
  });
});
