/**
 * PRH UK tenant-config + AI-altext gate (P4/PR2).
 *
 * Per PRH Style Guide Appendix 7, "Use of AI-based tools and solutions
 * is prohibited unless specifically vetted and approved by PRH UK".
 * Ninja's photo-alt-generator and long-description-generator are
 * Gemini-based, so they fall under that prohibition for PRH UK
 * deliveries by default. This service implements the policy gate:
 *
 *   - `getPrhConfig(tenantId)` — reads `Tenant.settings.prh.*`,
 *     merged with `DEFAULT_PRH_CONFIG` (disabled by default).
 *   - `updatePrhConfig(tenantId, patch, userId)` — writes the flag
 *     and stamps `aiAltTextEnabledBy` + `aiAltTextEnabledAt` for the
 *     audit trail.
 *   - `isJobPrhUk(jobId)` — looks at the persisted audit result
 *     (`Job.output.publisherProfile`) and returns true when the
 *     publisher resolved to PRH-UK at medium-or-high confidence.
 *   - `assertAiAltTextAllowed(jobId, tenantId)` — throws
 *     `PrhAiDisabledError` when the job is PRH-UK AND the tenant
 *     hasn't enabled AI alt text. Throws nothing on non-PRH jobs
 *     OR when the tenant has flipped the flag.
 *
 * Disabled-by-default is the safe policy posture — tenants who have
 * completed PRH vetting flip the flag in admin settings.
 */

import prisma from '../../lib/prisma';
import { Prisma } from '@prisma/client';
import { logger } from '../../lib/logger';

export interface PrhConfig {
  /** True when AI alt-text generation is allowed on this tenant's PRH-UK jobs. */
  aiAltTextEnabled: boolean;
  /** UserId of the admin who last flipped the flag. Null when never flipped. */
  aiAltTextEnabledBy: string | null;
  /** ISO timestamp of the last flag change. Null when never flipped. */
  aiAltTextEnabledAt: string | null;
}

export const DEFAULT_PRH_CONFIG: PrhConfig = {
  aiAltTextEnabled: false,
  aiAltTextEnabledBy: null,
  aiAltTextEnabledAt: null,
};

/**
 * Thrown when an AI alt-text generation attempt is blocked by the
 * PRH gate. Carries a structured error payload the FE renders as a
 * persistent banner (NOT a transient toast) so operators can act on
 * the vetting requirement.
 */
export class PrhAiDisabledError extends Error {
  static readonly CODE = 'PRH_AI_DISABLED';
  constructor(message: string = 'PRH UK requires AI alt text to be vetted and approved per Style Guide Appendix 7. Contact your PRH production controller before enabling AI alt-text generation.') {
    super(message);
    this.name = 'PrhAiDisabledError';
  }
}

/**
 * Read the PRH-specific tenant config, merged with `DEFAULT_PRH_CONFIG`.
 * Returns the default (all-false) when the tenant has never touched
 * the settings — explicit disabled-by-default per Style Guide
 * Appendix 7.
 */
export async function getPrhConfig(tenantId: string): Promise<PrhConfig> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });
  if (!tenant) return DEFAULT_PRH_CONFIG;

  const settings = (tenant.settings && typeof tenant.settings === 'object')
    ? (tenant.settings as Record<string, unknown>)
    : {};
  const stored = (settings.prh && typeof settings.prh === 'object')
    ? (settings.prh as Record<string, unknown>)
    : {};

  return {
    aiAltTextEnabled: typeof stored.aiAltTextEnabled === 'boolean' ? stored.aiAltTextEnabled : DEFAULT_PRH_CONFIG.aiAltTextEnabled,
    aiAltTextEnabledBy: typeof stored.aiAltTextEnabledBy === 'string' ? stored.aiAltTextEnabledBy : DEFAULT_PRH_CONFIG.aiAltTextEnabledBy,
    aiAltTextEnabledAt: typeof stored.aiAltTextEnabledAt === 'string' ? stored.aiAltTextEnabledAt : DEFAULT_PRH_CONFIG.aiAltTextEnabledAt,
  };
}

/**
 * Update the PRH tenant config. Currently only `aiAltTextEnabled` is
 * operator-settable; `aiAltTextEnabledBy` + `aiAltTextEnabledAt` are
 * stamped server-side from the calling user's id and the current
 * time. This preserves the audit trail — operators can't backdate
 * the flag flip or pin it to a different userId.
 */
export async function updatePrhConfig(
  tenantId: string,
  patch: { aiAltTextEnabled: boolean },
  userId: string,
): Promise<PrhConfig> {
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
  const currentPrh = (currentSettings.prh && typeof currentSettings.prh === 'object')
    ? (currentSettings.prh as Record<string, unknown>)
    : {};

  const updatedPrh = {
    ...currentPrh,
    aiAltTextEnabled: patch.aiAltTextEnabled,
    aiAltTextEnabledBy: userId,
    aiAltTextEnabledAt: new Date().toISOString(),
  };

  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      settings: {
        ...currentSettings,
        prh: updatedPrh,
      } as unknown as Prisma.InputJsonValue,
    },
  });

  logger.info(`[PRH config] tenant=${tenantId} aiAltTextEnabled=${patch.aiAltTextEnabled} by=${userId}`);

  return getPrhConfig(tenantId);
}

/**
 * Returns true when the job's persisted audit result identifies the
 * EPUB as a PRH-UK build at medium-or-high confidence. False on
 * everything else: non-PRH books, jobs without an audit result yet,
 * profile-detection failures, low-confidence matches.
 *
 * Reads `Job.output` JSON — the audit pipeline stores `EpubAuditResult`
 * there. We don't reach into the underlying `publisherProfile` field
 * directly to avoid Prisma type coupling.
 */
export async function isJobPrhUk(jobId: string): Promise<boolean> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { output: true },
  });
  if (!job || !job.output) return false;

  const output = job.output as Record<string, unknown>;
  const profile = (output.publisherProfile && typeof output.publisherProfile === 'object')
    ? (output.publisherProfile as Record<string, unknown>)
    : null;
  if (!profile) return false;

  return profile.publisher === 'PRH-UK' && profile.confidence !== 'low';
}

/**
 * Throws `PrhAiDisabledError` when AI alt-text generation is blocked
 * for this job. Returns silently when the request is allowed:
 *   - non-PRH job → allowed (gate doesn't apply)
 *   - PRH job + tenant.aiAltTextEnabled === true → allowed
 *   - PRH job + tenant.aiAltTextEnabled === false → BLOCKED
 *
 * Callers should catch `PrhAiDisabledError` and translate it to a
 * 403 response with the structured `PRH_AI_DISABLED` payload — the
 * FE renders that as a persistent banner explaining the Appendix 7
 * vetting requirement.
 */
export async function assertAiAltTextAllowed(jobId: string, tenantId: string): Promise<void> {
  const isPrh = await isJobPrhUk(jobId);
  if (!isPrh) return; // gate doesn't apply to non-PRH jobs

  const config = await getPrhConfig(tenantId);
  if (config.aiAltTextEnabled) return; // tenant has completed vetting

  throw new PrhAiDisabledError();
}
