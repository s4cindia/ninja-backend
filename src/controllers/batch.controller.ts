import { Response } from 'express';
import { AuthenticatedRequest } from '../types/authenticated-request';
import { batchOrchestratorService } from '../services/batch/batch-orchestrator.service';
import { batchAcrGeneratorService } from '../services/acr/batch-acr-generator.service';
import { batchQuickFixService } from '../services/batch/batch-quick-fix.service';
import { queueService } from '../services/queue.service';
import { s3Service } from '../services/s3.service';
import prisma from '../lib/prisma';
import { logger } from '../lib/logger';

class BatchController {
  async createBatch(req: AuthenticatedRequest, res: Response) {
    try {
      const { name } = req.body;
      const tenantId = req.user!.tenantId;
      const userId = req.user!.id;

      const batch = await batchOrchestratorService.createBatch(tenantId, userId, name);

      return res.status(201).json({
        success: true,
        data: {
          batchId: batch.id,
          name: batch.name,
          status: batch.status,
          totalFiles: batch.totalFiles,
          createdAt: batch.createdAt,
        },
      });
    } catch (error) {
      logger.error('Create batch failed', error);
      return res.status(500).json({
        success: false,
        error: {
          message: error instanceof Error ? error.message : 'Failed to create batch',
          code: 'BATCH_CREATE_FAILED',
        },
      });
    }
  }

  async uploadFiles(req: AuthenticatedRequest, res: Response) {
    try {
      const { batchId } = req.params;
      const tenantId = req.user!.tenantId;

      await batchOrchestratorService.getBatchForUser(batchId, tenantId);

      const files = (req.files as Express.Multer.File[]) || [];

      if (files.length === 0) {
        return res.status(400).json({
          success: false,
          error: {
            message: 'No files uploaded',
            code: 'NO_FILES',
          },
        });
      }

      const uploadedFiles = files.map(f => ({
        buffer: f.buffer,
        filename: f.originalname,
        size: f.size,
      }));

      const batchFiles = await batchOrchestratorService.addFilesToBatch(batchId, uploadedFiles);

      return res.status(201).json({
        success: true,
        data: {
          filesAdded: batchFiles.length,
          files: batchFiles.map(f => ({
            fileId: f.id,
            fileName: f.fileName,
            originalName: f.originalName,
            fileSize: f.fileSize,
            status: f.status,
          })),
        },
      });
    } catch (error) {
      logger.error('Upload files failed', error);
      return res.status(500).json({
        success: false,
        error: {
          message: error instanceof Error ? error.message : 'Failed to upload files',
          code: 'FILE_UPLOAD_FAILED',
        },
      });
    }
  }

  async removeFile(req: AuthenticatedRequest, res: Response) {
    try {
      const { batchId, fileId } = req.params;
      const tenantId = req.user!.tenantId;

      await batchOrchestratorService.getBatchForUser(batchId, tenantId);
      await batchOrchestratorService.removeFileFromBatch(batchId, fileId);

      return res.json({
        success: true,
        message: 'File removed from batch',
      });
    } catch (error) {
      logger.error('Remove file failed', error);
      return res.status(500).json({
        success: false,
        error: {
          message: error instanceof Error ? error.message : 'Failed to remove file',
          code: 'FILE_REMOVE_FAILED',
        },
      });
    }
  }

  async startBatch(req: AuthenticatedRequest, res: Response) {
    try {
      const { batchId } = req.params;
      const tenantId = req.user!.tenantId;

      await batchOrchestratorService.getBatchForUser(batchId, tenantId);

      const batch = await batchOrchestratorService.startBatchProcessing(batchId);

      return res.json({
        success: true,
        data: {
          batchId: batch.id,
          status: batch.status,
          totalFiles: batch.totalFiles,
          startedAt: batch.startedAt,
        },
      });
    } catch (error) {
      logger.error('Start batch failed', error);
      return res.status(500).json({
        success: false,
        error: {
          message: error instanceof Error ? error.message : 'Failed to start batch',
          code: 'BATCH_START_FAILED',
        },
      });
    }
  }

