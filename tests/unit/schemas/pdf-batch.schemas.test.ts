/**
 * pdfBatchStartSchema -- the optional per-batch Auto Mode override body for
 * POST /pdf-batches/:batchId/start. Bounds are deliberately identical to
 * the single-file job-native endpoint's own schema
 * (pdf-auto-mode.schemas.ts's startAutoModeSchema.body) -- this endpoint is
 * reachable by any authenticated tenant user on their own batch, the same
 * reasoning that schema's own doc comment gives for being tighter than the
 * admin-only trial config schema.
 */
import { describe, it, expect } from 'vitest';
import { pdfBatchStartSchema } from '../../../src/schemas/pdf-batch.schemas';

describe('pdfBatchStartSchema', () => {
  it('accepts an undefined body -- starting a batch with no overrides must keep working', () => {
    expect(() => pdfBatchStartSchema.parse(undefined)).not.toThrow();
    expect(pdfBatchStartSchema.parse(undefined)).toBeUndefined();
  });

  it('accepts an empty object -- every field is optional', () => {
    expect(pdfBatchStartSchema.parse({})).toEqual({});
  });

  it('accepts a fully populated, valid override body', () => {
    const body = { autoMaxRounds: 5, autoCostLimitUsd: 1.5, autoColorContrastMode: 'guidance-only' as const };
    expect(pdfBatchStartSchema.parse(body)).toEqual(body);
  });

  it('rejects autoMaxRounds below 1', () => {
    expect(() => pdfBatchStartSchema.parse({ autoMaxRounds: 0 })).toThrow();
  });

  it('rejects autoMaxRounds above 20', () => {
    expect(() => pdfBatchStartSchema.parse({ autoMaxRounds: 21 })).toThrow();
  });

  it('rejects a non-integer autoMaxRounds', () => {
    expect(() => pdfBatchStartSchema.parse({ autoMaxRounds: 2.5 })).toThrow();
  });

  it('rejects autoCostLimitUsd below 0.1', () => {
    expect(() => pdfBatchStartSchema.parse({ autoCostLimitUsd: 0.05 })).toThrow();
  });

  it('rejects autoCostLimitUsd above 10', () => {
    expect(() => pdfBatchStartSchema.parse({ autoCostLimitUsd: 10.01 })).toThrow();
  });

  it('rejects an autoColorContrastMode outside the fixed enum', () => {
    expect(() => pdfBatchStartSchema.parse({ autoColorContrastMode: 'always' })).toThrow();
  });

  it('rejects an unknown key -- .strict() catches typos instead of silently ignoring them', () => {
    expect(() => pdfBatchStartSchema.parse({ autoMaxRound: 5 })).toThrow();
  });
});
