/**
 * Certification controller (EPUB-from-certified-PDF, B3a). Thin: the
 * rules live in certification.service.ts. AppError details are passed
 * through so a 422 CERTIFICATION_BLOCKED carries its full problem list.
 */

import { Response } from 'express';
import { AuthenticatedRequest } from '../types/authenticated-request';
import { logger } from '../lib/logger';
import { AppError } from '../utils/app-error';
import { certifyJob, getCertificationState, revokeCertification } from '../services/certification/certification.service';
import type { CertifyJobBody, RevokeCertificationBody } from '../schemas/certification.schemas';

function sendError(res: Response, err: unknown, fallbackMessage: string, logLabel: string): Response {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      error: { code: err.code, message: err.message, details: err.details ?? null },
    });
  }
  logger.error(`[Certification] ${logLabel} failed`, err as Error);
  return res.status(500).json({
    success: false,
    error: { code: 'INTERNAL_ERROR', message: fallbackMessage, details: null },
  });
}

export class CertificationController {
  /** POST /api/v1/pdf/:jobId/certification */
  async certify(req: AuthenticatedRequest, res: Response): Promise<Response> {
    try {
      const body = req.body as CertifyJobBody;
      const cert = await certifyJob(req.params.jobId, {
        certifiedById: req.user!.id,
        attestations: body.attestations,
        acrobatNotes: body.acrobatNotes,
        acrobatWaivers: body.acrobatWaivers,
        pacPdfUaErrors: body.pacPdfUaErrors,
        pacWaivers: body.pacWaivers,
      });
      return res.status(201).json({ success: true, data: cert });
    } catch (err) {
      return sendError(res, err, 'Failed to certify', 'certify');
    }
  }

  /** GET /api/v1/pdf/:jobId/certification -- re-validates the active one first. */
  async get(req: AuthenticatedRequest, res: Response): Promise<Response> {
    try {
      const state = await getCertificationState(req.params.jobId);
      return res.status(200).json({ success: true, data: state });
    } catch (err) {
      return sendError(res, err, 'Failed to load certification', 'get');
    }
  }

  /** POST /api/v1/pdf/:jobId/certification/revoke */
  async revoke(req: AuthenticatedRequest, res: Response): Promise<Response> {
    try {
      const { reason } = req.body as RevokeCertificationBody;
      await revokeCertification(req.params.jobId, req.user!.id, reason);
      return res.status(200).json({ success: true, data: { revoked: true } });
    } catch (err) {
      return sendError(res, err, 'Failed to revoke certification', 'revoke');
    }
  }
}

export const certificationController = new CertificationController();
