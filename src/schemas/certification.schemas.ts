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
    // The operator's Acrobat Pro attestations, each literally true (the
    // service re-checks and stores them on the certification).
    attestations: z.object({
      allAcrobatChecksRun: z.literal(true, { message: 'Confirm all Acrobat checks were run' }),
      altTextReviewedEveryFigure: z.literal(true, { message: 'Confirm alt text was reviewed for every figure' }),
      readingOrderSpotChecked: z.literal(true, { message: 'Confirm reading order was spot-checked' }),
      bookmarksAndTitleChecked: z.literal(true, { message: 'Confirm bookmarks and document title were checked' }),
    }).strict(),
    acrobatNotes: z.string().max(2000).optional(),
    acrobatWaivers: z.array(z.object({ ruleKey: z.string().min(1).max(200), reason })).max(100).default([]),
    pacPdfUaErrors: z.number().int().nonnegative(),
    // One per failed PAC check (WCAG side -- PDF/UA errors must be 0): the
    // check's name as shown in PAC, its occurrence count, and the reason.
    pacWaivers: z.array(z.object({
      check: z.string().trim().min(1).max(500),
      count: z.number().int().positive(),
      reason,
    })).max(200).default([]),
  }).strict(),
};

export const revokeCertificationSchema = {
  params: jobParams,
  body: z.object({ reason }).strict(),
};

export type CertifyJobBody = z.infer<typeof certifyJobSchema['body']>;
export type RevokeCertificationBody = z.infer<typeof revokeCertificationSchema['body']>;
