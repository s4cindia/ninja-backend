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

      let remediationResults = null;
      if (planResults) {
        remediationResults = planResults;
      }

      const quickFixCount = file.issuesQuickFix || 0;
      const manualCount = file.issuesManual || 0;

      const response = {
        id: file.id,
        batchId: file.batchId,
        fileName: file.fileName,
        originalName: file.originalName,
        status: file.status,
        auditScore: file.auditScore,
        issuesFound: file.issuesFound,
        issuesAutoFixed: file.issuesAutoFixed,
        issuesQuickFix: file.issuesQuickFix,
        issuesManual: file.issuesManual,
        quickFixCount: quickFixCount,
        manualCount: manualCount,
        originalS3Key: file.storagePath,
        remediatedS3Key: file.remediatedFilePath,
        auditJobId: file.auditJobId,
        planJobId: file.planJobId,
        auditResults: auditResults,
        planResults: planResults,
        remediationResults: remediationResults,
        autoFixedIssues: this.extractAutoFixedIssues(remediationResults),
        quickFixIssues: [],
        manualIssues: [],
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

  private extractAutoFixedIssues(remediationResults: unknown): unknown[] {
    if (!remediationResults || typeof remediationResults !== 'object') {
      return [];
    }

    const results = remediationResults as Record<string, unknown>;
    const fixedIssues = results.fixedIssues as unknown[] | undefined;

    if (!fixedIssues || !Array.isArray(fixedIssues)) {
      return [];
    }

    return fixedIssues.map((issue: unknown) => {
      const i = issue as Record<string, unknown>;
      return {
        criterion: i.wcagCriterion || i.criterion,
        title: i.title || i.name,
        severity: i.severity || 'moderate',
        description: i.description || i.message,
        fixApplied: i.fix || i.remediation || 'Auto-fixed',
      };
    });
  }

  private extractQuickFixIssues(quickFixTasks: unknown[]): unknown[] {
    if (!quickFixTasks || !Array.isArray(quickFixTasks)) {
      return [];
    }

    return quickFixTasks.map((task: unknown) => {
      const t = task as Record<string, unknown>;
      return {
        criterion: t.wcagCriterion || t.criterion,
        title: t.title || t.name,
        severity: t.severity || 'moderate',
        description: t.description || t.message,
        suggestedFix: t.suggestedFix || t.fix || 'Quick-fix available',
      };
    });
  }

  private extractManualIssues(manualTasks: unknown[]): unknown[] {
    if (!manualTasks || !Array.isArray(manualTasks)) {
      return [];
    }

    return manualTasks.map((task: unknown) => {
      const t = task as Record<string, unknown>;
      return {
        criterion: t.wcagCriterion || t.criterion,
        title: t.title || t.name,
        severity: t.severity || 'critical',
        description: t.description || t.message,
        guidance: t.guidance || t.recommendation || 'Manual review required',
      };
    });
  }
}

export const batchController = new BatchController();
