import { describe, it, expect } from 'vitest';
import { certifyJobSchema } from '../../../src/schemas/certification.schemas';

const body = certifyJobSchema.body;
const attestations = {
  allAcrobatChecksRun: true, altTextReviewedEveryFigure: true,
  readingOrderSpotChecked: true, bookmarksAndTitleChecked: true,
};
const base = { attestations, pacPdfUaErrors: 0 };

describe('certifyJobSchema', () => {
  it('requires all four attestations, each literally true', () => {
    expect(body.safeParse(base).success).toBe(true);
    for (const key of Object.keys(attestations)) {
      expect(body.safeParse({ ...base, attestations: { ...attestations, [key]: false } }).success).toBe(false);
      const missing = Object.fromEntries(Object.entries(attestations).filter(([k]) => k !== key));
      expect(body.safeParse({ ...base, attestations: missing }).success).toBe(false);
    }
    expect(body.safeParse({ pacPdfUaErrors: 0 }).success).toBe(false);
    // The old single flag is no longer accepted.
    expect(body.safeParse({ acrobatAttested: true, pacPdfUaErrors: 0 }).success).toBe(false);
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
