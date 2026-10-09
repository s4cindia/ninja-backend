import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    tenant: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

import prisma from '../../../../src/lib/prisma';
import {
  getAxes4TenantConfig,
  updateAxes4TenantConfig,
  isAxes4EnabledForTenant,
  DEFAULT_AXES4_TENANT_CONFIG,
} from '../../../../src/services/pdf/axes4-tenant-config.service';

const mTenantFindUnique = prisma.tenant.findUnique as ReturnType<typeof vi.fn>;
const mTenantUpdate = prisma.tenant.update as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mTenantFindUnique.mockReset();
  mTenantUpdate.mockReset();
});

describe('DEFAULT_AXES4_TENANT_CONFIG', () => {
  it('is disabled by default', () => {
    expect(DEFAULT_AXES4_TENANT_CONFIG.enabled).toBe(false);
    expect(DEFAULT_AXES4_TENANT_CONFIG.enabledBy).toBeNull();
    expect(DEFAULT_AXES4_TENANT_CONFIG.enabledAt).toBeNull();
  });
});

describe('getAxes4TenantConfig', () => {
  it('returns the default when tenant has no settings', async () => {
    mTenantFindUnique.mockResolvedValue({ settings: null });
    const cfg = await getAxes4TenantConfig('tenant-1');
    expect(cfg).toEqual(DEFAULT_AXES4_TENANT_CONFIG);
  });

  it('returns the default when tenant.settings has no `axes4` key', async () => {
    mTenantFindUnique.mockResolvedValue({ settings: { workflow: {} } });
    const cfg = await getAxes4TenantConfig('tenant-1');
    expect(cfg).toEqual(DEFAULT_AXES4_TENANT_CONFIG);
  });

  it('returns the default when tenant does not exist', async () => {
    mTenantFindUnique.mockResolvedValue(null);
    const cfg = await getAxes4TenantConfig('missing-tenant');
    expect(cfg).toEqual(DEFAULT_AXES4_TENANT_CONFIG);
  });

  it('returns stored values when an admin has flipped the flag', async () => {
    mTenantFindUnique.mockResolvedValue({
      settings: {
        axes4: {
          enabled: true,
          enabledBy: 'admin-user-id',
          enabledAt: '2026-10-10T12:00:00.000Z',
        },
      },
    });
    const cfg = await getAxes4TenantConfig('tenant-1');
    expect(cfg.enabled).toBe(true);
    expect(cfg.enabledBy).toBe('admin-user-id');
    expect(cfg.enabledAt).toBe('2026-10-10T12:00:00.000Z');
  });

  it('coerces wrong types to defaults (defensive against malformed settings JSON)', async () => {
    mTenantFindUnique.mockResolvedValue({
      settings: {
        axes4: {
          enabled: 'yes', // string, not boolean
          enabledBy: 42, // number, not string
        },
      },
    });
    const cfg = await getAxes4TenantConfig('tenant-1');
    expect(cfg.enabled).toBe(false);
    expect(cfg.enabledBy).toBeNull();
  });
});

