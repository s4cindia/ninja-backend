import { epubModifier } from './epub-modifier.service';
import { remediationService } from './remediation.service';
import { logger } from '../../lib/logger';
import prisma from '../../lib/prisma';
import JSZip from 'jszip';

interface AutoRemediationResult {
  jobId: string;
  originalFileName: string;
  remediatedFileName: string;
  totalIssuesFixed: number;
  totalIssuesFailed: number;
  modifications: {
    issueCode: string;
    taskId: string;
    success: boolean;
    description: string;
    before?: string;
    after?: string;
  }[];
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
    'EPUB-IMG-001': async (zip) => {
      return epubModifier.addDecorativeAltAttributes(zip);
    },
    'EPUB-STRUCT-002': async (zip) => {
      return epubModifier.addTableHeaders(zip);
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

      for (const task of autoTasks) {
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

      const remediatedBuffer = await epubModifier.saveEPUB(zip);
      const remediatedFileName = fileName.replace(/\.epub$/i, '_remediated.epub');

      const completedAt = new Date();

      const result: AutoRemediationResult = {
        jobId,
        originalFileName: fileName,
        remediatedFileName,
        totalIssuesFixed: totalFixed,
        totalIssuesFailed: totalFailed,
        modifications,
        remediatedBuffer,
        startedAt,
        completedAt,
      };

      const existingJob = await prisma.job.findUnique({ where: { id: jobId } });
      await prisma.job.update({
        where: { id: jobId },
        data: {
          output: {
            ...((existingJob?.output as Record<string, unknown>) || {}),
            autoRemediation: {
              ...result,
              remediatedBuffer: undefined,
              hasRemediatedFile: true,
            },
          },
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

  isAutoFixable(issueCode: string): boolean {
    return issueCode in this.remediationHandlers;
  }
}

export const autoRemediationService = new AutoRemediationService();
