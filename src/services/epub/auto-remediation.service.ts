import { epubModifier } from './epub-modifier.service';
import { remediationService } from './remediation.service';
import { logger } from '../../lib/logger';
import prisma from '../../lib/prisma';
import JSZip from 'jszip';
import { isAutoFixable } from '../../constants/fix-classification';

interface ModificationEntry {
  issueCode: string;
  taskId: string;
  success: boolean;
  description: string;
  before?: string;
  after?: string;
  status?: 'fixed' | 'failed' | 'skipped';
}

interface AutoRemediationResult {
  jobId: string;
  originalFileName: string;
  remediatedFileName: string;
  totalIssuesFixed: number;
  totalIssuesFailed: number;
  quickFixPending: number;
  manualPending: number;
  modifications: ModificationEntry[];
  remediatedBuffer: Buffer;
  startedAt: Date;
  completedAt: Date;
}

type RemediationFunction = (zip: JSZip, options?: Record<string, unknown>) => Promise<{
  success: boolean;
  description: string;
  before?: string;
  after?: string;
}[]>;

class AutoRemediationService {
  private remediationHandlers: Record<string, RemediationFunction> = {
    'EPUB-META-001': async (zip) => {
      const result = await epubModifier.addLanguage(zip);
      return [result];
    },
    'EPUB-META-002': async (zip) => {
      return epubModifier.addAccessibilityMetadata(zip);
    },
    'EPUB-META-003': async (zip) => {
      const result = await epubModifier.addAccessibilitySummary(zip);
      return [result];
    },
    'EPUB-META-004': async (zip) => {
      return epubModifier.addAccessibilityMetadata(zip);
    },
    'EPUB-SEM-001': async (zip) => {
      return epubModifier.addHtmlLangAttributes(zip);
    },
    'EPUB-SEM-002': async (zip) => {
      return epubModifier.fixEmptyLinks(zip);
    },
    'EPUB-IMG-001': async (zip, options) => {
      if (options?.imageAlts && Array.isArray(options.imageAlts)) {
        return epubModifier.addAltText(zip, options.imageAlts as { imageSrc: string; altText: string }[]);
      }
      return epubModifier.addDecorativeAltAttributes(zip);
    },
    'EPUB-STRUCT-002': async (zip) => {
      return epubModifier.addTableHeaders(zip);
    },
    'EPUB-STRUCT-003': async (zip) => {
      return epubModifier.fixHeadingHierarchy(zip);
    },
    'EPUB-STRUCT-004': async (zip) => {
      return epubModifier.addAriaLandmarks(zip);
    },
    'EPUB-NAV-001': async (zip) => {
      return epubModifier.addSkipNavigation(zip);
    },
    'EPUB-FIG-001': async (zip) => {
      return epubModifier.addFigureStructure(zip);
    },
  };

  async runAutoRemediation(
    epubBuffer: Buffer,
    jobId: string,
    fileName: string
  ): Promise<AutoRemediationResult> {
    const startedAt = new Date();
    const modifications: AutoRemediationResult['modifications'] = [];
    let totalFixed = 0;
    let totalFailed = 0;

    try {
      const zip = await epubModifier.loadEPUB(epubBuffer);

      const plan = await remediationService.getRemediationPlan(jobId);
      if (!plan) {
        throw new Error('No remediation plan found for this job');
      }

      const autoTasks = plan.tasks.filter(
        t => t.type === 'auto' && t.status === 'pending'
      );
      const quickFixTasks = plan.tasks.filter(t => t.type === 'quickfix');
      const manualTasks = plan.tasks.filter(t => t.type === 'manual');

      logger.info(`Auto-remediation starting for ${jobId}:`);
      logger.info(`  - ${autoTasks.length} auto-fixable tasks`);
      logger.info(`  - ${quickFixTasks.length} quick-fix tasks (will be skipped)`);
      logger.info(`  - ${manualTasks.length} manual tasks (will be skipped)`);

      for (const task of autoTasks) {
        if (!isAutoFixable(task.issueCode)) {
          logger.warn(`Task ${task.id} (${task.issueCode}) is not auto-fixable, skipping`);
          modifications.push({
            issueCode: task.issueCode,
            taskId: task.id,
            success: false,
            description: 'Requires user input via Quick Fix',
            status: 'skipped',
          });
          continue;
        }
        const handler = this.remediationHandlers[task.issueCode];
        
        if (!handler) {
          modifications.push({
            issueCode: task.issueCode,
            taskId: task.id,
            success: false,
            description: `No auto-fix handler for ${task.issueCode}`,
          });
          totalFailed++;
          continue;
        }

        try {
          const results = await handler(zip);
          
          for (const result of results) {
            if (result.success) {
              totalFixed++;
              
              await remediationService.updateTaskStatus(
                jobId,
                task.id,
                'completed',
                result.description,
                'auto-remediation'
              );
            } else {
              totalFailed++;
            }

            modifications.push({
              issueCode: task.issueCode,
              taskId: task.id,
              success: result.success,
              description: result.description,
              before: result.before,
              after: result.after,
            });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          modifications.push({
            issueCode: task.issueCode,
            taskId: task.id,
            success: false,
            description: `Fix failed: ${message}`,
          });
          totalFailed++;

          await remediationService.updateTaskStatus(
            jobId,
            task.id,
            'failed',
            message,
            'auto-remediation'
          );
        }
      }

      for (const task of quickFixTasks) {
        modifications.push({
          issueCode: task.issueCode,
          taskId: task.id,
          success: false,
          description: 'Requires Quick Fix Panel - user input needed',
          status: 'skipped',
        });
      }

      for (const task of manualTasks) {
        modifications.push({
          issueCode: task.issueCode,
          taskId: task.id,
          success: false,
          description: 'Requires manual code editing',
          status: 'skipped',
        });
      }

      const remediatedBuffer = await epubModifier.saveEPUB(zip);
      const remediatedFileName = fileName.replace(/\.epub$/i, '_remediated.epub');

      const completedAt = new Date();

      const result: AutoRemediationResult = {
        jobId,
        originalFileName: fileName,
        remediatedFileName,
        totalIssuesFixed: totalFixed,
        totalIssuesFailed: totalFailed,
        quickFixPending: quickFixTasks.length,
        manualPending: manualTasks.length,
        modifications,
        remediatedBuffer,
        startedAt,
        completedAt,
      };

      const existingJob = await prisma.job.findUnique({ where: { id: jobId } });
      const autoRemediationOutput = {
        jobId: result.jobId,
        originalFileName: result.originalFileName,
        remediatedFileName: result.remediatedFileName,
        totalIssuesFixed: result.totalIssuesFixed,
        totalIssuesFailed: result.totalIssuesFailed,
        quickFixPending: result.quickFixPending,
        manualPending: result.manualPending,
        modifications: result.modifications,
        startedAt: result.startedAt.toISOString(),
        completedAt: result.completedAt.toISOString(),
        hasRemediatedFile: true,
      };
      await prisma.job.update({
        where: { id: jobId },
        data: {
          output: JSON.parse(JSON.stringify({
            ...((existingJob?.output as Record<string, unknown>) || {}),
            autoRemediation: autoRemediationOutput,
          })),
        },
      });

      logger.info(`Auto-remediation complete for ${jobId}: ${totalFixed} fixed, ${totalFailed} failed`);

      return result;
    } catch (error) {
      logger.error('Auto-remediation failed', error instanceof Error ? error : undefined);
      throw error;
    }
  }

  getSupportedIssueCodes(): string[] {
    return Object.keys(this.remediationHandlers);
  }
}

export const autoRemediationService = new AutoRemediationService();
