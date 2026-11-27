/**
 * Certification endpoint schemas (EPUB-from-certified-PDF, B3a).
 * Structural validation only; the certification rules themselves (report
 * binding, waivers matching failures, PAC counts) are checked by
 * certification.service.ts so every unmet rule is reported together.
 */

import { z } from 'zod';

const jobParams = z.object({ jobId: z.string().min(1, 'Job ID is required') });
const reason = z.string().trim().min(5, 'Give a reason (at least 5 characters)').max(1000);

export const certifyJobSchema = {
  params: jobParams,
  body: z.object({
    // The operator confirms the Acrobat Pro checks were done (Accessibility
    // Checker with all checks, alt text reviewed, reading order spot-checked,
    // bookmarks and title checked). Must be literally true.
    acrobatAttested: z.literal(true, { message: 'Confirm the Acrobat Pro checks were done' }),
    acrobatNotes: z.string().max(2000).optional(),
    acrobatWaivers: z.array(z.object({ ruleKey: z.string().min(1).max(200), reason })).max(100).default([]),
    pacPdfUaErrors: z.number().int().nonnegative(),
    pacWaivers: z.array(z.object({ failure: z.string().trim().min(1).max(500), reason })).max(500).default([]),
  }).strict(),
};

export const revokeCertificationSchema = {
  params: jobParams,
  body: z.object({ reason }).strict(),
};

export type CertifyJobBody = z.infer<typeof certifyJobSchema['body']>;
export type RevokeCertificationBody = z.infer<typeof revokeCertificationSchema['body']>;
