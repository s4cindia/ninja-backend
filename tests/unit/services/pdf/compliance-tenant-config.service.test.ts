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
  getComplianceTenantConfig,
  updateComplianceTenantConfig,
  DEFAULT_COMPLIANCE_TENANT_CONFIG,
} from '../../../../src/services/pdf/compliance-tenant-config.service';

const mTenantFindUnique = prisma.tenant.findUnique as ReturnType<typeof vi.fn>;
const mTenantUpdate = prisma.tenant.update as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mTenantFindUnique.mockReset();
  mTenantUpdate.mockReset();
});

describe('DEFAULT_COMPLIANCE_TENANT_CONFIG', () => {
  it('requires ACR by default (no behavior change for existing tenants)', () => {
    expect(DEFAULT_COMPLIANCE_TENANT_CONFIG.acrRequired).toBe(true);
    expect(DEFAULT_COMPLIANCE_TENANT_CONFIG.acrRequiredChangedBy).toBeNull();
    expect(DEFAULT_COMPLIANCE_TENANT_CONFIG.acrRequiredChangedAt).toBeNull();
  });
});

describe('getComplianceTenantConfig', () => {
  it('returns the default when tenant has no settings', async () => {
    mTenantFindUnique.mockResolvedValue({ settings: null });
    const cfg = await getComplianceTenantConfig('tenant-1');
    expect(cfg).toEqual(DEFAULT_COMPLIANCE_TENANT_CONFIG);
  });

  it('returns the default when tenant.settings has no `compliance` key', async () => {
    mTenantFindUnique.mockResolvedValue({ settings: { workflow: {} } });
    const cfg = await getComplianceTenantConfig('tenant-1');
    expect(cfg).toEqual(DEFAULT_COMPLIANCE_TENANT_CONFIG);
  });

  it('returns the default when tenant does not exist', async () => {
    mTenantFindUnique.mockResolvedValue(null);
    const cfg = await getComplianceTenantConfig('missing-tenant');
    expect(cfg).toEqual(DEFAULT_COMPLIANCE_TENANT_CONFIG);
  });

  it('returns stored values when an admin has opted out of requiring ACR', async () => {
    mTenantFindUnique.mockResolvedValue({
      settings: {
        compliance: {
          acrRequired: false,
          acrRequiredChangedBy: 'admin-user-id',
          acrRequiredChangedAt: '2026-11-10T12:00:00.000Z',
        },
      },
    });
    const cfg = await getComplianceTenantConfig('tenant-1');
    expect(cfg.acrRequired).toBe(false);
    expect(cfg.acrRequiredChangedBy).toBe('admin-user-id');
    expect(cfg.acrRequiredChangedAt).toBe('2026-11-10T12:00:00.000Z');
  });

  it('coerces wrong types to defaults (defensive against malformed settings JSON)', async () => {
    mTenantFindUnique.mockResolvedValue({
      settings: {
        compliance: {
          acrRequired: 'no', // string, not boolean
          acrRequiredChangedBy: 42, // number, not string
        },
      },
    });
    const cfg = await getComplianceTenantConfig('tenant-1');
    expect(cfg.acrRequired).toBe(true);
    expect(cfg.acrRequiredChangedBy).toBeNull();
  });
});

