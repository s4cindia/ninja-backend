import { describe, it, expect } from 'vitest';
import { stripNulBytes } from '../../../src/lib/prisma';

describe('stripNulBytes', () => {
  it('real bug regression (2026-11-27): strips a literal NUL character out of a string -- Postgres rejects it outright (error 22P05), even though JSON.stringify never complains', () => {
    expect(stripNulBytes('BECOMING\u0000A\u0000MARKETING\u0000NEGOTIATOR')).toBe('BECOMINGAMARKETINGNEGOTIATOR');
  });

  it('leaves a string with no NUL byte completely untouched (same reference, not just equal)', () => {
    const s = 'Diagram illustrating a hand inserting an internal condom.';
    expect(stripNulBytes(s)).toBe(s);
  });

  it('recurses through nested plain objects and arrays, e.g. job.output-shaped data', () => {
    const input = {
      auditReport: {
        issues: [
          { message: 'Alt text:\u0000 fetus\u0000 diagram' },
          { message: 'clean message' },
        ],
      },
      postRemediationAudit: { resolved: 5, note: 'all\u0000clear' },
    };
    expect(stripNulBytes(input)).toEqual({
      auditReport: {
        issues: [
          { message: 'Alt text: fetus diagram' },
          { message: 'clean message' },
        ],
      },
      postRemediationAudit: { resolved: 5, note: 'allclear' },
    });
  });

  it('passes non-plain-object values through untouched (Date, null, number, boolean)', () => {
    const date = new Date('2026-11-27T00:00:00Z');
    expect(stripNulBytes(date)).toBe(date);
    expect(stripNulBytes(null)).toBeNull();
    expect(stripNulBytes(42)).toBe(42);
    expect(stripNulBytes(true)).toBe(true);
  });

  it('does not throw or hang on a deeply nested structure with mixed types', () => {
    const input = { a: [{ b: { c: ['x\u0000y', 1, null, { d: 'z\u0000' }] } }] };
    expect(stripNulBytes(input)).toEqual({ a: [{ b: { c: ['xy', 1, null, { d: 'z' }] } }] });
  });
});