describe('updateAxes4TenantConfig', () => {
  it('stamps enabledBy from caller userId, not from patch', async () => {
    mTenantFindUnique
      .mockResolvedValueOnce({ settings: {} })
      .mockResolvedValueOnce({
        settings: {
          axes4: {
            enabled: true,
            enabledBy: 'admin-1',
            enabledAt: '2026-10-10T12:00:00.000Z',
          },
        },
      });
    mTenantUpdate.mockResolvedValue({});

    const cfg = await updateAxes4TenantConfig('tenant-1', { enabled: true }, 'admin-1');
    expect(cfg.enabled).toBe(true);
    expect(cfg.enabledBy).toBe('admin-1');

    expect(mTenantUpdate).toHaveBeenCalledTimes(1);
    const updateCall = mTenantUpdate.mock.calls[0][0];
    const writtenAxes4 = (updateCall.data.settings as Record<string, Record<string, unknown>>).axes4;
    expect(writtenAxes4.enabledBy).toBe('admin-1');
    expect(typeof writtenAxes4.enabledAt).toBe('string');
  });

  it('preserves other tenant settings (workflow, reports, etc.) when writing axes4 config', async () => {
    mTenantFindUnique
      .mockResolvedValueOnce({
        settings: {
          workflow: { enabled: true },
          reports: { explanationSource: 'gemini' },
          axes4: { enabled: false },
        },
      })
      .mockResolvedValueOnce({
        settings: {
          workflow: { enabled: true },
          reports: { explanationSource: 'gemini' },
          axes4: { enabled: true, enabledBy: 'admin-1', enabledAt: '2026-10-10T12:00:00.000Z' },
        },
      });
    mTenantUpdate.mockResolvedValue({});

    await updateAxes4TenantConfig('tenant-1', { enabled: true }, 'admin-1');

    const updateCall = mTenantUpdate.mock.calls[0][0];
    const writtenSettings = updateCall.data.settings as Record<string, Record<string, unknown>>;
    expect(writtenSettings.workflow).toEqual({ enabled: true });
    expect(writtenSettings.reports).toEqual({ explanationSource: 'gemini' });
  });

  it('throws when tenant does not exist', async () => {
    mTenantFindUnique.mockResolvedValue(null);
    await expect(
      updateAxes4TenantConfig('missing-tenant', { enabled: true }, 'admin-1'),
    ).rejects.toThrow(/not found/i);
    expect(mTenantUpdate).not.toHaveBeenCalled();
  });

  it('preserves existing enabledBy on a no-op PATCH (audit-trail integrity)', async () => {
    const originalState = {
      enabled: true,
      enabledBy: 'admin-1',
      enabledAt: '2026-10-01T00:00:00.000Z',
    };
    mTenantFindUnique
      .mockResolvedValueOnce({ settings: { axes4: originalState } })
      .mockResolvedValueOnce({ settings: { axes4: originalState } });
    mTenantUpdate.mockResolvedValue({});

    await updateAxes4TenantConfig('tenant-1', { enabled: true }, 'admin-2');

    const updateCall = mTenantUpdate.mock.calls[0][0];
    const writtenAxes4 = (updateCall.data.settings as Record<string, Record<string, unknown>>).axes4;
    expect(writtenAxes4.enabledBy).toBe('admin-1');
    expect(writtenAxes4.enabledAt).toBe('2026-10-01T00:00:00.000Z');
  });

  it('re-stamps audit fields when the flag value actually flips', async () => {
    const originalState = {
      enabled: true,
      enabledBy: 'admin-1',
      enabledAt: '2026-10-01T00:00:00.000Z',
    };
    mTenantFindUnique
      .mockResolvedValueOnce({ settings: { axes4: originalState } })
      .mockResolvedValueOnce({ settings: { axes4: { ...originalState, enabled: false } } });
    mTenantUpdate.mockResolvedValue({});

    await updateAxes4TenantConfig('tenant-1', { enabled: false }, 'admin-2');

    const updateCall = mTenantUpdate.mock.calls[0][0];
    const writtenAxes4 = (updateCall.data.settings as Record<string, Record<string, unknown>>).axes4;
    expect(writtenAxes4.enabledBy).toBe('admin-2');
    expect(writtenAxes4.enabledAt).not.toBe(originalState.enabledAt);
  });
});

describe('isAxes4EnabledForTenant', () => {
  it('returns false by default (disabled-by-default per the cost-viability finding)', async () => {
    mTenantFindUnique.mockResolvedValue({ settings: {} });
    expect(await isAxes4EnabledForTenant('tenant-1')).toBe(false);
  });

  it('returns true once an admin has enabled it', async () => {
    mTenantFindUnique.mockResolvedValue({
      settings: { axes4: { enabled: true, enabledBy: 'admin-1', enabledAt: '2026-10-10T00:00:00.000Z' } },
    });
    expect(await isAxes4EnabledForTenant('tenant-1')).toBe(true);
  });
});
