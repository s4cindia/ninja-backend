import { epubModifier } from './epub-modifier.service';
import { remediationService } from './remediation.service';
import { logger } from '../../lib/logger';
import prisma from '../../lib/prisma';
import JSZip from 'jszip';
import { isAutoFixable } from '../../constants/fix-classification';
import { ComparisonService, mapFixTypeToChangeType, extractWcagCriteria, extractWcagLevel } from '../comparison';

const comparisonService = new ComparisonService(prisma);

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
      return epubModifier.addAccessModes(zip, { textual: true });
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
    // ACE metadata code handlers - map to equivalent EPUB-META handlers
    'METADATA-ACCESSMODE': async (zip) => {
      return epubModifier.addAccessModes(zip, { textual: true });
    },
    'METADATA-ACCESSMODESUFFICIENT': async (zip) => {
      // addAccessModes adds both accessMode and accessModeSufficient when textual: true
      return epubModifier.addAccessModes(zip, { textual: true });
    },
    'METADATA-ACCESSIBILITYFEATURE': async (zip) => {
      return epubModifier.addAccessibilityMetadata(zip);
    },
    'METADATA-ACCESSIBILITYHAZARD': async (zip) => {
      return epubModifier.addAccessibilityHazard(zip);
    },
    'METADATA-ACCESSIBILITYSUMMARY': async (zip) => {
      const result = await epubModifier.addAccessibilitySummary(zip);
      return [result];
    },
    'COLOR-CONTRAST': async (_zip, options) => {
      const contrastIssues = options?.contrastIssues as Array<{
        filePath: string;
        foreground: string;
        background: string;
        selector?: string;
      }> | undefined;
      if (!contrastIssues || contrastIssues.length === 0) {
        return [{
          success: false,
          filePath: '',
          modificationType: 'skip',
          description: 'COLOR-CONTRAST requires specific issue data via Quick Fix',
        }];
      }
      return epubModifier.fixColorContrast(_zip, contrastIssues);
    },
    'EPUB-CONTRAST-001': async (_zip, options) => {
      const contrastIssues = options?.contrastIssues as Array<{
        filePath: string;
        foreground: string;
        background: string;
        selector?: string;
      }> | undefined;
      if (!contrastIssues || contrastIssues.length === 0) {
        return [{
          success: false,
          filePath: '',
          modificationType: 'skip',
          description: 'EPUB-CONTRAST-001 requires specific issue data via Quick Fix',
        }];
      }
      return epubModifier.fixColorContrast(_zip, contrastIssues);
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

      const tasksByIssueCode = new Map<string, typeof autoTasks>();
      for (const task of autoTasks) {
        const existing = tasksByIssueCode.get(task.issueCode) || [];
        existing.push(task);
        tasksByIssueCode.set(task.issueCode, existing);
      }

      logger.info(`Deduplicated to ${tasksByIssueCode.size} unique issue types`);

      for (const [issueCode, tasks] of tasksByIssueCode.entries()) {
        if (!isAutoFixable(issueCode)) {
          logger.warn(`Issue ${issueCode} is not auto-fixable, skipping ${tasks.length} task(s)`);
          for (const task of tasks) {
            modifications.push({
              issueCode: task.issueCode,
              taskId: task.id,
              success: false,
              description: 'Requires user input via Quick Fix',
              status: 'skipped',
            });
          }
          continue;
        }

        const handler = this.remediationHandlers[issueCode];
        
        if (!handler) {
          for (const task of tasks) {
            modifications.push({
              issueCode: task.issueCode,
              taskId: task.id,
              success: false,
              description: `No auto-fix handler for ${issueCode}`,
            });
          }
          totalFailed += tasks.length;
          continue;
        }

        try {
          const results = await handler(zip);
          
          for (const result of results) {
            // Map modificationType: 'skip' to status: 'skipped' for quick-fix classification
            const handlerResult = result as { modificationType?: string };
            const status = handlerResult.modificationType === 'skip' ? 'skipped' : undefined;
            
            modifications.push({
              issueCode,
              taskId: tasks[0]?.id || 'handler-result',
              success: result.success,
              description: result.description,
              before: result.before,
              after: result.after,
              status,
            });

            if (result.success) {
              try {
                const filePath = (result as { filePath?: string; targetPath?: string }).filePath 
                  || (result as { targetPath?: string }).targetPath 
                  || tasks[0]?.filePath 
                  || 'OEBPS/content.opf';
                await comparisonService.logChange({
                  jobId,
                  taskId: tasks[0]?.id,
                  ruleId: issueCode,
                  filePath,
                  changeType: mapFixTypeToChangeType(issueCode),
                  description: result.description,
                  beforeContent: result.before,
                  afterContent: result.after,
                  severity: 'MAJOR',
                  wcagCriteria: extractWcagCriteria(issueCode),
                  wcagLevel: extractWcagLevel(issueCode),
                  appliedBy: 'auto-remediation',
                });
              } catch (logError) {
                logger.warn(`Failed to log remediation change: ${logError instanceof Error ? logError.stack : String(logError)} (jobId=${jobId})`);
              }
            }
          }

          const hasSuccess = results.some(r => r.success);
          const isNoOpSuccess = results.length > 0 && results.every(r => 
            r.description?.includes('already present') || 
            r.description?.includes('not applicable') || 
            r.description?.includes('No ') ||
            r.description?.includes('correct')
          );

          if (hasSuccess || isNoOpSuccess) {
            const description = results.map(r => r.description).filter(Boolean).join('; ') || `Fixed via ${issueCode}`;
            
            for (const task of tasks) {
              totalFixed++;
              await remediationService.updateTaskStatus(
                jobId,
                task.id,
                'completed',
                description,
                'auto-remediation'
              );
            }
            logger.info(`${issueCode}: Completed ${tasks.length} task(s) - ${description}`);
          } else {
            const description = results.map(r => r.description).filter(Boolean).join('; ') || 'Handler returned no results';
            for (const task of tasks) {
              totalFailed++;
              await remediationService.updateTaskStatus(
                jobId,
                task.id,
                'failed',
                description,
                'auto-remediation'
              );
            }
            logger.warn(`${issueCode}: Failed ${tasks.length} task(s) - ${description}`);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          
          for (const task of tasks) {
            modifications.push({
              issueCode: task.issueCode,
              taskId: task.id,
              success: false,
              description: `Fix failed: ${message}`,
            });

            await remediationService.updateTaskStatus(
              jobId,
              task.id,
              'failed',
              message,
              'auto-remediation'
            );
          }
          totalFailed += tasks.length;
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
