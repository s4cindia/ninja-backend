/**
 * Remediation Session Controller
 *
 * POST /pdf/:jobId/remediation-session/start
 * POST /pdf/:jobId/remediation-session/:sessionId/end
 *
 * Mirrors annotation-report.controller.ts's session endpoints exactly —
 * same shape, different event vocabulary (see remediation-session.service.ts).
 */

import { Request, Response } from 'express';
import { z } from 'zod';
import { remediationSessionService } from '../services/pdf/remediation-session.service';
import { logger } from '../lib/logger';

function serverError(res: Response, err: unknown, code: string) {
  logger.error(`[RemediationSessionController] ${code}`, err);
  return res.status(500).json({
    success: false,
    error: { code, message: 'Internal server error' },
  });
}

const endSessionSchema = z.object({
  activeMs: z.number().int().min(0),
  idleMs: z.number().int().min(0),
  issuesApplied: z.number().int().min(0).default(0),
  suggestionsAccepted: z.number().int().min(0).default(0),
  suggestionsRejected: z.number().int().min(0).default(0),
  bulkApplyUsed: z.boolean().default(false),
  sessionLog: z.any().optional(),
});

class RemediationSessionController {
  async startSession(req: Request, res: Response): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({ success: false, error: { message: 'Unauthorized' } });
        return;
      }
      const { jobId } = req.params;

      const sessionId = await remediationSessionService.startSession(jobId, req.user.id);
      res.json({ success: true, data: { sessionId } });
    } catch (err) {
      serverError(res, err, 'START_SESSION_FAILED');
    }
  }

  async endSession(req: Request, res: Response): Promise<void> {
    try {
      const { sessionId } = req.params;
      const parsed = endSessionSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(422).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Invalid session data', details: parsed.error.issues },
        });
        return;
      }

      await remediationSessionService.endSession(sessionId, parsed.data);
      res.json({ success: true, data: { sessionId } });
    } catch (err) {
      serverError(res, err, 'END_SESSION_FAILED');
    }
  }
}

export const remediationSessionController = new RemediationSessionController();
