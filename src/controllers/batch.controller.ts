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
        issuesAutoFixed: autoFixedIssues.length,
        issuesQuickFix: quickFixIssues.length,
        issuesManual: manualIssues.length,
        remainingQuickFix: quickFixIssues.filter((i: Record<string, unknown>) => i.status !== 'completed').length,
        remainingManual: manualIssues.filter((i: Record<string, unknown>) => i.status !== 'completed').length,
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

    const plan = (planResults && typeof planResults === 'object') ? planResults as Record<string, unknown> : null;
    const audit = (auditResults && typeof auditResults === 'object') ? auditResults as Record<string, unknown> : null;

    if (!plan && !audit) {
      logger.warn('[extractIssuesFromPlan] No plan or audit results');
      return { autoFixedIssues, quickFixIssues, manualIssues };
    }

    // Get expected stats for logging
    const autoRemediation = plan?.autoRemediation as Record<string, unknown> | undefined;
    const expectedStats = {
      autoFixed: (autoRemediation?.totalIssuesFixed as number) || 0,
      quickFix: (autoRemediation?.quickFixPending as number) || 0,
      manual: (autoRemediation?.manualPending as number) || 0,
    };
    logger.info('[extractIssuesFromPlan] Expected stats:', expectedStats);

    // Get combined issues
    const combinedIssues = (plan?.combinedIssues || audit?.combinedIssues || audit?.issues) as unknown[] | undefined;

    if (!combinedIssues || !Array.isArray(combinedIssues) || combinedIssues.length === 0) {
      logger.warn('[extractIssuesFromPlan] No combinedIssues found');
      return { autoFixedIssues, quickFixIssues, manualIssues };
    }

    logger.info(`[extractIssuesFromPlan] Processing ${combinedIssues.length} issues`);

    // Process each issue - classify by code pattern
    for (const issue of combinedIssues) {
      const i = issue as Record<string, unknown>;
      const issueCode = (i.code || i.issueCode) as string;

      const mappedIssue = {
        id: i.id || `issue-${issueCode}`,
        code: issueCode,
        criterion: this.extractCriterion(issueCode) || (i.wcagCriterion as string) || (i.criterion as string) || 'Unknown',
        title: (i.title || i.name || i.message || issueCode || 'Accessibility Issue') as string,
        severity: (i.severity || i.impact || 'moderate') as string,
        description: (i.description || i.message || 'No description available') as string,
        location: i.location || i.file || i.element || i.filePath,
        filePath: i.filePath || null,
      };

      // Classify by issue code pattern
      if (this.isAutoFixableCode(issueCode)) {
        autoFixedIssues.push({
          ...mappedIssue,
          status: 'completed',
          fixedBy: 'auto',
          fixedAt: new Date().toISOString(),
          fixApplied: 'Automatically fixed by system',
          autoFixable: true,
          quickFixable: false,
        });
      } else if (this.isQuickFixableCode(issueCode)) {
        quickFixIssues.push({
          ...mappedIssue,
          status: 'pending',
          fixedBy: null,
          suggestedFix: (i.suggestedFix || i.recommendation || 'Quick-fix template available') as string,
          autoFixable: false,
          quickFixable: true,
        });
      } else {
        manualIssues.push({
          ...mappedIssue,
          status: 'pending',
          fixedBy: null,
          guidance: (i.guidance || i.recommendation || i.help || 'Manual review required') as string,
          autoFixable: false,
          quickFixable: false,
        });
      }
    }

    logger.info('[extractIssuesFromPlan] Extraction complete:', {
      autoFixed: autoFixedIssues.length,
      quickFix: quickFixIssues.length,
      manual: manualIssues.length,
      total: autoFixedIssues.length + quickFixIssues.length + manualIssues.length,
    });

    return { autoFixedIssues, quickFixIssues, manualIssues };
  }

  private isAutoFixableCode(code: string): boolean {
    if (!code) return false;
    
    // Exclude codes that represent failed auto-fix attempts
    const excludedCodes = [
      'EPUB-STRUCT-004',  // "Could not add main landmark - no suitable element found"
    ];
    if (excludedCodes.includes(code)) {
      return false;
    }

    const autoFixablePrefixes = [
      'EPUB-META-',
      'EPUB-IMG-',
      'EPUB-SEM-',
      'EPUB-STRUCT-',
      'EPUB-NAV-',
      'EPUB-FIG-',
    ];
    return autoFixablePrefixes.some(prefix => code.startsWith(prefix));
  }

  private isQuickFixableCode(code: string): boolean {
    if (!code) return false;
    
    // Exclude failed auto-fix codes from quick-fix too (they go to manual)
    const excludedCodes = [
      'EPUB-STRUCT-004',
    ];
    if (excludedCodes.includes(code)) {
      return false;
    }

    const quickFixablePrefixes = [
      'METADATA-',
      'ACC-',
    ];
    return quickFixablePrefixes.some(prefix => code.startsWith(prefix));
  }

  /**
   * Helper: Extract WCAG criterion from issue code
   */
  private extractCriterion(code: string): string {
    if (!code) return 'Unknown';
    
    // Extract pattern like "1.1.1" from codes like "EPUB-IMG-001" or "wcag111"
    const match = code.match(/(\d+\.\d+\.\d+)/);
    if (match) return match[1];

    // Map common prefixes to WCAG criteria
    const criterionMap: Record<string, string> = {
      'EPUB-IMG': '1.1.1',      // Non-text content
      'EPUB-META': '3.1.1',     // Language of page
      'EPUB-STRUCT': '1.3.1',   // Info and relationships
      'EPUB-SEM': '4.1.2',      // Name, role, value
      'EPUB-NAV': '2.4.1',      // Bypass blocks
      'EPUB-FIG': '1.1.1',      // Non-text content (figures)
      'METADATA': '3.1.1',      // Language
      'OPF': '4.1.1',           // Parsing
      'RSC': '4.1.1',           // Resource issues
      'NCX': '2.4.5',           // Multiple ways
      'ACC': '1.1.1',           // Accessibility general
    };

    for (const [prefix, criterion] of Object.entries(criterionMap)) {
      if (code.startsWith(prefix)) return criterion;
    }

    return 'Unknown';
  }

  /**
   * Apply quick-fixes to a specific batch file with user-provided values
   * POST /api/v1/batch/:batchId/files/:fileId/apply-quick-fixes
   */
  async applyBatchFileQuickFixes(req: AuthenticatedRequest, res: Response) {
    try {
      const { batchId, fileId } = req.params;
      const { quickFixes } = req.body;
      const tenantId = req.user!.tenantId;

      if (!quickFixes || !Array.isArray(quickFixes) || quickFixes.length === 0) {
        return res.status(400).json({
          success: false,
          error: {
            message: 'quickFixes array is required and must not be empty',
            code: 'INVALID_REQUEST',
          },
        });
      }

      // Validate each quick-fix entry
      for (const fix of quickFixes) {
        if (!fix.issueCode || typeof fix.issueCode !== 'string') {
          return res.status(400).json({
            success: false,
            error: {
              message: 'Each quick-fix must have an issueCode',
              code: 'INVALID_ISSUE_CODE',
            },
          });
        }
        if (!fix.value || typeof fix.value !== 'string') {
          return res.status(400).json({
            success: false,
            error: {
              message: `Missing value for issueCode: ${fix.issueCode}`,
              code: 'INVALID_VALUE',
            },
          });
        }
      }

      const result = await batchQuickFixService.applyQuickFixesToFile(
        batchId,
        fileId,
        tenantId,
        quickFixes
      );

      if (result.success) {
        return res.json({
          success: true,
          data: {
            message: `Applied ${result.appliedFixes} quick-fixes`,
            appliedFixes: result.appliedFixes,
            results: result.results,
          },
        });
      } else {
        return res.status(207).json({
          success: false,
          data: {
            message: `Partially applied ${result.appliedFixes} quick-fixes`,
            appliedFixes: result.appliedFixes,
            results: result.results,
          },
        });
      }
    } catch (error) {
      logger.error('Failed to apply quick-fixes to batch file:', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: {
          message: error instanceof Error ? error.message : 'Failed to apply quick-fixes',
          code: 'QUICK_FIX_FAILED',
        },
      });
    }
  }

  /**
   * Batch apply all quick-fixes to a specific batch file using default values
   * POST /api/v1/batch/:batchId/files/:fileId/batch-apply-quick-fixes
   */
  async batchApplyAllQuickFixes(req: AuthenticatedRequest, res: Response) {
    try {
      const { batchId, fileId } = req.params;
      const tenantId = req.user!.tenantId;

      logger.info(`[POST /batch/${batchId}/files/${fileId}/batch-apply-quick-fixes]`);

      const result = await batchQuickFixService.batchApplyAllQuickFixes(
        batchId,
        fileId,
        tenantId
      );

      if (result.appliedFixes === 0) {
        return res.json({
          success: true,
          data: {
            message: 'No quick-fixes to apply',
            appliedFixes: 0,
            results: [],
          },
        });
      }

      if (result.success) {
        return res.json({
          success: true,
          data: {
            message: `Successfully batch applied ${result.appliedFixes} quick-fixes`,
            appliedFixes: result.appliedFixes,
            results: result.results,
          },
        });
      } else {
        return res.status(207).json({
          success: false,
          data: {
            message: `Partially applied ${result.appliedFixes} quick-fixes`,
            appliedFixes: result.appliedFixes,
            results: result.results,
          },
        });
      }
    } catch (error) {
      logger.error('Failed to batch apply quick-fixes:', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: {
          message: error instanceof Error ? error.message : 'Failed to batch apply quick-fixes',
          code: 'BATCH_QUICK_FIX_FAILED',
        },
      });
    }
  }
}

export const batchController = new BatchController();
