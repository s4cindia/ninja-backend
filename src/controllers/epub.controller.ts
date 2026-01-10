import { Request, Response } from 'express';
import * as fs from 'fs';
import { FileStatus } from '@prisma/client';
import { epubAuditService } from '../services/epub/epub-audit.service';
import { remediationService } from '../services/epub/remediation.service';
import { autoRemediationService } from '../services/epub/auto-remediation.service';
import { fileStorageService } from '../services/storage/file-storage.service';
import { epubModifier } from '../services/epub/epub-modifier.service';
import { epubComparisonService } from '../services/epub/epub-comparison.service';
import { batchRemediationService } from '../services/epub/batch-remediation.service';
import { epubExportService } from '../services/epub/epub-export.service';
import { s3Service } from '../services/s3.service';
import prisma from '../lib/prisma';
import { logger } from '../lib/logger';
import { getAllSnapshots, clearSnapshots } from '../utils/issue-flow-logger';
import { AuthenticatedRequest } from '../types/authenticated-request';
import { ComparisonService, mapFixTypeToChangeType, extractWcagCriteria, extractWcagLevel } from '../services/comparison';

const comparisonService = new ComparisonService(prisma);

export const epubController = {
  async auditEPUB(req: Request, res: Response) {
    try {
      const job = req.job;
      const { jobId } = req.params;

      if (!job) {
        return res.status(404).json({
          success: false,
          error: 'Job not found or access denied',
        });
      }

      if (job.type !== 'EPUB_ACCESSIBILITY') {
        return res.status(400).json({
          success: false,
          error: 'Job is not an EPUB accessibility audit',
        });
      }

      const input = job.input as { filePath?: string; fileName?: string; buffer?: string };
      if (!input.buffer) {
        return res.status(400).json({
          success: false,
          error: 'No EPUB file buffer found in job input',
        });
      }

      const buffer = Buffer.from(input.buffer, 'base64');
      const fileName = input.fileName || 'document.epub';

      await prisma.job.update({
        where: { id: jobId },
        data: { status: 'PROCESSING', startedAt: new Date() },
      });

      const result = await epubAuditService.runAudit(buffer, jobId, fileName);

      return res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      logger.error('EPUB audit failed', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: 'EPUB audit failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  },

  async auditFromBuffer(req: AuthenticatedRequest, res: Response) {
    const tenantId = req.user?.tenantId;
    const userId = req.user?.id;
    let jobId: string | undefined;

    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: 'No EPUB file uploaded',
        });
      }

      if (!tenantId || !userId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        });
      }

      const job = await prisma.job.create({
        data: {
          tenantId,
          userId,
          type: 'EPUB_ACCESSIBILITY',
          status: 'PROCESSING',
          input: {
            fileName: req.file.originalname,
            mimeType: req.file.mimetype,
            size: req.file.size,
          },
          startedAt: new Date(),
        },
      });
      jobId = job.id;

      await fileStorageService.saveFile(job.id, req.file.originalname, req.file.buffer);

      const result = await epubAuditService.runAudit(
        req.file.buffer,
        job.id,
        req.file.originalname
      );

      await prisma.job.update({
        where: { id: job.id },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          output: JSON.parse(JSON.stringify(result)),
        },
      });

      try {
        await remediationService.createRemediationPlan(job.id);
        logger.info(`Auto-created remediation plan for job ${job.id}`);
      } catch (remediationError) {
        logger.warn(`Failed to auto-create remediation plan for job ${job.id}: ${remediationError instanceof Error ? remediationError.message : 'Unknown error'}`);
      }

      return res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      logger.error('EPUB audit from buffer failed', error instanceof Error ? error : undefined);

      if (jobId) {
        await prisma.job.update({
          where: { id: jobId },
          data: {
            status: 'FAILED',
            completedAt: new Date(),
            error: error instanceof Error ? error.message : 'Unknown error',
          },
        }).catch(() => {});
      }

      return res.status(500).json({
        success: false,
        error: 'EPUB audit failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  },

  async auditFromFileId(req: AuthenticatedRequest, res: Response) {
    const tenantId = req.user?.tenantId;
    const userId = req.user?.id;
    const { fileId } = req.body;
    let previousFileStatus: FileStatus | null = null;

    try {
      if (!tenantId || !userId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        });
      }

      if (!fileId) {
        return res.status(400).json({
          success: false,
          error: 'fileId is required',
        });
      }

      const atomicUpdate = await prisma.file.updateMany({
        where: {
          id: fileId,
          tenantId,
          status: 'UPLOADED',
        },
        data: { status: 'PROCESSING' },
      });

      if (atomicUpdate.count === 0) {
        const existingFile = await prisma.file.findFirst({
          where: { id: fileId, tenantId },
        });

        if (!existingFile) {
          return res.status(404).json({
            success: false,
            error: 'File not found',
          });
        }

        return res.status(400).json({
          success: false,
          error: `File not ready for processing. Status: ${existingFile.status}`,
        });
      }

      previousFileStatus = FileStatus.UPLOADED;

      const fileRecord = await prisma.file.findUnique({
        where: { id: fileId },
      });

      if (!fileRecord) {
        await prisma.file.update({
          where: { id: fileId },
          data: { status: FileStatus.UPLOADED },
        }).catch(() => {});
        return res.status(500).json({
          success: false,
          error: 'File record not found after update',
        });
      }

      const job = await prisma.job.create({
        data: {
          tenantId,
          userId,
          type: 'EPUB_ACCESSIBILITY',
          status: 'QUEUED',
          input: {
            fileId: fileRecord.id,
            fileName: fileRecord.originalName,
            mimeType: fileRecord.mimeType,
            size: fileRecord.size,
            storageType: fileRecord.storageType,
            storagePath: fileRecord.storagePath,
          },
        },
      });

      res.status(202).json({
        success: true,
        data: {
          jobId: job.id,
          status: 'QUEUED',
          message: 'Audit job queued. Poll GET /api/v1/jobs/:jobId for status.',
        },
      });

      processAuditInBackground(job.id, fileRecord).catch((error) => {
        logger.error(`Background audit failed for job ${job.id}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      });

    } catch (error) {
      logger.error(`EPUB audit from fileId failed: ${error instanceof Error ? error.message : 'Unknown error'}`);

      // FIX 1: Roll back file status when request handler fails
      if (previousFileStatus) {
        await prisma.file.update({
          where: { id: fileId },
          data: { status: previousFileStatus },
        }).catch(() => {});
      }

      return res.status(500).json({
        success: false,
        error: 'EPUB audit failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  },

  async getAuditResult(req: Request, res: Response) {
    try {
      const job = req.job;

      if (!job) {
        return res.status(404).json({
          success: false,
          error: 'Job not found or access denied',
        });
      }

      if (job.status !== 'COMPLETED') {
        return res.json({
          success: true,
          data: {
            status: job.status,
            message: job.status === 'PROCESSING' ? 'Audit in progress' : 'Audit not started',
          },
        });
      }

      const output = job.output as Record<string, unknown> | null;
      const combinedIssues = output?.combinedIssues as Array<Record<string, unknown>> | undefined;

      logger.info('\nAPI RESPONSE - AUDIT RESULTS:');
      logger.info(`  Job ID: ${job.id}`);
      logger.info(`  Combined issues count: ${combinedIssues?.length || 0}`);

      if (combinedIssues && combinedIssues.length > 0) {
        const bySource: Record<string, number> = {};
        combinedIssues.forEach(issue => {
          const src = (issue.source as string) || 'unknown';
          bySource[src] = (bySource[src] || 0) + 1;
        });
        logger.info(`  By Source: ${JSON.stringify(bySource)}`);

        logger.info('  All issues being returned:');
        combinedIssues.forEach((issue, i) => {
          const code = issue.code as string || 'UNKNOWN';
          const source = issue.source as string || 'unknown';
          const location = issue.location as string || 'N/A';
          logger.info(`    ${i + 1}. [${source}] ${code} @ ${location}`);
        });
      }

      return res.json({
        success: true,
        data: job.output,
      });
    } catch (error) {
      logger.error('Failed to get audit result', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: 'Failed to retrieve audit result',
      });
    }
  },

  async createRemediationPlan(req: Request, res: Response) {
    const { jobId } = req.params;

    logger.info('\n' + '='.repeat(70));
    logger.info('API: CREATE REMEDIATION PLAN');
    logger.info('='.repeat(70));
    logger.info(`Job ID: ${jobId}`);

    clearSnapshots();

    try {
      const plan = await remediationService.createRemediationPlan(jobId);

      logger.info('\nFINAL VALIDATION:');
      logger.info(`  Plan total tasks: ${plan.stats.pending}`);
      logger.info(`  By Source: EPUBCheck=${plan.stats.bySource?.epubCheck || 0}, ACE=${plan.stats.bySource?.ace || 0}, JS Auditor=${plan.stats.bySource?.jsAuditor || 0}`);
      logger.info(`  By Classification: Auto=${plan.stats.autoFixable}, QuickFix=${plan.stats.quickFixable}, Manual=${plan.stats.manualRequired}`);

      logger.info('\nTASK TYPES IN RESPONSE:');
      plan.tasks.forEach((task, i) => {
        logger.info(`  ${i + 1}. [${task.type}] ${task.issueCode} @ ${task.location || 'N/A'}`);
      });

      if (plan.tallyValidation && !plan.tallyValidation.isValid) {
        logger.error('TALLY VALIDATION FAILED - Issues may be missing');
        logger.info('\nALL SNAPSHOTS:');
        getAllSnapshots().forEach(snap => {
          logger.info(`  ${snap.stage}: ${snap.count} issues`);
        });
      } else {
        logger.info(`All issues included in plan`);
      }

      const responseData = {
        jobId: plan.jobId,
        fileName: plan.fileName,
        totalIssues: plan.totalIssues,
        tasks: plan.tasks,
        stats: plan.stats,
        tally: {
          audit: plan.auditTally ? {
            total: plan.auditTally.grandTotal,
            bySource: plan.auditTally.bySource,
            bySeverity: plan.auditTally.bySeverity,
          } : null,
          plan: plan.planTally ? {
            total: plan.planTally.grandTotal,
            bySource: plan.planTally.bySource,
            byClassification: plan.planTally.byClassification,
          } : null,
          validation: plan.tallyValidation ? {
            isValid: plan.tallyValidation.isValid,
            errors: plan.tallyValidation.errors,
            discrepancies: plan.tallyValidation.discrepancies,
          } : null,
        },
        createdAt: plan.createdAt,
        updatedAt: plan.updatedAt,
        _debug: process.env.NODE_ENV === 'development' ? {
          snapshots: getAllSnapshots(),
        } : undefined,
      };

      return res.json({
        success: true,
        data: responseData,
      });
    } catch (error) {
      logger.error('Failed to create remediation plan', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create remediation plan',
      });
    }
  },

  async getRemediationPlan(req: Request, res: Response) {
    try {
      const { jobId } = req.params;
      const plan = await remediationService.getRemediationPlan(jobId);

      if (!plan) {
        return res.status(404).json({
          success: false,
          error: 'Remediation plan not found',
        });
      }

      return res.json({
        success: true,
        data: {
          jobId: plan.jobId,
          fileName: plan.fileName,
          totalIssues: plan.totalIssues,
          tasks: plan.tasks,
          stats: plan.stats,
          tally: {
            audit: plan.auditTally ? {
              total: plan.auditTally.grandTotal,
              bySource: plan.auditTally.bySource,
              bySeverity: plan.auditTally.bySeverity,
            } : null,
            plan: plan.planTally ? {
              total: plan.planTally.grandTotal,
              bySource: plan.planTally.bySource,
              byClassification: plan.planTally.byClassification,
            } : null,
            validation: plan.tallyValidation ? {
              isValid: plan.tallyValidation.isValid,
              errors: plan.tallyValidation.errors,
              discrepancies: plan.tallyValidation.discrepancies,
            } : null,
          },
          createdAt: plan.createdAt,
          updatedAt: plan.updatedAt,
        },
      });
    } catch (error) {
      logger.error('Failed to get remediation plan', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: 'Failed to get remediation plan',
      });
    }
  },

  async getRemediationSummary(req: Request, res: Response) {
    try {
      const { jobId } = req.params;
      const summary = await remediationService.getRemediationSummary(jobId);

      return res.json({
        success: true,
        data: summary,
      });
    } catch (error) {
      logger.error('Failed to get remediation summary', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get remediation summary',
      });
    }
  },

  async updateTaskStatus(req: Request, res: Response) {
    try {
      const { jobId, taskId } = req.params;
      const { status, resolution, resolvedBy, notes, completionMethod } = req.body;

      if (!status) {
        return res.status(400).json({
          success: false,
          error: 'Status is required',
        });
      }

      const task = await remediationService.updateTaskStatus(
        jobId,
        taskId,
        status,
        resolution,
        resolvedBy,
        { notes, completionMethod }
      );

      return res.json({
        success: true,
        data: task,
      });
    } catch (error) {
      logger.error('Failed to update task', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update task',
      });
    }
  },

  async markManualTaskFixed(req: AuthenticatedRequest, res: Response) {
    try {
      const { jobId, taskId } = req.params;
      const { notes, resolution } = req.body;
      const verifiedBy = req.user?.email || req.user?.id || 'user';

      const task = await remediationService.markManualTaskFixed(
        jobId,
        taskId,
        { notes, verifiedBy, resolution }
      );

      logger.info(`Manual task ${taskId} marked as fixed by ${verifiedBy}`);

      return res.json({
        success: true,
        data: task,
        message: 'Task marked as manually fixed',
      });
    } catch (error) {
      logger.error('Failed to mark task as fixed', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to mark task as fixed',
      });
    }
  },

  async reauditEpub(req: AuthenticatedRequest, res: Response) {
    try {
      const { jobId } = req.params;

      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: 'No EPUB file uploaded. Please upload the remediated EPUB file.',
        });
      }

      logger.info(`[Re-audit] Starting re-audit for job ${jobId}, file: ${req.file.originalname}`);

      const result = await remediationService.reauditEpub(jobId, {
        buffer: req.file.buffer,
        originalname: req.file.originalname,
      });

      logger.info(`[Re-audit] Completed: ${result.resolved} issues resolved, ${result.stillPending} still pending`);

      return res.json({
        success: true,
        data: result,
        message: `Re-audit complete: ${result.resolved} issues verified as fixed`,
      });
    } catch (error) {
      logger.error('Re-audit failed', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Re-audit failed',
      });
    }
  },

  async transferToAcr(req: AuthenticatedRequest, res: Response) {
    try {
      const { jobId } = req.params;

      const result = await remediationService.transferToAcr(jobId);

      logger.info(`[ACR Transfer] Job ${jobId}: ${result.transferredTasks} tasks transferred`);

      return res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      logger.error('ACR transfer failed', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to transfer to ACR workflow',
      });
    }
  },

  async getAcrWorkflow(req: AuthenticatedRequest, res: Response) {
    try {
      const { acrWorkflowId } = req.params;
      const tenantId = req.user?.tenantId;

      const workflow = await remediationService.getAcrWorkflow(acrWorkflowId, tenantId);

      if (!workflow) {
        return res.status(404).json({
          success: false,
          error: 'ACR workflow not found',
        });
      }

      return res.json({
        success: true,
        data: workflow,
      });
    } catch (error) {
      logger.error('Failed to get ACR workflow', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get ACR workflow',
      });
    }
  },

  async updateAcrCriteria(req: AuthenticatedRequest, res: Response) {
    try {
      const { acrWorkflowId, criteriaId } = req.params;
      const { status, notes } = req.body;
      const tenantId = req.user?.tenantId;
      const verifiedBy = req.user?.email || req.user?.id || 'user';

      if (!status || !['verified', 'failed', 'not_applicable'].includes(status)) {
        return res.status(400).json({
          success: false,
          error: 'Status must be one of: verified, failed, not_applicable',
        });
      }

      const result = await remediationService.updateAcrCriteriaStatus(
        acrWorkflowId,
        criteriaId,
        status,
        verifiedBy,
        notes,
        tenantId
      );

      return res.json({
        success: true,
        data: result,
        message: `Criteria ${criteriaId} updated to ${status}`,
      });
    } catch (error) {
      logger.error('Failed to update ACR criteria', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update ACR criteria',
      });
    }
  },

  async runAutoRemediation(req: AuthenticatedRequest, res: Response) {
    try {
      const { jobId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        });
      }

      const job = await prisma.job.findFirst({
        where: { id: jobId, tenantId },
      });

      if (!job) {
        return res.status(404).json({
          success: false,
          error: 'Job not found',
        });
      }

      const input = job.input as { fileName?: string } | null;
      const fileName = input?.fileName || 'document.epub';

      const epubBuffer = await fileStorageService.getFile(jobId, fileName);
      if (!epubBuffer) {
        return res.status(400).json({
          success: false,
          error: 'EPUB file not found. File may have been deleted or not uploaded.',
        });
      }

      const result = await autoRemediationService.runAutoRemediation(
        epubBuffer,
        jobId,
        fileName
      );

      await fileStorageService.saveRemediatedFile(
        jobId,
        result.remediatedFileName,
        result.remediatedBuffer
      );

      return res.json({
        success: true,
        data: {
          jobId: result.jobId,
          originalFileName: result.originalFileName,
          remediatedFileName: result.remediatedFileName,
          totalIssuesFixed: result.totalIssuesFixed,
          totalIssuesFailed: result.totalIssuesFailed,
          modifications: result.modifications,
          downloadUrl: `/api/v1/epub/job/${jobId}/download-remediated`,
          startedAt: result.startedAt,
          completedAt: result.completedAt,
        },
      });
    } catch (error) {
      logger.error('Auto-remediation failed', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Auto-remediation failed',
      });
    }
  },

  async getSupportedFixes(_req: Request, res: Response) {
    try {
      const codes = autoRemediationService.getSupportedIssueCodes();

      return res.json({
        success: true,
        data: {
          supportedCodes: codes,
          descriptions: {
            'EPUB-META-001': 'Add missing language declaration',
            'EPUB-META-002': 'Add accessibility feature metadata',
            'EPUB-META-003': 'Add accessibility summary',
            'EPUB-META-004': 'Add access mode metadata',
            'EPUB-SEM-001': 'Add lang attribute to HTML elements',
            'EPUB-SEM-002': 'Fix empty links with aria-label',
            'EPUB-SEM-003': 'Add ARIA roles to epub:type elements',
            'EPUB-IMG-001': 'Mark images without alt as decorative',
            'EPUB-STRUCT-002': 'Add headers to simple tables',
            'EPUB-STRUCT-003': 'Fix heading hierarchy',
            'EPUB-STRUCT-004': 'Add ARIA landmarks',
            'EPUB-NAV-001': 'Add skip navigation links',
            'EPUB-NAV-002': 'Add unique aria-labels to navigation landmarks',
            'EPUB-FIG-001': 'Add figure/figcaption structure',
          },
        },
      });
    } catch (error) {
      logger.error('Failed to get supported fixes', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: 'Failed to get supported fixes',
      });
    }
  },

  async downloadRemediatedFile(req: AuthenticatedRequest, res: Response) {
    try {
      const { jobId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        });
      }

      const job = await prisma.job.findFirst({
        where: { id: jobId, tenantId },
      });

      if (!job) {
        return res.status(404).json({
          success: false,
          error: 'Job not found',
        });
      }

      const output = job.output as { autoRemediation?: { remediatedFileName?: string } } | null;
      const remediatedFileName = output?.autoRemediation?.remediatedFileName;

      if (!remediatedFileName) {
        return res.status(404).json({
          success: false,
          error: 'No remediated file available. Run auto-remediation first.',
        });
      }

      const fileBuffer = await fileStorageService.getRemediatedFile(jobId, remediatedFileName);
      if (!fileBuffer) {
        return res.status(404).json({
          success: false,
          error: 'Remediated file not found on disk',
        });
      }

      res.setHeader('Content-Type', 'application/epub+zip');
      res.setHeader('Content-Disposition', `attachment; filename="${remediatedFileName}"`);
      res.setHeader('Content-Length', fileBuffer.length);
      return res.send(fileBuffer);
    } catch (error) {
      logger.error('Failed to download remediated file', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: 'Failed to download remediated file',
      });
    }
  },

  async applySpecificFix(req: AuthenticatedRequest, res: Response) {
    try {
      const { jobId } = req.params;
      const { fixCode, options } = req.body;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        });
      }

      if (!fixCode) {
        return res.status(400).json({
          success: false,
          error: 'fixCode is required',
        });
      }

      const job = await prisma.job.findFirst({
        where: { id: jobId, tenantId },
      });

      if (!job) {
        return res.status(404).json({
          success: false,
          error: 'Job not found',
        });
      }

      const input = job.input as { fileName?: string };
      const originalFileName = input?.fileName || 'upload.epub';
      const remediatedFileName = originalFileName.replace(/\.epub$/i, '_remediated.epub');

      // Try to load from remediated file first (to preserve previous fixes)
      // Fall back to original if no remediated file exists yet
      let epubBuffer = await fileStorageService.getRemediatedFile(jobId, remediatedFileName);
      if (!epubBuffer) {
        epubBuffer = await fileStorageService.getFile(jobId, originalFileName);
      }

      if (!epubBuffer) {
        return res.status(404).json({
          success: false,
          error: 'EPUB file not found',
        });
      }

      const zip = await epubModifier.loadEPUB(epubBuffer);

      type ModificationResult = {
        success: boolean;
        filePath: string;
        modificationType: string;
        description: string;
        before?: string;
        after?: string;
      };
      let results: ModificationResult[] = [];

      switch (fixCode) {
        case 'EPUB-META-001':
          results = [await epubModifier.addLanguage(zip, options?.language)];
          break;
        case 'EPUB-META-002':
          results = await epubModifier.addAccessibilityMetadata(zip, options?.features);
          break;
        case 'EPUB-META-003':
          results = [await epubModifier.addAccessibilitySummary(zip, options?.summary)];
          break;
        case 'EPUB-SEM-001':
          results = await epubModifier.addHtmlLangAttributes(zip, options?.language);
          break;
        case 'EPUB-SEM-002':
          results = await epubModifier.fixEmptyLinks(zip);
          break;
        case 'EPUB-IMG-001':
          if (options?.imageAlts) {
            results = await epubModifier.addAltText(zip, options.imageAlts);
          } else {
            results = await epubModifier.addDecorativeAltAttributes(zip);
          }
          break;
        case 'EPUB-STRUCT-002':
          results = await epubModifier.addTableHeaders(zip);
          break;
        case 'EPUB-STRUCT-003':
          results = await epubModifier.fixHeadingHierarchy(zip);
          break;
        case 'EPUB-STRUCT-004':
          results = await epubModifier.addAriaLandmarks(zip);
          break;
        case 'EPUB-NAV-001':
          results = await epubModifier.addSkipNavigation(zip);
          break;
        case 'EPUB-FIG-001':
          results = await epubModifier.addFigureStructure(zip);
          break;
        case 'EPUB-SEM-003':
          // Add ARIA roles to epub:type elements (Quick Fix)
          if (options?.changes && Array.isArray(options.changes)) {
            const epubTypesToFix = options.changes.map((change: { epubType: string; role: string }) => ({
              epubType: change.epubType,
              role: change.role,
            }));
            results = await epubModifier.addAriaRolesToEpubTypes(zip, epubTypesToFix);
          } else {
            return res.status(400).json({
              success: false,
              error: 'EPUB-SEM-003 requires options.changes array with epubType and role',
            });
          }
          break;
        case 'EPUB-NAV-002':
          // Add aria-labels to nav landmarks (Quick Fix)
          results = await epubModifier.addNavAriaLabels(zip, {
            toc: options?.tocLabel,
            landmarks: options?.landmarksLabel,
            pageList: options?.pageListLabel,
          });
          break;
        default:
          return res.status(400).json({
            success: false,
            error: `Unknown fix code: ${fixCode}`,
          });
      }

      const modifiedBuffer = await epubModifier.saveEPUB(zip);
      await fileStorageService.saveRemediatedFile(jobId, remediatedFileName, modifiedBuffer);

      // Filter results to only the target file if specified (prevents logging duplicate changes)
      const targetFile = options?.targetFile;
      let resultsToLog = results.filter(r => r.success);
      
      if (targetFile) {
        // Normalize paths for comparison (remove leading slashes, handle OEBPS prefix)
        const normalizeFilePath = (path: string) => {
          return path.replace(/^\/+/, '').replace(/^OEBPS\//, '');
        };
        const normalizedTarget = normalizeFilePath(targetFile);
        resultsToLog = resultsToLog.filter(r => normalizeFilePath(r.filePath) === normalizedTarget || r.filePath.includes(normalizedTarget) || normalizedTarget.includes(r.filePath.replace('OEBPS/', '')));
        logger.info(`[SPECIFIC-FIX] Filtering to target file: ${targetFile}, matched ${resultsToLog.length} of ${results.filter(r => r.success).length} results`);
      }
      
      // Check for existing changes to prevent duplicates
      const existingChanges = await prisma.remediationChange.findMany({
        where: { jobId, ruleId: fixCode },
        select: { filePath: true }
      });
      const existingFilePaths = new Set(existingChanges.map(c => c.filePath));
      const newResultsToLog = resultsToLog.filter(r => !existingFilePaths.has(r.filePath));
      
      if (newResultsToLog.length < resultsToLog.length) {
        logger.info(`[SPECIFIC-FIX] Skipping ${resultsToLog.length - newResultsToLog.length} already logged changes`);
      }
      
      logger.info(`[SPECIFIC-FIX] Logging ${newResultsToLog.length} new changes for fixCode: ${fixCode}`);
      
      for (const result of newResultsToLog) {
        try {
          await comparisonService.logChange({
            jobId,
            ruleId: fixCode,
            filePath: result.filePath,
            changeType: fixCode.toLowerCase().replace(/-/g, '_'),
            description: result.description,
            beforeContent: result.before,
            afterContent: result.after,
            severity: 'MAJOR',
            wcagCriteria: extractWcagCriteria(fixCode),
            wcagLevel: extractWcagLevel(fixCode),
            appliedBy: req.user?.email || 'user',
          });
          logger.info(`[SPECIFIC-FIX] Logged change for ${result.filePath}`);
        } catch (logError) {
          logger.error('[SPECIFIC-FIX] Failed to log change', { 
            error: logError instanceof Error ? logError.message : logError,
            jobId,
            filePath: result.filePath
          });
        }
      }

      return res.json({
        success: true,
        data: {
          fixCode,
          results,
          changesLogged: newResultsToLog.length,
          downloadUrl: `/api/v1/epub/job/${jobId}/download-remediated`,
        },
      });
    } catch (error) {
      logger.error('Failed to apply specific fix', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to apply fix',
      });
    }
  },

  async getComparison(req: AuthenticatedRequest, res: Response) {
    try {
      const { jobId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        });
      }

      const job = await prisma.job.findFirst({
        where: { id: jobId, tenantId },
      });

      if (!job) {
        return res.status(404).json({
          success: false,
          error: 'Job not found',
        });
      }

      const input = job.input as { fileName?: string };
      const fileName = input?.fileName || 'upload.epub';
      const remediatedFileName = fileName.replace(/\.epub$/i, '_remediated.epub');

      const originalBuffer = await fileStorageService.getFile(jobId, fileName);
      const remediatedBuffer = await fileStorageService.getRemediatedFile(jobId, remediatedFileName);

      if (!originalBuffer || !remediatedBuffer) {
        return res.status(404).json({
          success: false,
          error: 'Both original and remediated files required',
        });
      }

      const comparison = await epubComparisonService.compareEPUBs(
        originalBuffer,
        remediatedBuffer,
        jobId,
        fileName
      );

      return res.json({
        success: true,
        data: comparison,
      });
    } catch (error) {
      logger.error('Failed to generate comparison', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to generate comparison',
      });
    }
  },

  async getComparisonSummary(req: AuthenticatedRequest, res: Response) {
    try {
      const { jobId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        });
      }

      const job = await prisma.job.findFirst({
        where: { id: jobId, tenantId },
      });

      if (!job) {
        return res.status(404).json({
          success: false,
          error: 'Job not found',
        });
      }

      const input = job.input as { fileName?: string };
      const fileName = input?.fileName || 'upload.epub';
      const remediatedFileName = fileName.replace(/\.epub$/i, '_remediated.epub');

      const originalBuffer = await fileStorageService.getFile(jobId, fileName);
      const remediatedBuffer = await fileStorageService.getRemediatedFile(jobId, remediatedFileName);

      if (!originalBuffer || !remediatedBuffer) {
        return res.status(404).json({
          success: false,
          error: 'Both original and remediated files required',
        });
      }

      const comparison = await epubComparisonService.compareEPUBs(
        originalBuffer,
        remediatedBuffer,
        jobId,
        fileName
      );

      return res.json({
        success: true,
        data: {
          jobId: comparison.jobId,
          originalFileName: comparison.originalFileName,
          remediatedFileName: comparison.remediatedFileName,
          summary: comparison.summary,
          modifications: comparison.modifications,
          generatedAt: comparison.generatedAt,
        },
      });
    } catch (error) {
      logger.error('Failed to generate comparison summary', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to generate comparison',
      });
    }
  },

  async createBatch(req: AuthenticatedRequest, res: Response) {
    try {
      const { jobIds, options } = req.body;
      const tenantId = req.user?.tenantId;
      const userId = req.user?.id;

      if (!tenantId || !userId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        });
      }

      if (!jobIds || !Array.isArray(jobIds) || jobIds.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'jobIds array is required',
        });
      }

      if (jobIds.length > 100) {
        return res.status(400).json({
          success: false,
          error: 'Maximum 100 jobs per batch',
        });
      }

      const batch = await batchRemediationService.createBatch(
        jobIds,
        tenantId,
        userId,
        options || {}
      );

      return res.status(201).json({
        success: true,
        data: batch,
      });
    } catch (error) {
      logger.error('Failed to create batch', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create batch',
      });
    }
  },

  async startBatch(req: AuthenticatedRequest, res: Response) {
    try {
      const { batchId } = req.params;
      const { options } = req.body;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        });
      }

      const batch = await batchRemediationService.getBatchStatus(batchId, tenantId);

      if (!batch) {
        return res.status(404).json({
          success: false,
          error: 'Batch not found',
        });
      }

      if (batch.status !== 'pending') {
        return res.status(400).json({
          success: false,
          error: `Batch cannot be started (status: ${batch.status})`,
        });
      }

      batchRemediationService.processBatch(batchId, tenantId, options || {})
        .catch(err => logger.error(`Batch ${batchId} processing error`, err));

      return res.json({
        success: true,
        data: { ...batch, status: 'processing' },
        message: 'Batch processing started',
      });
    } catch (error) {
      logger.error('Failed to start batch', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to start batch',
      });
    }
  },

  async getBatchStatus(req: AuthenticatedRequest, res: Response) {
    try {
      const { batchId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        });
      }

      const batch = await batchRemediationService.getBatchStatus(batchId, tenantId);

      if (!batch) {
        return res.status(404).json({
          success: false,
          error: 'Batch not found',
        });
      }

      return res.json({
        success: true,
        data: batch,
      });
    } catch (error) {
      logger.error('Failed to get batch status', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get batch status',
      });
    }
  },

  async cancelBatch(req: AuthenticatedRequest, res: Response) {
    try {
      const { batchId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        });
      }

      const batch = await batchRemediationService.cancelBatch(batchId, tenantId);

      return res.json({
        success: true,
        data: batch,
        message: 'Batch cancelled',
      });
    } catch (error) {
      logger.error('Failed to cancel batch', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to cancel batch',
      });
    }
  },

  async retryBatchJob(req: AuthenticatedRequest, res: Response) {
    try {
      const { batchId, jobId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
      }

      const job = await batchRemediationService.retryJob(batchId, jobId, tenantId);

      return res.json({
        success: true,
        data: job,
        message: 'Job retry completed',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to retry job';
      logger.error(`Failed to retry batch job: ${message}`);
      return res.status(400).json({
        success: false,
        error: message,
      });
    }
  },

  async listBatches(req: AuthenticatedRequest, res: Response) {
    try {
      const tenantId = req.user?.tenantId;
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;

      if (!tenantId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        });
      }

      if (limit < 1 || limit > 100) {
        return res.status(400).json({
          success: false,
          error: 'Limit must be between 1 and 100',
        });
      }

      const { batches, total } = await batchRemediationService.listBatches(
        tenantId,
        page,
        limit
      );

      return res.json({
        success: true,
        data: {
          batches,
          total,
          page,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      logger.error('Failed to list batches', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list batches',
      });
    }
  },

  async exportRemediated(req: AuthenticatedRequest, res: Response) {
    try {
      const { jobId } = req.params;
      const tenantId = req.user?.tenantId;
      const includeOriginal = req.query.includeOriginal === 'true';
      const includeComparison = req.query.includeComparison === 'true';
      const includeReport = req.query.includeReport === 'true';

      if (!tenantId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        });
      }

      const result = await epubExportService.exportRemediated(jobId, tenantId, {
        includeOriginal,
        includeComparison,
        includeReport,
      });

      res.setHeader('Content-Type', result.mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="${result.fileName}"`);
      res.setHeader('Content-Length', result.size);

      return res.send(result.buffer);
    } catch (error) {
      logger.error('Failed to export remediated EPUB', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to export',
      });
    }
  },

  async exportBatch(req: AuthenticatedRequest, res: Response) {
    try {
      const { jobIds, options } = req.body;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        });
      }

      if (!jobIds || !Array.isArray(jobIds) || jobIds.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'jobIds array is required',
        });
      }

      if (jobIds.length > 100) {
        return res.status(400).json({
          success: false,
          error: 'Maximum 100 jobs per export',
        });
      }

      const result = await epubExportService.exportBatch(jobIds, tenantId, options || {});

      res.setHeader('Content-Type', result.mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="${result.fileName}"`);
      res.setHeader('Content-Length', result.size);

      return res.send(result.buffer);
    } catch (error) {
      logger.error('Failed to export batch', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to export batch',
      });
    }
  },

  async getAccessibilityReport(req: AuthenticatedRequest, res: Response) {
    try {
      const { jobId } = req.params;
      const tenantId = req.user?.tenantId;
      const format = req.query.format as string || 'json';

      if (!tenantId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        });
      }

      const report = await epubExportService.generateAccessibilityReport(jobId, tenantId);

      if (format === 'md' || format === 'markdown') {
        const md = epubExportService.generateReportMarkdown(report);
        res.setHeader('Content-Type', 'text/markdown');
        return res.send(md);
      }

      return res.json({
        success: true,
        data: report,
      });
    } catch (error) {
      logger.error('Failed to generate report', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to generate report',
      });
    }
  },

  async applyQuickFix(req: AuthenticatedRequest, res: Response) {
    try {
      const { jobId } = req.params;
      const { issueId, changes, fixCode, taskId, options } = req.body;
      const tenantId = req.user?.tenantId;

      logger.debug(`applyQuickFix called: jobId=${jobId}, fixCode=${fixCode}, taskId=${taskId}, issueId=${issueId}`);

      if (!tenantId) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
      }

      const job = await prisma.job.findFirst({ where: { id: jobId, tenantId } });
      if (!job) {
        return res.status(404).json({ success: false, error: 'Job not found' });
      }

      const input = job.input as { fileName?: string };
      const originalFileName = input?.fileName || 'upload.epub';
      const remediatedFileName = originalFileName.replace(/\.epub$/i, '_remediated.epub');

      let epubBuffer = await fileStorageService.getRemediatedFile(jobId, remediatedFileName);
      if (!epubBuffer) {
        epubBuffer = await fileStorageService.getFile(jobId, originalFileName);
      }

      if (!epubBuffer) {
        return res.status(404).json({ success: false, error: 'EPUB file not found' });
      }

      const zip = await epubModifier.loadEPUB(epubBuffer);

      type ModificationResult = {
        success: boolean;
        filePath: string;
        modificationType: string;
        description: string;
        before?: string;
        after?: string;
      };

      let results: ModificationResult[] = [];
      let modifiedFiles: string[] = [];
      let hasErrors = false;

      const epubTypesToFix: Array<{ epubType: string; role: string }> = [];

      if (fixCode === 'EPUB-SEM-003' || fixCode === 'EPUB-TYPE-HAS-MATCHING-ROLE') {
        if (options?.epubTypes && Array.isArray(options.epubTypes)) {
          epubTypesToFix.push(...options.epubTypes);
        } else if (options?.epubType && options?.role) {
          epubTypesToFix.push({ epubType: options.epubType, role: options.role });
        }
      }

      if (changes && Array.isArray(changes)) {
        for (const change of changes) {
          const epubTypeMatch = change.oldContent?.match(/epub:type="([^"]+)"/);
          const roleMatch = change.content?.match(/role="([^"]+)"/) || change.newContent?.match(/role="([^"]+)"/);

          if (epubTypeMatch && roleMatch) {
            const epubType = epubTypeMatch[1];
            const role = roleMatch[1];

            if (!epubTypesToFix.find(e => e.epubType === epubType)) {
              epubTypesToFix.push({ epubType, role });
            }
          }
        }
      }

      if (epubTypesToFix.length > 0) {
        logger.debug(`Using EPUB-TYPE case with regex method: ${epubTypesToFix.length} types to fix`);

        results = await epubModifier.addAriaRolesToEpubTypes(zip, epubTypesToFix);
        logger.debug(`addAriaRolesToEpubTypes completed: ${results.length} modifications`);

        if (results.length > 0) {
          const modifiedBuffer = await epubModifier.saveEPUB(zip);
          await fileStorageService.saveRemediatedFile(jobId, remediatedFileName, modifiedBuffer);

          for (const result of results.filter(r => r.success)) {
            try {
              await comparisonService.logChange({
                jobId,
                taskId: taskId || undefined,
                issueId: issueId || undefined,
                ruleId: fixCode || 'EPUB-SEM-003',
                filePath: result.filePath,
                changeType: 'add-aria-role',
                description: result.description,
                beforeContent: result.before,
                afterContent: result.after,
                severity: 'MAJOR',
                wcagCriteria: '4.1.2',
                wcagLevel: 'A',
                appliedBy: req.user?.email || 'user',
              });
            } catch (logError) {
              logger.warn('Failed to log remediation change', { error: logError, jobId });
            }
          }
        }

        let tasksAutoCompleted = 0;
        try {
          const plan = await remediationService.getRemediationPlan(jobId);

          if (plan?.tasks && Array.isArray(plan.tasks)) {
            const relatedTasks = plan.tasks.filter((t: { status?: string; issueCode?: string; id?: string }) => {
              if (t.status === 'completed') return false;

              const issueCode = String(t.issueCode || '').toUpperCase();
              const isEpubTypeIssue =
                issueCode.includes('EPUB-TYPE') ||
                issueCode.includes('EPUB_TYPE') ||
                issueCode.includes('MATCHING-ROLE') ||
                issueCode.includes('MATCHING_ROLE') ||
                issueCode === 'EPUB-SEM-003';

              return isEpubTypeIssue;
            });

            logger.debug(`Found ${relatedTasks.length} epub:type tasks to auto-complete`);

            for (const task of relatedTasks) {
              try {
                await remediationService.updateTaskStatus(
                  jobId,
                  task.id,
                  'completed',
                  `Auto-completed: ARIA roles added to all epub:type elements`,
                  req.user?.email || 'system'
                );
                tasksAutoCompleted++;
                logger.debug(`Auto-completed task: ${task.id} (${task.issueCode})`);
              } catch (err) {
                logger.error(`Failed to auto-complete task ${task.id}`, err instanceof Error ? err : undefined);
              }
            }
          }
        } catch (err) {
          logger.error('Auto-complete error', err instanceof Error ? err : undefined);
        }

        logger.debug(`Total tasks auto-completed: ${tasksAutoCompleted}`);

        return res.json({
          success: true,
          data: {
            results,
            modificationsCount: results.length,
            tasksAutoCompleted,
            message: `Applied ${results.length} fixes, auto-completed ${tasksAutoCompleted} tasks`,
            downloadUrl: `/api/v1/epub/job/${jobId}/download-remediated`,
          },
        });
      }

      if (changes && Array.isArray(changes) && changes.length > 0) {
        logger.info(`Applying quick fix for job ${jobId}, issue ${issueId}`);
        logger.info(`Changes: ${JSON.stringify(changes, null, 2)}`);

        const result = await epubModifier.applyQuickFix(zip, changes, jobId, issueId);
        results = result.results;
        modifiedFiles = result.modifiedFiles;
        hasErrors = result.hasErrors;
      } else {
        return res.status(400).json({
          success: false,
          error: 'Either fixCode with options or changes array is required',
        });
      }

      if (modifiedFiles.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'No files were modified',
          data: { results },
        });
      }

      const modifiedBuffer = await epubModifier.saveEPUB(zip);
      await fileStorageService.saveRemediatedFile(jobId, remediatedFileName, modifiedBuffer);

      const successfulResults = results.filter(r => r.success);
      logger.info(`[QUICKFIX-LOG] Total results: ${results.length}, Successful: ${successfulResults.length}`);
      
      for (const result of successfulResults) {
        logger.info(`[QUICKFIX-LOG] Logging change for file: ${result.filePath}`);
        logger.info(`[QUICKFIX-LOG] changeType: ${mapFixTypeToChangeType(fixCode || 'quick-fix')}`);
        logger.info(`[QUICKFIX-LOG] description: ${result.description}`);
        logger.info(`[QUICKFIX-LOG] before length: ${result.before?.length || 0}, after length: ${result.after?.length || 0}`);
        
        try {
          const changeData = {
            jobId,
            taskId: taskId || undefined,
            issueId: issueId || undefined,
            ruleId: fixCode || undefined,
            filePath: result.filePath,
            changeType: mapFixTypeToChangeType(fixCode || 'quick-fix'),
            description: result.description,
            beforeContent: result.before,
            afterContent: result.after,
            severity: 'MAJOR' as const,
            wcagCriteria: extractWcagCriteria(fixCode || ''),
            wcagLevel: extractWcagLevel(fixCode || ''),
            appliedBy: req.user?.email || 'user',
          };
          logger.info(`[QUICKFIX-LOG] Calling comparisonService.logChange with: ${JSON.stringify(changeData, null, 2)}`);
          
          const logResult = await comparisonService.logChange(changeData);
          logger.info(`[QUICKFIX-LOG] logChange result: ${JSON.stringify(logResult)}`);
        } catch (logError) {
          logger.error('[QUICKFIX-LOG] Failed to log remediation change', { 
            error: logError instanceof Error ? logError.message : logError, 
            stack: logError instanceof Error ? logError.stack : undefined,
            jobId 
          });
        }
      }

      const successCount = results.filter(r => r.success).length;
      const failCount = results.filter(r => !r.success).length;

      let tasksUpdated = 0;
      if (successCount > 0) {
        try {
          const taskToUpdate = taskId || issueId;
          if (taskToUpdate) {
            const plan = await remediationService.getRemediationPlan(jobId);
            const task = plan?.tasks.find((t: { id?: string; issueId?: string }) => t.id === taskToUpdate || t.issueId === taskToUpdate);
            if (task) {
              await remediationService.updateTaskStatus(
                jobId,
                task.id,
                'completed',
                'Quick fix applied',
                req.user?.email || req.user?.id || 'user',
                { completionMethod: 'auto' }
              );
              tasksUpdated = 1;
              logger.debug(`Task ${task.id} marked as completed`);
            }
          }
        } catch (taskError) {
          logger.error('Failed to update task status', taskError instanceof Error ? taskError : undefined);
        }
      }

      return res.json({
        success: !hasErrors,
        data: {
          success: failCount === 0,
          successCount,
          failCount,
          modifiedFiles,
          results,
          tasksUpdated,
          downloadUrl: `/api/v1/epub/job/${jobId}/download-remediated`,
        },
      });
    } catch (error) {
      logger.error('applyQuickFix error', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: 'Failed to apply fix',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  },

  async scanEpubTypes(req: AuthenticatedRequest, res: Response) {
    try {
      const { jobId } = req.params;
      const tenantId = req.user?.tenantId;

      logger.debug(`scanEpubTypes called: jobId=${jobId}, tenantId=${tenantId}`);

      if (!tenantId) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
      }

      const job = await prisma.job.findFirst({ where: { id: jobId, tenantId } });
      if (!job) {
        return res.status(404).json({ success: false, error: 'Job not found' });
      }

      const input = job.input as { fileName?: string } | null;
      const fileName = input?.fileName || 'document.epub';

      let epubBuffer = await fileStorageService.getRemediatedFile(
        jobId,
        fileName.replace(/\.epub$/i, '_remediated.epub')
      );

      if (!epubBuffer) {
        epubBuffer = await fileStorageService.getFile(jobId, fileName);
      }

      if (!epubBuffer) {
        return res.status(404).json({ success: false, error: 'EPUB file not found' });
      }

      const zip = await epubModifier.loadEPUB(epubBuffer);
      const result = await epubModifier.scanEpubTypes(zip);

      logger.debug(`scanEpubTypes result: ${result.epubTypes.length} epub:types found`);

      return res.json({ success: true, data: result });
    } catch (error) {
      logger.error('scanEpubTypes error', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: 'Failed to scan file',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  },

  async markTaskFixed(req: AuthenticatedRequest, res: Response) {
    try {
      const { jobId, taskId } = req.params;
      const { resolution } = req.body;

      const task = await remediationService.updateTaskStatus(
        jobId,
        taskId,
        'completed',
        resolution || 'Marked as fixed via Quick Fix Panel',
        req.user?.email || 'system'
      );

      return res.json({ success: true, data: task });
    } catch (error) {
      logger.error('markTaskFixed error', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to mark task as fixed',
      });
    }
  },
};

// FIX 2: Interface with nullable path field (at module level)
interface FileRecord {
  id: string;
  originalName: string;
  storageType: string;
  storagePath: string | null;
  path: string | null;  // Changed from 'path: string' to allow null
}

// Background processing function (at module level, outside epubController)
async function processAuditInBackground(
  jobId: string,
  file: FileRecord
): Promise<void> {
  try {
    await prisma.job.update({
      where: { id: jobId },
      data: { status: 'PROCESSING', startedAt: new Date() },
    });

    // FIX 3: Get file buffer with proper null checks
    let fileBuffer: Buffer;
    if (file.storageType === 'S3' && file.storagePath) {
      logger.info(`Background: Fetching file from S3: ${file.storagePath}`);
      fileBuffer = await s3Service.getFileBuffer(file.storagePath);
    } else if (file.path) {
      logger.info(`Background: Reading file from local path: ${file.path}`);
      fileBuffer = await fs.promises.readFile(file.path);
    } else {
      throw new Error('No valid file path available (neither S3 nor local)');
    }

    await fileStorageService.saveFile(jobId, file.originalName, fileBuffer);

    const result = await epubAuditService.runAudit(
      fileBuffer,
      jobId,
      file.originalName
    );

    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: 'COMPLETED',
        output: JSON.parse(JSON.stringify(result)),
        completedAt: new Date(),
      },
    });

    try {
      await remediationService.createRemediationPlan(jobId);
      logger.info(`Auto-created remediation plan for job ${jobId}`);
    } catch (remediationError) {
      logger.warn(`Failed to auto-create remediation plan for job ${jobId}: ${remediationError instanceof Error ? remediationError.message : 'Unknown error'}`);
    }

    await prisma.file.update({
      where: { id: file.id },
      data: { status: FileStatus.PROCESSED },
    });

    logger.info(`Background audit completed for job ${jobId}`);
  } catch (error) {
    logger.error(`Audit processing failed for job ${jobId}: ${error instanceof Error ? error.message : 'Unknown error'}`);

    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: 'FAILED',
        error: error instanceof Error ? error.message : 'Unknown error',
        completedAt: new Date(),
      },
    }).catch(() => {});

    // Rollback file status to ERROR
    await prisma.file.update({
      where: { id: file.id },
      data: { status: FileStatus.ERROR },
    }).catch(() => {});
  }
}
