/**
 * Style Validation Controller
 *
 * Handles style validation API requests:
 * - Start validation jobs
 * - Get violations
 * - Apply fixes
 * - Ignore violations
 * - Bulk actions
 */

import { Request, Response, NextFunction } from 'express';
import { styleValidation, type ViolationFilters } from '../../services/style/style-validation.service';
import { styleRulesRegistry } from '../../services/style/style-rules-registry.service';
import { getStyleQueue, JOB_TYPES } from '../../queues';
import type { AuthenticatedRequest } from '../../types/authenticated-request';
import type {
  StartValidationBody,
  ApplyFixBody,
  IgnoreViolationBody,
  BulkActionBody,
} from '../../schemas/style.schemas';

export class StyleController {
  /**
   * Start a style validation job
   * POST /api/v1/style/validate
   */
  async startValidation(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const body = req.body as StartValidationBody;
      const tenantId = req.user?.tenantId;
      const userId = req.user?.id;

      if (!tenantId || !userId) {
        return res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
        });
      }

      // Queue the validation job
      // TODO: Fix BullMQ worker issue - force sync mode for now
      const styleQueue = getStyleQueue();
      const forceSyncMode = true; // Temporary fix
      if (!styleQueue || forceSyncMode) {
        // If no queue, run synchronously
        const job = await styleValidation.startValidation(tenantId, userId, {
          documentId: body.documentId,
          ruleSetIds: body.ruleSetIds,
          styleGuide: body.styleGuide,
          includeHouseRules: body.includeHouseRules,
          useAiValidation: body.useAiValidation,
        });

        // Create progress callback that updates the database
        const onProgress = async (progress: number, message: string) => {
          await styleValidation.updateJobProgress(job.id, progress, message);
        };

        // Execute immediately in background with progress tracking
        styleValidation.executeValidation(job.id, onProgress).catch((error) => {
          console.error('[Style Controller] Validation failed:', error);
        });

        return res.status(202).json({
          success: true,
          data: {
            jobId: job.id,
            status: job.status,
            message: 'Validation started',
          },
        });
      }

      // Create the job record first
      const validationJob = await styleValidation.startValidation(
        tenantId,
        userId,
        {
          documentId: body.documentId,
          ruleSetIds: body.ruleSetIds,
          styleGuide: body.styleGuide,
          includeHouseRules: body.includeHouseRules,
          useAiValidation: body.useAiValidation,
        }
      );

      // Queue for background processing
      await styleQueue.add(
        'style-validation',
        {
          type: JOB_TYPES.STYLE_VALIDATION,
          tenantId,
          userId,
          options: {
            documentId: body.documentId,
            ruleSetIds: body.ruleSetIds,
            includeHouseRules: body.includeHouseRules ?? true,
            validationJobId: validationJob.id,
          },
        },
        {
          jobId: validationJob.id,
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
        }
      );

      return res.status(202).json({
        success: true,
        data: {
          jobId: validationJob.id,
          status: 'QUEUED',
          message: 'Validation job queued successfully',
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get validation job status
   * GET /api/v1/style/job/:jobId
   */
  async getJobStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const { jobId } = req.params;

      const progress = await styleValidation.getJobProgress(jobId);

      if (!progress) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Validation job not found' },
        });
      }

      return res.status(200).json({
        success: true,
        data: progress,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get violations for a document
   * GET /api/v1/style/document/:documentId
   */
  async getViolations(req: Request, res: Response, next: NextFunction) {
    try {
      const { documentId } = req.params;
      const query = req.query as Record<string, string | undefined>;

      const filters: ViolationFilters = {};

      if (query.category) {
        filters.category = query.category as ViolationFilters['category'];
      }
      if (query.severity) {
        filters.severity = query.severity as ViolationFilters['severity'];
      }
      if (query.status) {
        filters.status = query.status as ViolationFilters['status'];
      }
      if (query.ruleId) {
        filters.ruleId = query.ruleId;
      }
      if (query.styleGuide) {
        filters.styleGuide = query.styleGuide as ViolationFilters['styleGuide'];
      }
      if (query.search) {
        filters.search = query.search;
      }

      const pagination = {
        skip: query.skip ? parseInt(query.skip, 10) : 0,
        take: query.take ? parseInt(query.take, 10) : 100,
      };

      const result = await styleValidation.getViolations(
        documentId,
        filters,
        pagination
      );

      return res.status(200).json({
        success: true,
        data: {
          violations: result.violations,
          total: result.total,
          pagination: {
            skip: pagination.skip,
            take: pagination.take,
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get validation summary for a document
   * GET /api/v1/style/document/:documentId/summary
   */
  async getValidationSummary(req: Request, res: Response, next: NextFunction) {
    try {
      const { documentId } = req.params;

      const summary = await styleValidation.getValidationSummary(documentId);

      if (!summary) {
        return res.status(404).json({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: 'No validation results found for this document',
          },
        });
      }

      return res.status(200).json({
        success: true,
        data: summary,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Apply fix to a violation
   * POST /api/v1/style/violation/:violationId/fix
   */
  async applyFix(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const { violationId } = req.params;
      const body = req.body as ApplyFixBody;
      const userId = req.user?.id;

      if (!userId) {
        return res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
        });
      }

      const updated = await styleValidation.applyFix({
        violationId,
        fixOption: body.fixOption,
        userId,
      });

      return res.status(200).json({
        success: true,
        data: updated,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Ignore a violation
   * POST /api/v1/style/violation/:violationId/ignore
   */
  async ignoreViolation(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const { violationId } = req.params;
      const body = req.body as IgnoreViolationBody;
      const userId = req.user?.id;

      if (!userId) {
        return res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
        });
      }

      const updated = await styleValidation.ignoreViolation(
        violationId,
        userId,
        body.reason
      );

      return res.status(200).json({
        success: true,
        data: updated,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Bulk fix/ignore violations
   * POST /api/v1/style/violations/bulk
   */
  async bulkAction(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const body = req.body as BulkActionBody;
      const userId = req.user?.id;

      if (!userId) {
        return res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
        });
      }

      const result = await styleValidation.bulkAction({
        violationIds: body.violationIds,
        action: body.action,
        userId,
        reason: body.reason,
      });

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get available rule sets
   * GET /api/v1/style/rule-sets
   */
  async getRuleSets(_req: Request, res: Response, next: NextFunction) {
    try {
      const ruleSets = styleRulesRegistry.getAllRuleSets();

      return res.status(200).json({
        success: true,
        data: {
          ruleSets: ruleSets.map((rs) => ({
            id: rs.id,
            name: rs.name,
            description: rs.description,
            styleGuide: rs.styleGuide,
            ruleCount: rs.rules.length,
          })),
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get rules in a rule set
   * GET /api/v1/style/rule-sets/:ruleSetId
   */
  async getRuleSetRules(req: Request, res: Response, next: NextFunction) {
    try {
      const { ruleSetId } = req.params;

      const ruleSet = styleRulesRegistry.getRuleSet(ruleSetId);

      if (!ruleSet) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Rule set not found' },
        });
      }

      return res.status(200).json({
        success: true,
        data: {
          id: ruleSet.id,
          name: ruleSet.name,
          description: ruleSet.description,
          styleGuide: ruleSet.styleGuide,
          rules: ruleSet.rules.map((r) => ({
            id: r.id,
            name: r.name,
            description: r.description,
            category: r.category,
            severity: r.severity,
            examples: r.examples,
          })),
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Debug endpoint - test rules against sample text
   * POST /api/v1/style/debug/test-rules
   */
  async testRulesDebug(req: Request, res: Response, next: NextFunction) {
    try {
      const { text, ruleSetIds = ['general'] } = req.body;

      if (!text) {
        return res.status(400).json({
          success: false,
          error: { code: 'NO_TEXT', message: 'Text is required' },
        });
      }

      const matches = styleRulesRegistry.validateText(text, ruleSetIds);

      return res.status(200).json({
        success: true,
        data: {
          textLength: text.length,
          textPreview: text.slice(0, 500),
          ruleSetIds,
          matchCount: matches.length,
          matches: matches.slice(0, 20).map((m) => ({
            ruleId: m.ruleId,
            ruleName: m.ruleName,
            matchedText: m.matchedText,
            suggestedFix: m.suggestedFix,
            startOffset: m.startOffset,
            endOffset: m.endOffset,
          })),
        },
      });
    } catch (error) {
      next(error);
    }
  }
}

export const styleController = new StyleController();
