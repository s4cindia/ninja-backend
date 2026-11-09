/**
 * Compliance "ACR required" tenant-level toggle.
 *
 * Scope: this ONLY controls what the frontend's own progress stepper
 * (pdfPhaseStepper.ts's derivePhases, for the single-job PDF Audit Results
 * page) counts as "Compliance: done" -- whether a job needs both a
 * generated PAC Report AND a generated ACR, or the PAC Report alone. It is
 * read by pac-report.controller.ts/tenant-config.controller.ts and the
 * frontend only.
 *
 * It is DELIBERATELY never read anywhere under src/services/workflow/ --
 * the separate Workflow Agent orchestration layer's own Gate 4
 * (AWAITING_ACR_SIGNOFF, see hitl-orchestrator.service.ts) enforces ACR
 * sign-off as a hard, non-skippable legal attestation gate for any job
 * routed through that pipeline, entirely independent of this flag and of
 * Tenant.settings.compliance. Do not wire this setting into the Workflow
 * Agent -- if a future change needs to make Gate 4 itself configurable,
 * that is a separate, deliberate decision belonging to
 * workflow-config.service.ts, not this one.
 *
 * Modeled directly on axes4-tenant-config.service.ts's own Tenant.settings
 * JSON-bucket pattern (same server-stamped audit trail, same
 * only-re-stamp-on-actual-flip rule). Defaults to `acrRequired: true` so
 * existing tenants see no behavior change until an admin deliberately
 * opts out.
 */

import prisma from '../../lib/prisma';
import { Prisma } from '@prisma/client';
import { logger } from '../../lib/logger';

export interface ComplianceTenantConfig {
  /** True (default) when Compliance requires both a PAC Report and a generated ACR. False lets a PAC Report alone count as done. */
  acrRequired: boolean;
  /** UserId of the admin who last flipped the flag. Null when never flipped. */
  acrRequiredChangedBy: string | null;
  /** ISO timestamp of the last flag change. Null when never flipped. */
  acrRequiredChangedAt: string | null;
}

export const DEFAULT_COMPLIANCE_TENANT_CONFIG: ComplianceTenantConfig = {
  acrRequired: true,
  acrRequiredChangedBy: null,
  acrRequiredChangedAt: null,
};

/**
 * Read the compliance-specific tenant config, merged with
 * `DEFAULT_COMPLIANCE_TENANT_CONFIG`. Returns the default (ACR required,
 * no audit trail) when the tenant has never touched the setting.
 */
export async function getComplianceTenantConfig(tenantId: string): Promise<ComplianceTenantConfig> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });
  if (!tenant) return DEFAULT_COMPLIANCE_TENANT_CONFIG;

  const settings = (tenant.settings && typeof tenant.settings === 'object')
    ? (tenant.settings as Record<string, unknown>)
    : {};
  const stored = (settings.compliance && typeof settings.compliance === 'object')
    ? (settings.compliance as Record<string, unknown>)
    : {};

  return {
    acrRequired: typeof stored.acrRequired === 'boolean' ? stored.acrRequired : DEFAULT_COMPLIANCE_TENANT_CONFIG.acrRequired,
    acrRequiredChangedBy: typeof stored.acrRequiredChangedBy === 'string' ? stored.acrRequiredChangedBy : DEFAULT_COMPLIANCE_TENANT_CONFIG.acrRequiredChangedBy,
    acrRequiredChangedAt: typeof stored.acrRequiredChangedAt === 'string' ? stored.acrRequiredChangedAt : DEFAULT_COMPLIANCE_TENANT_CONFIG.acrRequiredChangedAt,
  };
}

/**
 * Update the compliance tenant config. Only `acrRequired` is
 * operator-settable; `acrRequiredChangedBy`/`acrRequiredChangedAt` are
 * stamped server-side from the calling user's id and the current time, and
 * only when the flag value actually changes -- a no-op PATCH (admin
 * re-confirms the existing state) shouldn't overwrite who genuinely made
 * the policy decision.
 */
export async function updateComplianceTenantConfig(
  tenantId: string,
  patch: { acrRequired: boolean },
  userId: string,
): Promise<ComplianceTenantConfig> {
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
  const currentCompliance = (currentSettings.compliance && typeof currentSettings.compliance === 'object')
    ? (currentSettings.compliance as Record<string, unknown>)
    : {};

  const flagChanged = currentCompliance.acrRequired !== patch.acrRequired;
  const updatedCompliance = {
    ...currentCompliance,
    acrRequired: patch.acrRequired,
    acrRequiredChangedBy: flagChanged ? userId : (currentCompliance.acrRequiredChangedBy ?? null),
    acrRequiredChangedAt: flagChanged ? new Date().toISOString() : (currentCompliance.acrRequiredChangedAt ?? null),
  };

  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      settings: {
        ...currentSettings,
        compliance: updatedCompliance,
      } as unknown as Prisma.InputJsonValue,
    },
  });

  logger.info(`[compliance tenant config] tenant=${tenantId} acrRequired=${patch.acrRequired} by=${userId}`);

  return getComplianceTenantConfig(tenantId);
}
