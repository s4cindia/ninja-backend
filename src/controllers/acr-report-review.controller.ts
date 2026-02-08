import { Request, Response } from 'express';
import { acrReportReviewService } from '../services/acr/acr-report-review.service';
import { logger } from '../lib/logger';

/**
 * ACR Report Review Controller
 * Phase 1: Review & Edit Page API
 *
 * Focus: MINIMUM DATA ENTRY - import verification data, minimal editing
 */

export class AcrReportReviewController {
  /**
   * POST /api/v1/acr/report/:jobId/initialize
   * Import verification data into AcrJob/AcrCriterionReview
   * Carries forward all verification work
   */
  async initializeReport(req: Request, res: Response) {
    try {
      const { jobId } = req.params;
      const { edition, verificationData, documentTitle, documentType: _documentType } = req.body;
      const userId = req.user?.id || 'system';
      const tenantId = req.user?.tenantId || 'default';

      logger.info(`[ACR Report Review API] Initializing report for job ${jobId}`);

      const result = await acrReportReviewService.initializeReportFromVerification(
        jobId,
        tenantId,
        userId,
        edition || 'VPAT2.5-INT',
        verificationData,
        documentTitle
      );

      return res.json({
        success: true,
        data: result
      });
    } catch (error) {
      logger.error('[ACR Report Review API] Failed to initialize report', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to initialize report'
      });
    }
  }

  /**
   * DELETE /api/v1/acr/report/:jobId
   * Delete existing report to allow re-initialization with fresh data
   */
  async deleteReport(req: Request, res: Response) {
    try {
      const { jobId } = req.params;

      logger.info(`[ACR Report Review API] Deleting report for job ${jobId}`);

      const result = await acrReportReviewService.deleteReport(jobId);

      return res.json({
        success: true,
        data: result
      });
    } catch (error) {
      logger.error('[ACR Report Review API] Failed to delete report', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete report'
      });
    }
  }

  /**
   * GET /api/v1/acr/report/:jobId
   * Get complete report data for Review & Edit page
   * Returns pre-populated data from verification
   */
  async getReport(req: Request, res: Response) {
    try {
      const { jobId } = req.params;

      logger.info(`[ACR Report Review API] Fetching report for job ${jobId}`);

      const report = await acrReportReviewService.getReportForReview(jobId);

      return res.json({
        success: true,
        data: report
      });
    } catch (error) {
      logger.error('[ACR Report Review API] Failed to fetch report', error instanceof Error ? error : undefined);

      if (error instanceof Error && error.message.includes('not found')) {
        return res.status(404).json({
          success: false,
          error: error.message
        });
      }

      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch report'
      });
    }
  }

  /**
   * PATCH /api/v1/acr/report/:acrJobId/criteria/:criterionId
   * Update single criterion (minimal editing)
   */
  async updateCriterion(req: Request, res: Response) {
    try {
      const { acrJobId, criterionId } = req.params;
      const updates = req.body;
      const userId = req.user?.id || 'system';

      logger.info(`[ACR Report Review API] Updating criterion ${criterionId}`);

      const updated = await acrReportReviewService.updateCriterion(
        acrJobId,
        criterionId,
        updates,
        userId
      );

      return res.json({
        success: true,
        data: updated
      });
    } catch (error) {
      logger.error('[ACR Report Review API] Failed to update criterion', error instanceof Error ? error : undefined);

      if (error instanceof Error && error.message.includes('not found')) {
        return res.status(404).json({
          success: false,
          error: error.message
        });
      }

      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update criterion'
      });
    }
  }

  /**
   * PATCH /api/v1/acr/report/:acrJobId/metadata
   * Update report metadata (executive summary, etc.)
   */
  async updateMetadata(req: Request, res: Response) {
    try {
      const { acrJobId } = req.params;
      const updates = req.body;
      const userId = req.user?.id || 'system';

      logger.info(`[ACR Report Review API] Updating report metadata for ${acrJobId}`);

      const updated = await acrReportReviewService.updateReportMetadata(
        acrJobId,
        updates,
        userId
      );

      return res.json({
        success: true,
        data: updated
      });
    } catch (error) {
      logger.error('[ACR Report Review API] Failed to update metadata', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update metadata'
      });
    }
  }

  /**
   * GET /api/v1/acr/report/:acrJobId/criteria/:criterionId/history
   * Get change history for a criterion
   */
  async getCriterionHistory(req: Request, res: Response) {
    try {
      const { acrJobId, criterionId } = req.params;

      logger.info(`[ACR Report Review API] Fetching history for criterion ${criterionId}`);

      const history = await acrReportReviewService.getCriterionHistory(acrJobId, criterionId);

      return res.json({
        success: true,
        data: history
      });
    } catch (error) {
      logger.error('[ACR Report Review API] Failed to fetch history', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch history'
      });
    }
  }

  /**
   * POST /api/v1/acr/report/:acrJobId/approve
   * Approve report for export
   */
  async approveReport(req: Request, res: Response) {
    try {
      const { acrJobId } = req.params;
      const userId = req.user?.id || 'system';

      logger.info(`[ACR Report Review API] Approving report ${acrJobId}`);

      const approved = await acrReportReviewService.approveReport(acrJobId, userId);

      return res.json({
        success: true,
        data: approved
      });
    } catch (error) {
      logger.error('[ACR Report Review API] Failed to approve report', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to approve report'
      });
    }
  }

  /**
   * GET /api/v1/acr/report/:jobId/versions
   * List all draft versions for a job
   */
  async listVersions(req: Request, res: Response) {
    try {
      const { jobId } = req.params;

      logger.info(`[ACR Report Review API] Listing versions for job ${jobId}`);

      const versions = await acrReportReviewService.listReportVersions(jobId);

      return res.json({
        success: true,
        data: versions
      });
    } catch (error) {
      logger.error('[ACR Report Review API] Failed to list versions', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list versions'
      });
    }
  }

  /**
   * GET /api/v1/acr/report/version/:acrJobId
   * Get specific report version by acrJobId
   */
  async getReportVersion(req: Request, res: Response) {
    try {
      const { acrJobId } = req.params;

      logger.info(`[ACR Report Review API] Fetching version ${acrJobId}`);

      const version = await acrReportReviewService.getReportVersion(acrJobId);

      return res.json({
        success: true,
        data: version
      });
    } catch (error) {
      logger.error('[ACR Report Review API] Failed to fetch version', error instanceof Error ? error : undefined);

      if (error instanceof Error && error.message.includes('not found')) {
        return res.status(404).json({
          success: false,
          error: error.message
        });
      }

      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch version'
      });
    }
  }
}

export const acrReportReviewController = new AcrReportReviewController();
