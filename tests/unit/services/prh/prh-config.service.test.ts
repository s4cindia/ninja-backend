import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    tenant: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    job: {
      findUnique: vi.fn(),
    },
  },
}));

import prisma from '../../../../src/lib/prisma';
import {
  getPrhConfig,
  updatePrhConfig,
  isJobPrhUk,
  assertAiAltTextAllowed,
  PrhAiDisabledError,
  DEFAULT_PRH_CONFIG,
} from '../../../../src/services/prh/prh-config.service';

const mTenantFindUnique = prisma.tenant.findUnique as ReturnType<typeof vi.fn>;
const mTenantUpdate = prisma.tenant.update as ReturnType<typeof vi.fn>;
const mJobFindUnique = prisma.job.findUnique as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mTenantFindUnique.mockReset();
  mTenantUpdate.mockReset();
  mJobFindUnique.mockReset();
});

describe('DEFAULT_PRH_CONFIG', () => {
  it('disables AI alt text by default (Style Guide Appendix 7)', () => {
    expect(DEFAULT_PRH_CONFIG.aiAltTextEnabled).toBe(false);
    expect(DEFAULT_PRH_CONFIG.aiAltTextEnabledBy).toBeNull();
    expect(DEFAULT_PRH_CONFIG.aiAltTextEnabledAt).toBeNull();
  });
});

describe('getPrhConfig', () => {
  it('returns DEFAULT_PRH_CONFIG when tenant has no settings', async () => {
    mTenantFindUnique.mockResolvedValue({ settings: null });
    const cfg = await getPrhConfig('tenant-1');
    expect(cfg).toEqual(DEFAULT_PRH_CONFIG);
  });

  it('returns DEFAULT_PRH_CONFIG when tenant.settings has no `prh` key', async () => {
    mTenantFindUnique.mockResolvedValue({ settings: { workflow: {} } });
    const cfg = await getPrhConfig('tenant-1');
    expect(cfg).toEqual(DEFAULT_PRH_CONFIG);
  });

  it('returns DEFAULT_PRH_CONFIG when tenant does not exist', async () => {
    mTenantFindUnique.mockResolvedValue(null);
    const cfg = await getPrhConfig('missing-tenant');
    expect(cfg).toEqual(DEFAULT_PRH_CONFIG);
  });

  it('returns stored values when tenant has flipped the flag', async () => {
    mTenantFindUnique.mockResolvedValue({
      settings: {
        prh: {
          aiAltTextEnabled: true,
          aiAltTextEnabledBy: 'admin-user-id',
          aiAltTextEnabledAt: '2026-05-13T12:00:00.000Z',
        },
      },
    });
    const cfg = await getPrhConfig('tenant-1');
    expect(cfg.aiAltTextEnabled).toBe(true);
    expect(cfg.aiAltTextEnabledBy).toBe('admin-user-id');
    expect(cfg.aiAltTextEnabledAt).toBe('2026-05-13T12:00:00.000Z');
  });

  it('coerces wrong types to defaults (defensive against malformed settings JSON)', async () => {
    mTenantFindUnique.mockResolvedValue({
      settings: {
        prh: {
          aiAltTextEnabled: 'yes', // string, not boolean
          aiAltTextEnabledBy: 42, // number, not string
        },
      },
    });
    const cfg = await getPrhConfig('tenant-1');
    expect(cfg.aiAltTextEnabled).toBe(false); // fell back to default
    expect(cfg.aiAltTextEnabledBy).toBeNull(); // fell back to default
  });
});

describe('updatePrhConfig', () => {
  it('stamps aiAltTextEnabledBy from caller userId, not from patch', async () => {
    mTenantFindUnique.mockResolvedValue({ settings: {} });
    mTenantUpdate.mockResolvedValue({});
    // After update, getPrhConfig is called again — mock the post-write state.
    mTenantFindUnique.mockResolvedValueOnce({ settings: {} }).mockResolvedValueOnce({
      settings: {
        prh: {
          aiAltTextEnabled: true,
          aiAltTextEnabledBy: 'admin-1',
          aiAltTextEnabledAt: '2026-05-13T12:00:00.000Z',
        },
      },
    });

    const cfg = await updatePrhConfig('tenant-1', { aiAltTextEnabled: true }, 'admin-1');
    expect(cfg.aiAltTextEnabled).toBe(true);
    expect(cfg.aiAltTextEnabledBy).toBe('admin-1');

    // Verify the update call carried the userId stamp.
    expect(mTenantUpdate).toHaveBeenCalledTimes(1);
    const updateCall = mTenantUpdate.mock.calls[0][0];
    const writtenPrh = (updateCall.data.settings as Record<string, Record<string, unknown>>).prh;
    expect(writtenPrh.aiAltTextEnabledBy).toBe('admin-1');
    expect(typeof writtenPrh.aiAltTextEnabledAt).toBe('string'); // ISO timestamp
  });

  it('preserves other tenant settings (workflow, reports, etc.) when writing prh config', async () => {
    mTenantFindUnique
      .mockResolvedValueOnce({
        settings: {
          workflow: { enabled: true },
          reports: { explanationSource: 'gemini' },
          prh: { aiAltTextEnabled: false },
        },
      })
      .mockResolvedValueOnce({
        settings: {
          workflow: { enabled: true },
          reports: { explanationSource: 'gemini' },
          prh: {
            aiAltTextEnabled: true,
            aiAltTextEnabledBy: 'admin-1',
            aiAltTextEnabledAt: '2026-05-13T12:00:00.000Z',
          },
        },
      });
    mTenantUpdate.mockResolvedValue({});

    await updatePrhConfig('tenant-1', { aiAltTextEnabled: true }, 'admin-1');

    const updateCall = mTenantUpdate.mock.calls[0][0];
    const writtenSettings = updateCall.data.settings as Record<string, Record<string, unknown>>;
    // Sibling keys must survive the merge — otherwise updating PRH
    // config would silently wipe workflow / reports config.
    expect(writtenSettings.workflow).toEqual({ enabled: true });
    expect(writtenSettings.reports).toEqual({ explanationSource: 'gemini' });
  });

  it('throws when tenant does not exist', async () => {
    mTenantFindUnique.mockResolvedValue(null);
    await expect(
      updatePrhConfig('missing-tenant', { aiAltTextEnabled: true }, 'admin-1'),
    ).rejects.toThrow(/not found/i);
    expect(mTenantUpdate).not.toHaveBeenCalled();
  });
});

