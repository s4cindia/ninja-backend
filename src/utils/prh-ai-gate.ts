/**
 * Controller-side helper for the PRH UK AI alt-text policy gate
 * (P4/PR2). Wraps `assertAiAltTextAllowed` with the Express
 * request/response plumbing so individual controller endpoints just
 * call:
 *
 *   if (await gateAiAltText(req, res, jobId)) return;
 *
 * at the start of any Gemini-invoking path. The helper sends the
 * structured 403 response itself when the gate fires — callers
 * never need to handle PrhAiDisabledError directly.
 */

import type { Request, Response } from 'express';
import { assertAiAltTextAllowed, PrhAiDisabledError } from '../services/prh/prh-config.service';

/**
 * Returns `true` when the gate fired (a 403 response has already
 * been sent — caller should `return` immediately); returns `false`
 * when the call may proceed.
 *
 * Skips the gate entirely when jobId or tenantId is missing — those
 * are unusual edge cases (e.g. raw-buffer endpoints without job
 * context) where PRH detection isn't possible anyway. Production
 * Gemini-invoking paths always pass both.
 */
export async function gateAiAltText(
  req: Request,
  res: Response,
  jobId: string | undefined | null,
): Promise<boolean> {
  if (!jobId) return false;
  const tenantId = req.user?.tenantId;
  if (!tenantId) return false;
  try {
    await assertAiAltTextAllowed(jobId, tenantId);
    return false;
  } catch (err) {
    if (err instanceof PrhAiDisabledError) {
      res.status(403).json({
        success: false,
        error: {
          code: PrhAiDisabledError.CODE,
          message: err.message,
          banner: true,
        },
      });
      return true;
    }
    throw err;
  }
}
