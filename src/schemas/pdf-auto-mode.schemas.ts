/**
 * PDF Auto-Mode Validation Schemas
 *
 * Zod schema for the optional per-job override body on
 * POST /api/v1/pdf/:jobId/auto-mode/start. Only applies on the non-trial
 * (production, job-native) path -- a trial-linked job ignores this body
 * entirely and keeps using the trial's own pre-configured settings (see
 * pdf-auto-mode.controller.ts).
 *
 * Bounds are deliberately tighter than the admin-only trial config schema
 * (comparison-study.routes.ts's autoModeConfigBodySchema allows up to 100
 * rounds / $1000) -- this endpoint is reachable by any authenticated tenant
 * user on their own job, not just trusted admins running internal research
 * trials.
 */

import { z } from 'zod';

export const startAutoModeSchema = {
  params: z.object({
    jobId: z.string().min(1, 'Job ID is required'),
  }),
  body: z.object({
    autoMaxRounds: z.number().int().min(1).max(20).optional(),
    autoCostLimitUsd: z.number().min(0.1).max(10).optional(),
    autoColorContrastMode: z.enum(['guidance-only', 'disabled', 'apply-to-pdf']).optional(),
  }).strict().optional(),
};

export type StartAutoModeBody = z.infer<typeof startAutoModeSchema['body']>;
