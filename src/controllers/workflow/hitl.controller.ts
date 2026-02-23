import { Request, Response } from 'express';
import { workflowService } from '../../services/workflow/workflow.service';
import { logger } from '../../lib/logger';

/**
 * HITL (Human-in-the-Loop) Controller
 * Handles manual approval/rejection at workflow gates
 */
export class HitlController {
  /**
   * Approve AI Review (AWAITING_AI_REVIEW → AUTO_REMEDIATION)
   */
  async approveAiReview(req: Request, res: Response): Promise<void> {
    try {
      const { workflowId } = req.params;
      const { notes } = req.body;

      logger.info(`[HITL] Approving AI review for workflow ${workflowId} by user ${req.user!.id}`);

      const workflow = await workflowService.transition(workflowId, 'AI_ACCEPTED', {
        approved: true,
        approvedBy: req.user!.id,
        approvedAt: new Date().toISOString(),
        notes: notes || 'AI analysis approved',
      });

      res.json({
        success: true,
        data: {
          workflowId: workflow.id,
          currentState: workflow.currentState,
          completedAt: workflow.completedAt,
        },
      });
    } catch (error) {
      logger.error('[HITL] Error approving AI review:', error);
      res.status(500).json({
        success: false,
        error: {
          message: error instanceof Error ? error.message : 'Failed to approve AI review',
        },
      });
    }
  }

  /**
   * Reject AI Review (AWAITING_AI_REVIEW → RUNNING_AI_ANALYSIS)
   */
  async rejectAiReview(req: Request, res: Response): Promise<void> {
    try {
      const { workflowId } = req.params;
      const { notes } = req.body;

      logger.info(`[HITL] Rejecting AI review for workflow ${workflowId} by user ${req.user!.id}`);

      const workflow = await workflowService.transition(workflowId, 'AI_REJECTED', {
        rejected: true,
        rejectedBy: req.user!.id,
        rejectedAt: new Date().toISOString(),
        notes: notes || 'AI analysis rejected',
      });

      res.json({
        success: true,
        data: {
          workflowId: workflow.id,
          currentState: workflow.currentState,
        },
      });
    } catch (error) {
      logger.error('[HITL] Error rejecting AI review:', error);
      res.status(500).json({
        success: false,
        error: {
          message: error instanceof Error ? error.message : 'Failed to reject AI review',
        },
      });
    }
  }

  /**
   * Approve Remediation Review (AWAITING_REMEDIATION_REVIEW → VERIFICATION_AUDIT)
   */
  async approveRemediationReview(req: Request, res: Response): Promise<void> {
    try {
      const { workflowId } = req.params;
      const { notes } = req.body;

      logger.info(`[HITL] Approving remediation review for workflow ${workflowId} by user ${req.user!.id}`);

      const workflow = await workflowService.transition(workflowId, 'REMEDIATION_APPROVED', {
        approved: true,
        approvedBy: req.user!.id,
        approvedAt: new Date().toISOString(),
        notes: notes || 'Remediation approved',
      });

      res.json({
        success: true,
        data: {
          workflowId: workflow.id,
          currentState: workflow.currentState,
        },
      });
    } catch (error) {
      logger.error('[HITL] Error approving remediation review:', error);
      res.status(500).json({
        success: false,
        error: {
          message: error instanceof Error ? error.message : 'Failed to approve remediation review',
        },
      });
    }
  }

  /**
   * Approve Conformance Review (AWAITING_CONFORMANCE_REVIEW → ACR_GENERATION)
   */
  async approveConformanceReview(req: Request, res: Response): Promise<void> {
    try {
      const { workflowId } = req.params;
      const { notes } = req.body;

      logger.info(`[HITL] Approving conformance review for workflow ${workflowId} by user ${req.user!.id}`);

      const workflow = await workflowService.transition(workflowId, 'CONFORMANCE_APPROVED', {
        approved: true,
        approvedBy: req.user!.id,
        approvedAt: new Date().toISOString(),
        notes: notes || 'Conformance approved',
      });

      res.json({
        success: true,
        data: {
          workflowId: workflow.id,
          currentState: workflow.currentState,
        },
      });
    } catch (error) {
      logger.error('[HITL] Error approving conformance review:', error);
      res.status(500).json({
        success: false,
        error: {
          message: error instanceof Error ? error.message : 'Failed to approve conformance review',
        },
      });
    }
  }

  /**
   * Sign off ACR (AWAITING_ACR_SIGNOFF → COMPLETED)
   */
  async signoffAcr(req: Request, res: Response): Promise<void> {
    try {
      const { workflowId } = req.params;
      const { notes } = req.body;

      logger.info(`[HITL] Signing off ACR for workflow ${workflowId} by user ${req.user!.id}`);

      const workflow = await workflowService.transition(workflowId, 'ACR_SIGNED', {
        approved: true,
        signedBy: req.user!.id,
        signedAt: new Date().toISOString(),
        notes: notes || 'ACR signed off',
      });

      res.json({
        success: true,
        data: {
          workflowId: workflow.id,
          currentState: workflow.currentState,
          completedAt: workflow.completedAt,
        },
      });
    } catch (error) {
      logger.error('[HITL] Error signing off ACR:', error);
      res.status(500).json({
        success: false,
        error: {
          message: error instanceof Error ? error.message : 'Failed to sign off ACR',
        },
      });
    }
  }

  /**
   * Pause workflow at current state
   */
  async pauseWorkflow(req: Request, res: Response): Promise<void> {
    try {
      const { workflowId } = req.params;
      const { reason } = req.body;

      logger.info(`[HITL] Pausing workflow ${workflowId} by user ${req.user!.id}`);

      const workflow = await workflowService.transition(workflowId, 'PAUSE', {
        pausedBy: req.user!.id,
        pausedAt: new Date().toISOString(),
        pauseReason: reason || 'Manual pause',
      });

      res.json({
        success: true,
        data: {
          workflowId: workflow.id,
          currentState: workflow.currentState,
        },
      });
    } catch (error) {
      logger.error('[HITL] Error pausing workflow:', error);
      res.status(500).json({
        success: false,
        error: {
          message: error instanceof Error ? error.message : 'Failed to pause workflow',
        },
      });
    }
  }

  /**
   * Resume paused workflow
   */
  async resumeWorkflow(req: Request, res: Response): Promise<void> {
    try {
      const { workflowId } = req.params;

      logger.info(`[HITL] Resuming workflow ${workflowId} by user ${req.user!.id}`);

      const workflow = await workflowService.transition(workflowId, 'RESUME', {
        resumedBy: req.user!.id,
        resumedAt: new Date().toISOString(),
      });

      res.json({
        success: true,
        data: {
          workflowId: workflow.id,
          currentState: workflow.currentState,
        },
      });
    } catch (error) {
      logger.error('[HITL] Error resuming workflow:', error);
      res.status(500).json({
        success: false,
        error: {
          message: error instanceof Error ? error.message : 'Failed to resume workflow',
        },
      });
    }
  }
}

export const hitlController = new HitlController();