describe('updateComplianceTenantConfig', () => {
  it('stamps acrRequiredChangedBy from caller userId, not from patch', async () => {
    mTenantFindUnique
      .mockResolvedValueOnce({ settings: {} })
      .mockResolvedValueOnce({
        settings: {
          compliance: {
            acrRequired: false,
            acrRequiredChangedBy: 'admin-1',
            acrRequiredChangedAt: '2026-11-10T12:00:00.000Z',
          },
        },
      });
    mTenantUpdate.mockResolvedValue({});

    const cfg = await updateComplianceTenantConfig('tenant-1', { acrRequired: false }, 'admin-1');
    expect(cfg.acrRequired).toBe(false);
    expect(cfg.acrRequiredChangedBy).toBe('admin-1');

    expect(mTenantUpdate).toHaveBeenCalledTimes(1);
    const updateCall = mTenantUpdate.mock.calls[0][0];
    const writtenCompliance = (updateCall.data.settings as Record<string, Record<string, unknown>>).compliance;
    expect(writtenCompliance.acrRequiredChangedBy).toBe('admin-1');
    expect(typeof writtenCompliance.acrRequiredChangedAt).toBe('string');
  });

  it('preserves other tenant settings (workflow, reports, axes4, etc.) when writing compliance config', async () => {
    mTenantFindUnique
      .mockResolvedValueOnce({
        settings: {
          workflow: { enabled: true },
          reports: { explanationSource: 'gemini' },
          axes4: { enabled: false },
          compliance: { acrRequired: true },
        },
      })
      .mockResolvedValueOnce({
        settings: {
          workflow: { enabled: true },
          reports: { explanationSource: 'gemini' },
          axes4: { enabled: false },
          compliance: { acrRequired: false, acrRequiredChangedBy: 'admin-1', acrRequiredChangedAt: '2026-11-10T12:00:00.000Z' },
        },
      });
    mTenantUpdate.mockResolvedValue({});

    await updateComplianceTenantConfig('tenant-1', { acrRequired: false }, 'admin-1');

    const updateCall = mTenantUpdate.mock.calls[0][0];
    const writtenSettings = updateCall.data.settings as Record<string, Record<string, unknown>>;
    expect(writtenSettings.workflow).toEqual({ enabled: true });
    expect(writtenSettings.reports).toEqual({ explanationSource: 'gemini' });
    expect(writtenSettings.axes4).toEqual({ enabled: false });
  });

  it('throws when tenant does not exist', async () => {
    mTenantFindUnique.mockResolvedValue(null);
    await expect(
      updateComplianceTenantConfig('missing-tenant', { acrRequired: false }, 'admin-1'),
    ).rejects.toThrow(/not found/i);
    expect(mTenantUpdate).not.toHaveBeenCalled();
  });

  it('preserves existing acrRequiredChangedBy on a no-op PATCH (audit-trail integrity)', async () => {
    const originalState = {
      acrRequired: false,
      acrRequiredChangedBy: 'admin-1',
      acrRequiredChangedAt: '2026-11-01T00:00:00.000Z',
    };
    mTenantFindUnique
      .mockResolvedValueOnce({ settings: { compliance: originalState } })
      .mockResolvedValueOnce({ settings: { compliance: originalState } });
    mTenantUpdate.mockResolvedValue({});

    await updateComplianceTenantConfig('tenant-1', { acrRequired: false }, 'admin-2');

    const updateCall = mTenantUpdate.mock.calls[0][0];
    const writtenCompliance = (updateCall.data.settings as Record<string, Record<string, unknown>>).compliance;
    expect(writtenCompliance.acrRequiredChangedBy).toBe('admin-1');
    expect(writtenCompliance.acrRequiredChangedAt).toBe('2026-11-01T00:00:00.000Z');
  });

  it('re-stamps audit fields when the flag value actually flips', async () => {
    const originalState = {
      acrRequired: true,
      acrRequiredChangedBy: 'admin-1',
      acrRequiredChangedAt: '2026-11-01T00:00:00.000Z',
    };
    mTenantFindUnique
      .mockResolvedValueOnce({ settings: { compliance: originalState } })
      .mockResolvedValueOnce({ settings: { compliance: { ...originalState, acrRequired: false } } });
    mTenantUpdate.mockResolvedValue({});

    await updateComplianceTenantConfig('tenant-1', { acrRequired: false }, 'admin-2');

    const updateCall = mTenantUpdate.mock.calls[0][0];
    const writtenCompliance = (updateCall.data.settings as Record<string, Record<string, unknown>>).compliance;
    expect(writtenCompliance.acrRequiredChangedBy).toBe('admin-2');
    expect(writtenCompliance.acrRequiredChangedAt).not.toBe(originalState.acrRequiredChangedAt);
  });
});
