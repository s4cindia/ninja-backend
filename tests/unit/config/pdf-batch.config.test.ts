/**
 * pdfBatchConfig -- weight tiers and budget defaults for the PDF batch
 * concurrency budget. Every numeric value is env-var-overridable via a
 * fail-fast positiveIntEnv parse (CodeRabbit finding on PR #635): a
 * malformed override (e.g. PDF_BATCH_WEIGHT_LARGE=abc) must throw at
 * startup rather than silently becoming parseInt's NaN, which would
 * corrupt the concurrency-budget service's Prisma `lte`/`increment`
 * arguments, or turn admitPollMs into an ~1ms retry loop.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ENV_VARS = [
  'PDF_BATCH_BUDGET_TOTAL_UNITS',
  'PDF_BATCH_SIZE_TIER_SMALL_MAX_MB',
  'PDF_BATCH_SIZE_TIER_MEDIUM_MAX_MB',
  'PDF_BATCH_PAGE_TIER_SMALL_MAX',
  'PDF_BATCH_PAGE_TIER_MEDIUM_MAX',
  'PDF_BATCH_WEIGHT_SMALL',
  'PDF_BATCH_WEIGHT_MEDIUM',
  'PDF_BATCH_WEIGHT_LARGE',
  'PDF_BATCH_LEASE_STALE_MS',
  'PDF_BATCH_ADMIT_POLL_MS',
] as const;

const originalEnv: Record<string, string | undefined> = {};

async function loadConfig(): Promise<typeof import('../../../src/config/pdf-batch.config').pdfBatchConfig> {
  vi.resetModules();
  const mod = await import('../../../src/config/pdf-batch.config');
  return mod.pdfBatchConfig;
}

describe('pdfBatchConfig', () => {
  beforeEach(() => {
    for (const name of ENV_VARS) {
      originalEnv[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of ENV_VARS) {
      if (originalEnv[name] === undefined) delete process.env[name];
      else process.env[name] = originalEnv[name];
    }
  });

  it('uses the documented defaults when no env vars are set', async () => {
    const pdfBatchConfig = await loadConfig();
    expect(pdfBatchConfig.defaultBudgetUnits).toBe(10);
    expect(pdfBatchConfig.weightUnits).toEqual({ small: 1, medium: 3, large: 8 });
    expect(pdfBatchConfig.sizeTiers).toEqual({ smallMaxMb: 50, mediumMaxMb: 500 });
    expect(pdfBatchConfig.pageTiers).toEqual({ smallMaxPages: 50, mediumMaxPages: 300 });
    expect(pdfBatchConfig.leaseStaleMs).toBe(20 * 60 * 1000);
    expect(pdfBatchConfig.admitPollMs).toBe(5000);
  });

  it('respects a valid override', async () => {
    process.env.PDF_BATCH_WEIGHT_LARGE = '12';
    const pdfBatchConfig = await loadConfig();
    expect(pdfBatchConfig.weightUnits.large).toBe(12);
  });

  it('throws at load time on a non-numeric override, rather than silently becoming NaN', async () => {
    process.env.PDF_BATCH_WEIGHT_LARGE = 'abc';
    await expect(loadConfig()).rejects.toThrow(/Invalid PDF_BATCH_WEIGHT_LARGE/);
  });

  it('throws on a zero override -- no setting here has a deliberate zero exception', async () => {
    process.env.PDF_BATCH_ADMIT_POLL_MS = '0';
    await expect(loadConfig()).rejects.toThrow(/Invalid PDF_BATCH_ADMIT_POLL_MS/);
  });

  it('throws on a negative override', async () => {
    process.env.PDF_BATCH_BUDGET_TOTAL_UNITS = '-5';
    await expect(loadConfig()).rejects.toThrow(/Invalid PDF_BATCH_BUDGET_TOTAL_UNITS/);
  });

  it('treats an empty-string override as unset (falls back to the default)', async () => {
    process.env.PDF_BATCH_WEIGHT_LARGE = '';
    const pdfBatchConfig = await loadConfig();
    expect(pdfBatchConfig.weightUnits.large).toBe(8);
  });
});