describe('isJobPrhUk', () => {
  it('returns false when job does not exist', async () => {
    mJobFindUnique.mockResolvedValue(null);
    expect(await isJobPrhUk('missing-job')).toBe(false);
  });

  it('returns false when job has no output yet (audit not run)', async () => {
    mJobFindUnique.mockResolvedValue({ output: null });
    expect(await isJobPrhUk('job-1')).toBe(false);
  });

  it('returns false when output has no publisherProfile', async () => {
    mJobFindUnique.mockResolvedValue({ output: { score: 95 } });
    expect(await isJobPrhUk('job-1')).toBe(false);
  });

  it('returns false for non-PRH publishers', async () => {
    mJobFindUnique.mockResolvedValue({
      output: { publisherProfile: { publisher: 'HACHETTE-UK', confidence: 'high' } },
    });
    expect(await isJobPrhUk('job-1')).toBe(false);
  });

  it('returns false for PRH-UK at LOW confidence (per spec — low matches are unreliable)', async () => {
    mJobFindUnique.mockResolvedValue({
      output: { publisherProfile: { publisher: 'PRH-UK', confidence: 'low' } },
    });
    expect(await isJobPrhUk('job-1')).toBe(false);
  });

  it('returns true for PRH-UK at medium confidence', async () => {
    mJobFindUnique.mockResolvedValue({
      output: { publisherProfile: { publisher: 'PRH-UK', confidence: 'medium' } },
    });
    expect(await isJobPrhUk('job-1')).toBe(true);
  });

  it('returns true for PRH-UK at high confidence', async () => {
    mJobFindUnique.mockResolvedValue({
      output: { publisherProfile: { publisher: 'PRH-UK', confidence: 'high' } },
    });
    expect(await isJobPrhUk('job-1')).toBe(true);
  });
});

describe('assertAiAltTextAllowed', () => {
  it('allows non-PRH jobs regardless of tenant flag', async () => {
    mJobFindUnique.mockResolvedValue({
      output: { publisherProfile: { publisher: null, confidence: 'low' } },
    });
    // tenant flag would be off (no findUnique call expected because
    // isJobPrhUk short-circuits before checking config), but mock
    // for defensiveness.
    mTenantFindUnique.mockResolvedValue({ settings: {} });

    await expect(assertAiAltTextAllowed('job-1', 'tenant-1')).resolves.toBeUndefined();
  });

  it('allows PRH-UK jobs when tenant has enabled the flag', async () => {
    mJobFindUnique.mockResolvedValue({
      output: { publisherProfile: { publisher: 'PRH-UK', confidence: 'high' } },
    });
    mTenantFindUnique.mockResolvedValue({
      settings: { prh: { aiAltTextEnabled: true, aiAltTextEnabledBy: 'admin', aiAltTextEnabledAt: '2026-05-13T00:00:00.000Z' } },
    });

    await expect(assertAiAltTextAllowed('job-1', 'tenant-1')).resolves.toBeUndefined();
  });

  it('throws PrhAiDisabledError on PRH-UK jobs when tenant has NOT enabled the flag (default state)', async () => {
    mJobFindUnique.mockResolvedValue({
      output: { publisherProfile: { publisher: 'PRH-UK', confidence: 'high' } },
    });
    mTenantFindUnique.mockResolvedValue({ settings: {} }); // default = disabled

    await expect(assertAiAltTextAllowed('job-1', 'tenant-1')).rejects.toThrow(PrhAiDisabledError);
  });

  it('PrhAiDisabledError carries the CODE constant for FE banner detection', async () => {
    expect(PrhAiDisabledError.CODE).toBe('PRH_AI_DISABLED');
    const err = new PrhAiDisabledError();
    expect(err.name).toBe('PrhAiDisabledError');
    expect(err.message).toMatch(/Appendix 7/);
  });
});
