/**
 * axes4 PAC Cloud tenant-level enable/disable gate.
 *
 * axes4Config.apiKey/subscriptionId (axes4-pac.service.ts's own
 * isAvailable()) answers "is this deployment even capable of calling
 * axes4 at all" -- an infra/env question. This answers a separate,
 * per-tenant policy question: "has an admin for THIS tenant turned the
 * feature on." A real call to axes4's paid API requires both to be true;
 * see pac-report.controller.ts's getLiveReport/getQuotaStatus for where
 * they're combined.
 *
 * Modeled directly on prh-config.service.ts's getPrhConfig/
 * updatePrhConfig shape (same Tenant.settings JSON-bucket pattern, same
 * server-stamped audit trail, same "only re-stamp on an actual flip"
 * rule) -- deliberately disabled-by-default, per this feature's own cost
 * analysis: axes4's paid per-page API isn't economically justified as a
 * routine check at Ninja's realistic volume, so nobody should get a
 * surprise bill until an admin deliberately opts their tenant in.
 */

import prisma from '../../lib/prisma';
import { Prisma } from '@prisma/client';
import { logger } from '../../lib/logger';

export interface Axes4TenantConfig {
  /** True when this tenant's admin has opted into axes4 live PAC checks. */
  enabled: boolean;
  /** UserId of the admin who last flipped the flag. Null when never flipped. */
  enabledBy: string | null;
  /** ISO timestamp of the last flag change. Null when never flipped. */
  enabledAt: string | null;
}

export const DEFAULT_AXES4_TENANT_CONFIG: Axes4TenantConfig = {
  enabled: false,
  enabledBy: null,
  enabledAt: null,
};

/**
 * Read the axes4-specific tenant config, merged with
 * `DEFAULT_AXES4_TENANT_CONFIG`. Returns the default (disabled, no audit
 * trail) when the tenant has never touched the setting.
 */
export async function getAxes4TenantConfig(tenantId: string): Promise<Axes4TenantConfig> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });
  if (!tenant) return DEFAULT_AXES4_TENANT_CONFIG;

  const settings = (tenant.settings && typeof tenant.settings === 'object')
    ? (tenant.settings as Record<string, unknown>)
    : {};
  const stored = (settings.axes4 && typeof settings.axes4 === 'object')
    ? (settings.axes4 as Record<string, unknown>)
    : {};

  return {
    enabled: typeof stored.enabled === 'boolean' ? stored.enabled : DEFAULT_AXES4_TENANT_CONFIG.enabled,
    enabledBy: typeof stored.enabledBy === 'string' ? stored.enabledBy : DEFAULT_AXES4_TENANT_CONFIG.enabledBy,
    enabledAt: typeof stored.enabledAt === 'string' ? stored.enabledAt : DEFAULT_AXES4_TENANT_CONFIG.enabledAt,
  };
}

/**
 * Update the axes4 tenant config. Only `enabled` is operator-settable;
 * `enabledBy`/`enabledAt` are stamped server-side from the calling user's
 * id and the current time, and only when the flag value actually
 * changes -- a no-op PATCH (admin re-confirms the existing state)
 * shouldn't overwrite who genuinely made the policy decision.
 */
export async function updateAxes4TenantConfig(
  tenantId: string,
  patch: { enabled: boolean },
  userId: string,
): Promise<Axes4TenantConfig> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });
  if (!tenant) {
    throw new Error(`Tenant ${tenantId} not found`);
  }

  const currentSettings = (tenant.settings && typeof tenant.settings === 'object')
    ? (tenant.settings as Record<string, unknown>)
    : {};
  const currentAxes4 = (currentSettings.axes4 && typeof currentSettings.axes4 === 'object')
    ? (currentSettings.axes4 as Record<string, unknown>)
    : {};

  const flagChanged = currentAxes4.enabled !== patch.enabled;
  const updatedAxes4 = {
    ...currentAxes4,
    enabled: patch.enabled,
    enabledBy: flagChanged ? userId : (currentAxes4.enabledBy ?? null),
    enabledAt: flagChanged ? new Date().toISOString() : (currentAxes4.enabledAt ?? null),
  };

  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      settings: {
        ...currentSettings,
        axes4: updatedAxes4,
      } as unknown as Prisma.InputJsonValue,
    },
  });

  logger.info(`[axes4 tenant config] tenant=${tenantId} enabled=${patch.enabled} by=${userId}`);

  return getAxes4TenantConfig(tenantId);
}

/** Convenience wrapper for call sites that only need the boolean. */
export async function isAxes4EnabledForTenant(tenantId: string): Promise<boolean> {
  const config = await getAxes4TenantConfig(tenantId);
  return config.enabled;
}
