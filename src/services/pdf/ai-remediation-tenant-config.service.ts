/**
 * AI remediation tenant-wide config -- the `settings.aiRemediation` bucket
 * in `Tenant.settings` JSON (tableFixMode, altTextMode, colorContrastMode,
 * etc., plus fullAutoModeDefault). Read/write validation and the
 * admin-gated PATCH endpoint live in tenant-config.controller.ts; this file
 * holds only the DEFAULT config + the effective-config read, extracted out
 * so accessibility.processor.ts's Full Auto Mode trigger can read the exact
 * same resolution the GET endpoint reports, without a worker/processor
 * importing a controller module (no other file under src/workers does this
 * today -- deliberately keeping that separation).
 */

import prisma from '../../lib/prisma';

export const DEFAULT_AI_REMEDIATION_CONFIG = {
  tableFixMode: 'summaries-to-pdf-headers-as-guidance' as const,
  altTextMode: 'apply-to-pdf' as const,
  listMode: 'auto-resolve-decorative' as const,
  languageMode: 'apply-to-pdf' as const,
  colorContrastMode: 'guidance-only' as const,
  linkTextMode: 'guidance-only' as const,
  formFieldMode: 'guidance-only' as const,
  bookmarkMode: 'guidance-only' as const,
  confidenceThreshold: 0.75,
  autoApplyHighConfidence: false,
  // Tenant-wide default for "Full Auto Mode" -- when true, a newly uploaded
  // job (with no Job.fullAutoMode override) auto-starts the existing Auto
  // Mode loop itself once its initial audit + AI analysis complete, instead
  // of waiting for an operator to click "Start Auto Remediation". See
  // resolveFullAutoMode in auto-remediation-loop.service.ts.
  fullAutoModeDefault: false,
};

/**
 * Effective AI-remediation config for a tenant: stored `settings.aiRemediation`
 * merged with `DEFAULT_AI_REMEDIATION_CONFIG`. Returns the defaults when the
 * tenant has never touched this bucket, or doesn't exist.
 */
export async function getEffectiveAiRemediationConfig(tenantId: string): Promise<typeof DEFAULT_AI_REMEDIATION_CONFIG> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });

  const settings = (tenant?.settings && typeof tenant.settings === 'object')
    ? (tenant.settings as Record<string, unknown>)
    : {};
  const stored = (settings.aiRemediation && typeof settings.aiRemediation === 'object')
    ? (settings.aiRemediation as Record<string, unknown>)
    : {};

  return {
    ...DEFAULT_AI_REMEDIATION_CONFIG,
    ...stored,
  };
}