  async getBatch(req: AuthenticatedRequest, res: Response) {
    try {
      const { batchId } = req.params;
      const tenantId = req.user!.tenantId;

      const batch = await batchOrchestratorService.getBatchForUser(batchId, tenantId);

      return res.json({
        success: true,
        data: {
          batchId: batch.id,
          name: batch.name,
          status: batch.status,

          totalFiles: batch.totalFiles,
          filesUploaded: batch.filesUploaded,
          filesAudited: batch.filesAudited,
          filesPlanned: batch.filesPlanned,
          filesRemediated: batch.filesRemediated,
          filesFailed: batch.filesFailed,

          totalIssuesFound: batch.totalIssuesFound,
          autoFixedIssues: batch.autoFixedIssues,
          quickFixIssues: batch.quickFixIssues,
          manualIssues: batch.manualIssues,

          files: batch.files.map(f => ({
            fileId: f.id,
            fileName: f.fileName,
            originalName: f.originalName,
            fileSize: f.fileSize,
            status: f.status,
            auditScore: f.auditScore,
            issuesFound: f.issuesFound,
            issuesAutoFixed: f.issuesAutoFixed,
            remainingQuickFix: f.remainingQuickFix,
            remainingManual: f.remainingManual,
            error: f.error,
            uploadedAt: f.uploadedAt,
            remediationCompletedAt: f.remediationCompletedAt,
          })),

          createdAt: batch.createdAt,
          startedAt: batch.startedAt,
          completedAt: batch.completedAt,
        },
      });
    } catch (error) {
      logger.error('Get batch failed', error);
      return res.status(404).json({
        success: false,
        error: {
          message: error instanceof Error ? error.message : 'Batch not found',
          code: 'BATCH_NOT_FOUND',
        },
      });
    }
  }

  async listBatches(req: AuthenticatedRequest, res: Response) {
    try {
      const tenantId = req.user!.tenantId;
      const { page, limit, status } = req.query;

      const result = await batchOrchestratorService.listBatches(
        tenantId,
        Number(page) || 1,
        Number(limit) || 20,
        status as 'DRAFT' | 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | undefined
      );

      return res.json({
        success: true,
        data: {
          batches: result.batches.map(b => ({
            batchId: b.id,
            name: b.name,
            status: b.status,
            totalFiles: b.totalFiles,
            filesRemediated: b.filesRemediated,
            createdAt: b.createdAt,
            completedAt: b.completedAt,
          })),
          total: result.total,
          page: Number(page) || 1,
          limit: Number(limit) || 20,
        },
      });
    } catch (error) {
      logger.error('List batches failed', error);
      return res.status(500).json({
        success: false,
        error: {
          message: error instanceof Error ? error.message : 'Failed to list batches',
          code: 'BATCH_LIST_FAILED',
        },
      });
    }
  }

  async cancelBatch(req: AuthenticatedRequest, res: Response) {
    try {
      const { batchId } = req.params;
      const tenantId = req.user!.tenantId;

      await batchOrchestratorService.getBatchForUser(batchId, tenantId);

      const batch = await batchOrchestratorService.cancelBatch(batchId);

      return res.json({
        success: true,
        data: {
          batchId: batch.id,
          status: batch.status,
          message: 'Batch cancelled successfully',
        },
      });
    } catch (error) {
      logger.error('Cancel batch failed', error);
      return res.status(500).json({
        success: false,
        error: {
          message: error instanceof Error ? error.message : 'Failed to cancel batch',
          code: 'BATCH_CANCEL_FAILED',
        },
      });
    }
  }

  async generateBatchAcr(req: AuthenticatedRequest, res: Response) {
    try {
      const { batchId } = req.params;
      const { mode, options } = req.body;
      const tenantId = req.user!.tenantId;
      const userId = req.user!.id;

      const batch = await batchOrchestratorService.getBatchForUser(batchId, tenantId);

      if (batch.status !== 'COMPLETED') {
        return res.status(400).json({
          success: false,
          error: {
            message: 'Batch must be completed before generating ACR',
            code: 'BATCH_NOT_COMPLETED',
          },
        });
      }

      const remediatedFiles = batch.files.filter(f => f.status === 'REMEDIATED');

      if (remediatedFiles.length === 0) {
        return res.status(400).json({
          success: false,
          error: {
            message: 'No successfully remediated files to generate ACR',
            code: 'NO_SUCCESSFUL_FILES',
          },
        });
      }

      const result = await batchAcrGeneratorService.generateBatchAcr(
        batchId,
        tenantId,
        userId,
        mode,
        options
      );

      return res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      logger.error('Generate batch ACR failed', error);
      return res.status(500).json({
        success: false,
        error: {
          message: error instanceof Error ? error.message : 'Failed to generate batch ACR',
          code: 'ACR_GENERATION_FAILED',
        },
      });
    }
  }

