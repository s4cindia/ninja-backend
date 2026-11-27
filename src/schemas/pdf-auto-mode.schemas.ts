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
    autoAltTextMode: z.enum(['apply-to-pdf', 'guidance-only']).optional(),
    autoLinkTextMode: z.enum(['guidance-only', 'disabled', 'apply-to-pdf']).optional(),
    autoBookmarkMode: z.enum(['guidance-only', 'disabled', 'apply-to-pdf']).optional(),
  }).strict().optional(),
};

export type StartAutoModeBody = z.infer<typeof startAutoModeSchema['body']>;

/**
 * PATCH /pdf/:jobId/settings -- per-job overrides for fullAutoMode and
 * auto-escalate-on-stall, visible/editable any time (not just at upload).
 * `null` explicitly resets to "inherit the tenant default"; omitting a
 * field leaves its current value untouched.
 */
export const updateJobSettingsSchema = {
  params: z.object({
    jobId: z.string().min(1, 'Job ID is required'),
  }),
  body: z.object({
    fullAutoMode: z.boolean().nullable().optional(),
    autoEscalateOnStall: z.boolean().nullable().optional(),
  }).strict(),
};

export type UpdateJobSettingsBody = z.infer<typeof updateJobSettingsSchema['body']>;

/**
 * PATCH /pdf/:jobId/settings/epub -- separate from updateJobSettingsSchema
 * because it has wider access (the owner's Team Leader too). epubIsbn is
 * checked as a real ISBN-13 by the controller (parseEpubIsbnField), so a
 * bad value gets the specific INVALID_EPUB_ISBN code. At least one field.
 */
export const updateJobEpubSettingsSchema = {
  params: z.object({
    jobId: z.string().min(1, 'Job ID is required'),
  }),
  body: z.object({
    produceAccessibleEpub: z.boolean().nullable().optional(),
    epubIsbn: z.string().max(40).nullable().optional(),
  }).strict().refine(
    (b) => b.produceAccessibleEpub !== undefined || b.epubIsbn !== undefined,
    { message: 'Provide produceAccessibleEpub and/or epubIsbn' },
  ),
};

export type UpdateJobEpubSettingsBody = z.infer<typeof updateJobEpubSettingsSchema['body']>;
