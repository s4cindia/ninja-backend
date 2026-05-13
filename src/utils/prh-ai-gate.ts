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
import { logger } from '../lib/logger';

/**
 * Returns `true` when the gate fired (a 403 response has already
 * been sent — caller should `return` immediately); returns `false`
 * when the call may proceed.
 *
 * Skips the gate ONLY when jobId is missing — that's the explicit
 * raw-buffer test path (`generateFromBuffer`) which has no job
 * context and is documented as outside the PRH-job flow.
 *
 * If jobId is supplied but tenantId is missing on req.user, we
 * FAIL CLOSED — the `authenticate` middleware should always
 * populate req.user.tenantId, so a missing value is a sign of
 * either a misconfigured route (no auth middleware) or a malformed
 * request slipping through. Failing closed prevents the gate from
 * silently allowing AI generation when it can't verify the policy.
 */
export async function gateAiAltText(
  req: Request,
  res: Response,
  jobId: string | undefined | null,
): Promise<boolean> {
  if (!jobId) return false;
  const tenantId = req.user?.tenantId;
  if (!tenantId) {
    logger.warn(
      `[gateAiAltText] missing req.user.tenantId on request that supplied jobId=${jobId} — failing closed`,
    );
    res.status(401).json({
      success: false,
      error: {
        code: 'NOT_AUTHENTICATED',
        message: 'Authentication required to invoke alt-text generation.',
      },
    });
    return true;
  }
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