  async exportBatch(req: AuthenticatedRequest, res: Response) {
    try {
      const { batchId } = req.params;
      const tenantId = req.user!.tenantId;

      const batch = await batchOrchestratorService.getBatchForUser(batchId, tenantId);

      if (batch.status !== 'COMPLETED') {
        return res.status(400).json({
          success: false,
          error: {
            message: 'Batch must be completed before exporting',
            code: 'BATCH_NOT_COMPLETED',
          },
        });
      }

      return res.json({
        success: true,
        data: {
          message: 'Export feature coming soon',
          batchId: batch.id,
        },
      });
    } catch (error) {
      logger.error('Export batch failed', error);
      return res.status(500).json({
        success: false,
        error: {
          message: error instanceof Error ? error.message : 'Failed to export batch',
          code: 'BATCH_EXPORT_FAILED',
        },
      });
    }
  }

  async applyQuickFixes(req: AuthenticatedRequest, res: Response) {
    try {
      const { batchId } = req.params;
      const tenantId = req.user!.tenantId;
      const userId = req.user!.id;

      const result = await batchQuickFixService.applyQuickFixes(batchId, tenantId, userId);

      if (result.success) {
        return res.json({
          success: true,
          data: {
            message: `Quick-fixes applied to ${result.filesProcessed} files`,
            filesProcessed: result.filesProcessed,
            issuesFixed: result.issuesFixed,
          },
        });
      } else {
        return res.status(result.filesProcessed > 0 ? 207 : 400).json({
          success: false,
          data: {
            message: 'Some quick-fixes failed to apply',
            filesProcessed: result.filesProcessed,
            issuesFixed: result.issuesFixed,
            errors: result.errors,
          },
        });
      }
    } catch (error) {
      logger.error('Apply quick-fixes failed', error);
      return res.status(500).json({
        success: false,
        error: {
          message: error instanceof Error ? error.message : 'Failed to apply quick-fixes',
          code: 'QUICK_FIX_FAILED',
        },
      });
    }
  }

  getBatchFile = async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { batchId, fileId } = req.params;
      const tenantId = req.user!.tenantId;

      const file = await prisma.batchFile.findFirst({
        where: {
          id: fileId,
          batchId: batchId,
          batch: {
            tenantId: tenantId,
          },
        },
        include: {
          batch: {
            select: {
              id: true,
              name: true,
              status: true,
              tenantId: true,
              userId: true,
            },
          },
        },
      });

      if (!file) {
        return res.status(404).json({
          success: false,
          error: {
            message: 'Batch file not found',
            code: 'FILE_NOT_FOUND',
          },
        });
      }

      let auditResults = null;
      if (file.auditJobId) {
        try {
          const auditJob = await queueService.getJobStatus(file.auditJobId, tenantId);
          auditResults = auditJob?.output || null;
        } catch (error) {
          logger.warn(`Failed to fetch audit job ${file.auditJobId}:`, error);
        }
      }

      let planResults = null;
      if (file.planJobId) {
        try {
          const planJob = await queueService.getJobStatus(file.planJobId, tenantId);
          planResults = planJob?.output || null;
        } catch (error) {
          logger.warn(`Failed to fetch plan job ${file.planJobId}:`, error);
        }
      }

      const { autoFixedIssues, quickFixIssues, manualIssues } = this.extractIssuesFromPlan(planResults, auditResults);

      const quickFixCount = file.issuesQuickFix || quickFixIssues.length;
      const manualCount = file.issuesManual || manualIssues.length;

      const response = {
        fileId: file.id,
        id: file.id,
        batchId: file.batchId,
        fileName: file.fileName,
        originalName: file.originalName,
        fileSize: file.fileSize,
        status: file.status,
        auditScore: file.auditScore,
        issuesFound: file.issuesFound,
        issuesAutoFixed: file.issuesAutoFixed || autoFixedIssues.length,
        issuesQuickFix: file.issuesQuickFix || quickFixIssues.length,
        issuesManual: file.issuesManual || manualIssues.length,
        remainingQuickFix: file.remainingQuickFix ?? quickFixIssues.length,
        remainingManual: file.remainingManual ?? manualIssues.length,
        quickFixCount: quickFixCount,
        manualCount: manualCount,
        originalS3Key: file.storagePath,
        remediatedS3Key: file.remediatedFilePath,
        auditJobId: file.auditJobId,
        planJobId: file.planJobId,
        auditResults: auditResults,
        planResults: planResults,
        autoFixedIssues: autoFixedIssues,
        quickFixIssues: quickFixIssues,
        manualIssues: manualIssues,
        batch: file.batch,
        uploadedAt: file.uploadedAt,
        auditCompletedAt: file.auditCompletedAt,
        remediationCompletedAt: file.remediationCompletedAt,
      };

      return res.json({
        success: true,
        data: response,
      });
    } catch (error) {
      logger.error('Get batch file error:', error);
      return res.status(500).json({
        success: false,
        error: {
          message: error instanceof Error ? error.message : 'Failed to load batch file details',
          code: 'FILE_DETAILS_FAILED',
        },
      });
    }
  }

  downloadBatchFile = async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { batchId, fileId } = req.params;
      const tenantId = req.user!.tenantId;
      const version = req.query.version as string | undefined;

      const file = await prisma.batchFile.findFirst({
        where: {
          id: fileId,
          batchId: batchId,
          batch: {
            tenantId: tenantId,
          },
        },
      });

      if (!file) {
        return res.status(404).json({
          success: false,
          error: {
            message: 'Batch file not found',
            code: 'FILE_NOT_FOUND',
          },
        });
      }

      let s3Key: string | null = null;
      if (version === 'original') {
        s3Key = file.storagePath;
      } else {
        s3Key = file.remediatedFilePath || file.storagePath;
      }

      if (!s3Key) {
        return res.status(404).json({
          success: false,
          error: {
            message: 'File not available for download',
            code: 'FILE_UNAVAILABLE',
          },
        });
      }

      const { downloadUrl, expiresIn } = await s3Service.getPresignedDownloadUrl(s3Key, 3600);

      return res.json({
        success: true,
        data: {
          downloadUrl: downloadUrl,
          fileName: file.originalName || file.fileName,
          expiresIn: expiresIn,
        },
      });
    } catch (error) {
      logger.error('Download batch file error:', error);
      return res.status(500).json({
        success: false,
        error: {
          message: error instanceof Error ? error.message : 'Failed to generate download URL',
          code: 'DOWNLOAD_FAILED',
        },
      });
    }
  }

  private extractIssuesFromPlan(planResults: unknown, auditResults: unknown): {
    autoFixedIssues: unknown[];
    quickFixIssues: unknown[];
    manualIssues: unknown[];
  } {
    const autoFixedIssues: unknown[] = [];
    const quickFixIssues: unknown[] = [];
    const manualIssues: unknown[] = [];

    logger.info('[extractIssuesFromPlan] Starting extraction');
    logger.info('[extractIssuesFromPlan] planResults type:', typeof planResults);
    logger.info('[extractIssuesFromPlan] auditResults type:', typeof auditResults);

    if (planResults && typeof planResults === 'object') {
      const plan = planResults as Record<string, unknown>;
      logger.info('[extractIssuesFromPlan] Plan keys:', Object.keys(plan));

      // Check for combinedIssues array (actual data structure from audit)
      const combinedIssues = plan.combinedIssues as unknown[] | undefined;
      if (combinedIssues && Array.isArray(combinedIssues)) {
        logger.info('[extractIssuesFromPlan] combinedIssues found:', combinedIssues.length);
        
        for (const issue of combinedIssues) {
          const i = issue as Record<string, unknown>;
          const autoFixable = i.autoFixable as boolean | undefined;
          const quickFixable = i.quickFixable as boolean | undefined;
          const status = (i.status as string)?.toLowerCase();
          
          const issueData = {
            id: i.id || i.code,
            criterion: i.wcagCriterion || i.criterion || i.code || 'Unknown',
            title: i.title || i.name || i.message || i.code || 'Accessibility Issue',
            severity: i.severity || i.impact || 'moderate',
            description: i.description || i.message || 'No description available',
            location: i.location || i.file || i.element,
          };

          // Categorize based on autoFixable/quickFixable flags
          if (autoFixable === true || status === 'fixed' || status === 'auto_fixed') {
            autoFixedIssues.push({
              ...issueData,
              fixApplied: (i.fix || i.resolution || 'Auto-fixed by system') as string,
            });
          } else if (quickFixable === true) {
            quickFixIssues.push({
              ...issueData,
              suggestedFix: (i.suggestedFix || i.fix || i.recommendation || 'Quick-fix available') as string,
            });
          } else {
            manualIssues.push({
              ...issueData,
              guidance: (i.guidance || i.recommendation || i.help || 'Manual review required') as string,
            });
          }
        }
      }

      // Also check autoRemediation object for fixed issues
      const autoRemediation = plan.autoRemediation as Record<string, unknown> | undefined;
      if (autoRemediation) {
        logger.info('[extractIssuesFromPlan] autoRemediation found:', Object.keys(autoRemediation));
        const fixedCount = autoRemediation.fixedCount as number || 0;
        const fixedItems = autoRemediation.fixed as unknown[] || autoRemediation.items as unknown[] || [];
        
        if (Array.isArray(fixedItems) && fixedItems.length > 0) {
          logger.info('[extractIssuesFromPlan] autoRemediation fixed items:', fixedItems.length);
          for (const item of fixedItems) {
            const f = item as Record<string, unknown>;
            // Only add if not already in autoFixedIssues
            const alreadyAdded = autoFixedIssues.some((a: any) => a.id === f.id || a.criterion === f.code);
            if (!alreadyAdded) {
              autoFixedIssues.push({
                id: f.id || f.code,
                criterion: f.wcagCriterion || f.criterion || f.code || 'Unknown',
                title: f.title || f.name || f.code || 'Fixed Issue',
                severity: f.severity || 'moderate',
                description: f.description || f.message || 'Issue was automatically fixed',
                location: f.location || f.file,
                fixApplied: (f.fix || f.resolution || 'Auto-fixed') as string,
              });
            }
          }
        }
      }

      // Fallback: Try tasks array if no combinedIssues
      if (autoFixedIssues.length === 0 && quickFixIssues.length === 0 && manualIssues.length === 0) {
        const tasks = (plan.tasks || plan.remediationTasks) as unknown[] | undefined;
        if (tasks && Array.isArray(tasks)) {
          logger.info('[extractIssuesFromPlan] Fallback to tasks:', tasks.length);
          for (const task of tasks) {
            const t = task as Record<string, unknown>;
            const status = (t.status as string)?.toLowerCase();
            const classification = (t.classification as string)?.toLowerCase();

            const issueData = {
              id: t.id,
              criterion: t.wcagCriterion || t.criterion || t.issueCode || 'Unknown',
              title: t.title || t.name || t.issueCode || 'Accessibility Issue',
              severity: t.severity || t.priority || 'moderate',
              description: t.description || t.message || 'No description available',
              location: t.location || t.filePath,
            };

            if (status === 'completed' || classification === 'autofix') {
              autoFixedIssues.push({ ...issueData, fixApplied: (t.resolution || 'Auto-fixed') as string });
            } else if (classification === 'quickfix') {
              quickFixIssues.push({ ...issueData, suggestedFix: (t.suggestedFix || 'Quick-fix available') as string });
            } else {
              manualIssues.push({ ...issueData, guidance: (t.guidance || 'Manual review required') as string });
            }
          }
        }
      }
    }

    // Fallback to audit results if no issues found from plan
    if (autoFixedIssues.length === 0 && quickFixIssues.length === 0 && auditResults && typeof auditResults === 'object') {
      const audit = auditResults as Record<string, unknown>;
      logger.info('[extractIssuesFromPlan] Falling back to audit results, keys:', Object.keys(audit));
      
      const issues = (audit.issues || audit.violations || audit.errors || audit.findings) as unknown[] | undefined;
      logger.info('[extractIssuesFromPlan] Audit issues found:', issues ? issues.length : 0);

      if (issues && Array.isArray(issues)) {
        for (const issue of issues) {
          const i = issue as Record<string, unknown>;
          const fixable = i.autoFixable || i.fixable || i.canAutoFix;
          const issueData = {
            criterion: i.wcagCriterion || i.criterion || i.code || 'Unknown',
            title: i.title || i.name || i.code || 'Audit Issue',
            severity: i.severity || i.impact || 'moderate',
            description: i.description || i.message || 'No description available',
            location: i.location || i.element || i.path,
          };

          if (fixable === true || fixable === 'autofix') {
            autoFixedIssues.push({
              ...issueData,
              fixApplied: 'Auto-fixed during remediation',
            });
          } else if (fixable === 'quickfix' || fixable === 'quick') {
            quickFixIssues.push({
              ...issueData,
              suggestedFix: (i.suggestedFix || i.recommendation || 'Quick-fix available') as string,
            });
          } else {
            manualIssues.push({
              ...issueData,
              guidance: (i.guidance || i.recommendation || 'Manual review required') as string,
            });
          }
        }
      }
    }

    logger.info('[extractIssuesFromPlan] Extraction complete:', {
      autoFixed: autoFixedIssues.length,
      quickFix: quickFixIssues.length,
      manual: manualIssues.length,
    });

    return { autoFixedIssues, quickFixIssues, manualIssues };
  }
}

export const batchController = new BatchController();
