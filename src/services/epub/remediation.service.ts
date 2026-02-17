import crypto from 'crypto';
import { nanoid } from 'nanoid';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { epubAuditService } from './epub-audit.service';
import { wcagCriteriaService } from '../validation/wcag-criteria.service';
import {
  getFixType,
  FixType,
  DUPLICATE_CODE_MAP,
} from '../../constants/fix-classification';
import {
  createTally,
  validateTallyTransition,
  IssueTally,
  TallyValidationResult,
} from '../../types/issue-tally.types';
import { captureIssueSnapshot, compareSnapshots } from '../../utils/issue-flow-logger';
import {
  trackIssuesAtStage,
  printTrackingReport,
  clearTracking,
  findMissingIssues,
} from '../../utils/issue-debugger';
import type { ModificationResult } from './epub-modifier.service';

type RemediationStatus = 'pending' | 'in_progress' | 'completed' | 'skipped' | 'failed';
type RemediationPriority = 'critical' | 'high' | 'medium' | 'low';
type RemediationType = FixType;

interface RemediationTask {
  id: string;
  jobId: string;
  issueId: string;
  issueCode: string;
  issueMessage: string;
  severity: string;
  category: string;
  location?: string;
  status: RemediationStatus;
  priority: RemediationPriority;
  type: RemediationType;
  autoFixable: boolean;
  quickFixable: boolean;
  suggestion?: string;
  resolution?: string;
  resolvedBy?: string;
  resolvedAt?: Date;
  notes?: string;
  completionMethod?: 'auto' | 'manual' | 'verified';
  // Track where fix was actually applied
  resolvedLocation?: string;
  resolvedFiles?: string[];
  createdAt: Date;
  updatedAt: Date;
  filePath?: string;
  selector?: string;
  wcagCriteria?: string[];
  source?: string;
  html?: string;
  remediation?: string;
  element?: string;
  context?: string;
}

interface RemediationPlan {
  jobId: string;
  fileName: string;
  totalIssues: number;
  tasks: RemediationTask[];
  stats: {
    pending: number;
    inProgress: number;
    completed: number;
    skipped: number;
    failed: number;
    autoFixable: number;
    quickFixable: number;
    manualRequired: number;
    byFixType: Record<FixType, number>;
    bySource: { epubCheck: number; ace: number; jsAuditor: number };
    bySeverity: { critical: number; serious: number; moderate: number; minor: number };
  };
  auditTally?: IssueTally;
  planTally?: IssueTally;
  tallyValidation?: TallyValidationResult;
  createdAt: Date;
  updatedAt: Date;
}

// AUTO_FIX_HANDLERS must stay in sync with remediationHandlers in auto-remediation.service.ts
// These codes will be classified as type: 'auto' during plan creation
const AUTO_FIX_HANDLERS: Record<string, { handler: () => { success: boolean; message: string } }> = {
  'EPUB-META-001': {
    handler: () => ({ success: true, message: 'Would add <dc:language>en</dc:language> to package document' }),
  },
  'EPUB-META-002': {
    handler: () => ({ success: true, message: 'Would add schema:accessibilityFeature metadata with standard values' }),
  },
  'EPUB-META-003': {
    handler: () => ({ success: true, message: 'Would add schema:accessibilitySummary with auto-generated description' }),
  },
  'EPUB-META-004': {
    handler: () => ({ success: true, message: 'Would add schema:accessMode with "textual" value' }),
  },
  'EPUB-SEM-001': {
    handler: () => ({ success: true, message: 'Would add lang attributes to html elements' }),
  },
  'EPUB-SEM-002': {
    handler: () => ({ success: true, message: 'Would fix empty links with descriptive text' }),
  },
  'EPUB-IMG-001': {
    handler: () => ({ success: true, message: 'Would add alt attributes to images' }),
  },
  'EPUB-STRUCT-002': {
    handler: () => ({ success: true, message: 'Would add table headers with scope attributes' }),
  },
  'EPUB-STRUCT-003': {
    handler: () => ({ success: true, message: 'Would fix heading hierarchy to be sequential' }),
  },
  'EPUB-STRUCT-004': {
    handler: () => ({ success: true, message: 'Would add ARIA landmarks (main, navigation, banner, contentinfo)' }),
  },
  'EPUB-NAV-001': {
    handler: () => ({ success: true, message: 'Would add skip navigation links' }),
  },
  'EPUB-NAV-002': {
    handler: () => ({ success: true, message: 'Would generate page-list navigation from content structure' }),
  },
  'EPUB-NAV-003': {
    handler: () => ({ success: true, message: 'Would generate landmarks navigation with bodymatter, toc entries' }),
  },
  'EPUB-FIG-001': {
    handler: () => ({ success: true, message: 'Would wrap images in figure elements with figcaption' }),
  },
};

const SEVERITY_TO_PRIORITY: Record<string, RemediationPriority> = {
  critical: 'critical',
  serious: 'high',
  moderate: 'medium',
  minor: 'low',
};

class RemediationService {
  async createRemediationPlan(jobId: string): Promise<RemediationPlan> {
    const job = await prisma.job.findUnique({
      where: { id: jobId },
    });

    if (!job || !job.output) {
      throw new Error('No audit results found for this job');
    }

    const auditData = job.output as Record<string, unknown>;

    if (!auditData || typeof auditData !== 'object') {
      throw new Error('Invalid audit data format');
    }

    const combinedIssues = auditData.combinedIssues;
    if (combinedIssues !== undefined && !Array.isArray(combinedIssues)) {
      throw new Error('Invalid audit data: combinedIssues must be an array');
    }

    const issues = (combinedIssues as Array<Record<string, unknown>>) || [];

    logger.info('\n' + '='.repeat(80));
    logger.info('BUILD REMEDIATION PLAN - DETAILED TRACKING');
    logger.info('='.repeat(80));

    clearTracking();

    const validatedIssues = issues.filter(issue => {
      if (!issue || typeof issue !== 'object') {
        logger.warn('Skipping invalid issue entry');
        return false;
      }
      return true;
    });

    logger.info(`\nPLAN INPUT: ${validatedIssues.length} issues received`);

    trackIssuesAtStage('PLAN_INPUT', validatedIssues);
    captureIssueSnapshot('8_PLAN_INPUT', validatedIssues, true);

    logger.info('\nALL INPUT ISSUES:');
    validatedIssues.forEach((issue, i) => {
      const code = issue.code as string || 'UNKNOWN';
      const source = issue.source as string || 'unknown';
      const location = issue.location as string || 'N/A';
      logger.info(`  ${i + 1}. [${source}] ${code} @ ${location}`);
    });

    // Deduplicate issues: ACE metadata codes that duplicate JS Auditor codes
    // Only skip if JS Auditor has the SAME mapped code at the SAME location
    const jsAuditorIssueKeys = new Set(
      validatedIssues
        .filter(i => String(i.source || '').toLowerCase().trim() === 'js-auditor')
        .map(i => {
          const code = String(i.code || '');
          const location = typeof i.location === 'string' ? i.location.trim() : '';
          return `${code}:${location}`;
        })
    );

    const deduplicatedIssues = validatedIssues.filter(issue => {
      const code = String(issue.code || '');
      const source = String(issue.source || '').toLowerCase().trim();
      const location = typeof issue.location === 'string' ? issue.location.trim() : '';
      
      // If this is an ACE issue that maps to a JS Auditor code at the same location, skip it
      const mappedCode = DUPLICATE_CODE_MAP[code];
      if (mappedCode && source === 'ace') {
        const jsKey = `${mappedCode}:${location}`;
        if (jsAuditorIssueKeys.has(jsKey)) {
          logger.info(`  Skipping duplicate ACE issue ${code} at ${location} (covered by JS Auditor ${mappedCode})`);
          return false;
        }
      }
      return true;
    });
    
    if (deduplicatedIssues.length < validatedIssues.length) {
      logger.info(`\nDEDUPLICATION: ${validatedIssues.length} -> ${deduplicatedIssues.length} issues (removed ${validatedIssues.length - deduplicatedIssues.length} duplicates)`);
    }

    const auditTally = createTally(deduplicatedIssues, 'audit');
    logger.info('\nAudit Tally:');
    logger.info(`  By Source: EPUBCheck=${auditTally.bySource.epubCheck}, ACE=${auditTally.bySource.ace}, JS Auditor=${auditTally.bySource.jsAuditor}`);
    logger.info(`  By Severity: Critical=${auditTally.bySeverity.critical}, Serious=${auditTally.bySeverity.serious}, Moderate=${auditTally.bySeverity.moderate}, Minor=${auditTally.bySeverity.minor}`);
    logger.info(`  Grand Total: ${auditTally.grandTotal}`);

    const tasks: RemediationTask[] = deduplicatedIssues.map((issue) => {
      const issueCode = (issue.code as string) || '';
      const issueLocation = (issue.location as string) || '';
      const severity = (issue.severity as string) || 'moderate';
      const taskId = crypto.createHash('md5')
        .update(`${jobId}-${issueCode}-${issueLocation}`)
        .digest('hex')
        .substring(0, 8);
      
      const wcagCriteriaRaw = issue.wcagCriteria;
      const wcagCriteria: string[] | undefined = Array.isArray(wcagCriteriaRaw) 
        ? wcagCriteriaRaw.map(String)
        : typeof wcagCriteriaRaw === 'string' 
          ? [wcagCriteriaRaw]
          : undefined;
      
      const fixType = getFixType(issueCode);
      return {
        id: `task-${taskId}`,
        jobId,
        issueId: (issue.id as string) || `issue-${taskId}`,
        issueCode,
        issueMessage: (issue.message as string) || '',
        severity,
        category: (issue.category as string) || 'general',
        location: issueLocation || undefined,
        status: 'pending' as RemediationStatus,
        priority: SEVERITY_TO_PRIORITY[severity] || 'medium',
        type: fixType,
        autoFixable: fixType === 'auto',
        quickFixable: fixType === 'quickfix',
        suggestion: issue.suggestion as string | undefined,
        createdAt: new Date(),
        updatedAt: new Date(),
        filePath: (issue.filePath as string) || (issue.location as string) || undefined,
        selector: (issue.selector as string) || undefined,
        wcagCriteria,
        source: (issue.source as string) || undefined,
        html: (issue.html as string) || (issue.snippet as string) || undefined,
        remediation: this.getRemediationGuidance(issueCode),
        element: (issue.element as string) || undefined,
        context: (issue.context as string) || undefined,
      };
    });

    const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    tasks.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

    trackIssuesAtStage('PLAN_TASKS', tasks.map(t => ({
      code: t.issueCode,
      source: t.source,
      location: t.location,
      message: t.issueMessage,
    })));
    captureIssueSnapshot('9_TASKS_CREATED', tasks as unknown as Record<string, unknown>[], true);

    logger.info(`\nPLAN OUTPUT: ${tasks.length} tasks created`);

    if (tasks.length !== validatedIssues.length) {
      logger.error('TASK CREATION ERROR!');
      logger.error(`   Input issues: ${validatedIssues.length}`);
      logger.error(`   Created tasks: ${tasks.length}`);
      logger.error(`   Missing: ${validatedIssues.length - tasks.length}`);
    } else {
      logger.info(`All ${validatedIssues.length} issues converted to tasks`);
    }

    const missingInPlan = findMissingIssues('PLAN_INPUT', 'PLAN_TASKS');
    if (missingInPlan.length > 0) {
      logger.error('\nISSUES MISSING FROM PLAN:');
      missingInPlan.forEach(issue => {
        logger.error(`  - [${issue.source}] ${issue.code}`);
        logger.error(`    Location: ${issue.location}`);
        logger.error(`    Last seen at: ${issue.seenAt[issue.seenAt.length - 1]}`);
      });
    }

    printTrackingReport();
    compareSnapshots('8_PLAN_INPUT', '9_TASKS_CREATED');

    const inputCodes = new Map<string, Record<string, unknown>>();
    validatedIssues.forEach(issue => {
      const code = issue.code as string || 'UNKNOWN';
      const location = issue.location as string || '';
      const key = `${code}:${location}`;
      inputCodes.set(key, issue);
    });

    const outputCodes = new Set<string>();
    tasks.forEach(task => {
      const key = `${task.issueCode}:${task.location || ''}`;
      outputCodes.add(key);
    });

    logger.info('\nDETAILED MISSING ISSUE CHECK:');
    logger.info(`  Input unique keys: ${inputCodes.size}`);
    logger.info(`  Output unique keys: ${outputCodes.size}`);

    const missingKeys: string[] = [];
    inputCodes.forEach((issue, key) => {
      if (!outputCodes.has(key)) {
        missingKeys.push(key);
        logger.error(`\n  MISSING: ${key}`);
        logger.error(`     Code: ${issue.code}`);
        logger.error(`     Source: ${issue.source}`);
        logger.error(`     Location: ${issue.location}`);
        logger.error(`     Message: ${(issue.message as string)?.substring(0, 100)}`);
        logger.error(`     Full issue: ${JSON.stringify(issue, null, 2)}`);
      }
    });

    if (missingKeys.length === 0) {
      logger.info('  No missing issues found');
    } else {
      logger.error(`\n  ${missingKeys.length} ISSUES ARE MISSING!`);
    }

    const planTally = createTally(tasks as unknown as Record<string, unknown>[], 'remediation_plan');
    logger.info('\nPlan Tally:');
    logger.info(`  By Source: EPUBCheck=${planTally.bySource.epubCheck}, ACE=${planTally.bySource.ace}, JS Auditor=${planTally.bySource.jsAuditor}`);
    logger.info(`  By Classification: Auto=${planTally.byClassification.autoFixable}, QuickFix=${planTally.byClassification.quickFix}, Manual=${planTally.byClassification.manual}`);
    logger.info(`  Grand Total: ${planTally.grandTotal}`);

    const tallyValidation = validateTallyTransition(auditTally, planTally);
    if (tallyValidation.isValid) {
      logger.info('\nTALLY VALIDATION PASSED');
      logger.info(`   All ${auditTally.grandTotal} issues accounted for`);
    } else {
      logger.error('\nTALLY VALIDATION FAILED!');
      logger.error(`   Errors: ${tallyValidation.errors.join(', ')}`);
      tallyValidation.discrepancies.forEach(d => {
        logger.error(`   ${d.field}: expected ${d.expected}, got ${d.actual} (diff: ${d.difference})`);
      });
    }

    const plan: RemediationPlan = {
      jobId,
      fileName: (auditData.fileName as string) || 'unknown.epub',
      totalIssues: tasks.length,
      tasks,
      stats: {
        pending: tasks.length,
        inProgress: 0,
        completed: 0,
        skipped: 0,
        failed: 0,
        autoFixable: planTally.byClassification.autoFixable,
        quickFixable: planTally.byClassification.quickFix,
        manualRequired: planTally.byClassification.manual,
        byFixType: {
          auto: planTally.byClassification.autoFixable,
          quickfix: planTally.byClassification.quickFix,
          manual: planTally.byClassification.manual,
        },
        bySource: {
          epubCheck: planTally.bySource.epubCheck,
          ace: planTally.bySource.ace,
          jsAuditor: planTally.bySource.jsAuditor,
        },
        bySeverity: {
          critical: planTally.bySeverity.critical,
          serious: planTally.bySeverity.serious,
          moderate: planTally.bySeverity.moderate,
          minor: planTally.bySeverity.minor,
        },
      },
      auditTally,
      planTally,
      tallyValidation,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    logger.info('\n========================================');
    logger.info('Remediation Plan Summary');
    logger.info('========================================');
    logger.info(`Total Tasks: ${plan.stats.pending}`);
    logger.info(`  Auto-Fixable: ${plan.stats.autoFixable}`);
    logger.info(`  Quick Fix:    ${plan.stats.quickFixable}`);
    logger.info(`  Manual:       ${plan.stats.manualRequired}`);
    logger.info('========================================\n');

    await prisma.job.create({
      data: {
        id: nanoid(),
        tenantId: job.tenantId,
        userId: job.userId,
        type: 'BATCH_VALIDATION',
        status: 'COMPLETED',
        input: { sourceJobId: jobId, planType: 'remediation' },
        output: JSON.parse(JSON.stringify(plan)),
        completedAt: new Date(),
        updatedAt: new Date(),
      },
    });

    logger.info(`Created remediation plan for job ${jobId} with ${tasks.length} tasks`);
    return plan;
  }

  async getRemediationPlan(jobId: string): Promise<RemediationPlan | null> {
    const planJob = await prisma.job.findFirst({
      where: {
        type: 'BATCH_VALIDATION',
        input: {
          path: ['sourceJobId'],
          equals: jobId,
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return planJob?.output as RemediationPlan | null;
  }

  async updateTaskStatus(
    jobId: string,
    taskId: string,
    status: RemediationStatus,
    resolution?: string,
    resolvedBy?: string,
    options?: {
      notes?: string;
      completionMethod?: 'auto' | 'manual' | 'verified';
      resolvedLocation?: string;
      resolvedFiles?: string[];
    }
  ): Promise<RemediationTask> {
    return await prisma.$transaction(async (tx) => {
      const planJob = await tx.job.findFirst({
        where: {
          type: 'BATCH_VALIDATION',
          input: {
            path: ['sourceJobId'],
            equals: jobId,
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      if (!planJob || !planJob.output) {
        throw new Error('Remediation plan not found');
      }

      const plan = planJob.output as unknown as RemediationPlan;
      const taskIndex = plan.tasks.findIndex(t => t.id === taskId);
      
      if (taskIndex === -1) {
        throw new Error('Task not found');
      }

      const task = plan.tasks[taskIndex];
      task.status = status;
      task.updatedAt = new Date();

      if (status === 'completed' || status === 'failed') {
        task.resolution = resolution;
        task.resolvedBy = resolvedBy;
        task.resolvedAt = new Date();
        if (options?.completionMethod) {
          task.completionMethod = options.completionMethod;
        }
        if (options?.notes) {
          task.notes = options.notes;
        }
        if (options?.resolvedLocation) {
          task.resolvedLocation = options.resolvedLocation;
        }
        if (options?.resolvedFiles) {
          task.resolvedFiles = options.resolvedFiles;
        }

        // Update corresponding Issue record status to REMEDIATED
        if (status === 'completed' && task.issueCode) {
          const planInput = planJob.input as { sourceJobId?: string } | null;
          const sourceJobId = planInput?.sourceJobId;
          
          if (sourceJobId && tx.validationResult) {
            // Find all validation results for this job
            const validationResults = await tx.validationResult.findMany({
              where: { jobId: sourceJobId },
            });

            for (const validationResult of validationResults) {
              // Build location matching condition - check both filePath and location fields
              // since task.location may match either field depending on how the issue was stored
              const locationConditions: Array<Record<string, unknown>> = [];
              if (task.location) {
                locationConditions.push(
                  { filePath: task.location },
                  { location: task.location }
                );
              }

              // Update Issue records matching this task's issue code and location
              const updateResult = await tx.issue.updateMany({
                where: {
                  validationResultId: validationResult.id,
                  code: task.issueCode,
                  status: 'PENDING',
                  ...(locationConditions.length > 0 ? { OR: locationConditions } : {}),
                },
                data: {
                  status: 'REMEDIATED',
                  fixedAt: new Date(),
                  fixedBy: resolvedBy || 'system',
                  remediationMethod: options?.completionMethod || 'quick-fix',
                  remediationTaskId: task.id,
                },
              });
              
              if (updateResult.count > 0) {
                logger.info(`Updated ${updateResult.count} Issue(s) to REMEDIATED for code ${task.issueCode}`, {
                  jobId,
                  taskId,
                  issueCode: task.issueCode,
                  location: task.location,
                  validationResultId: validationResult.id,
                });
              }
            }
          }
        }
      }

      const updatedTally = createTally(plan.tasks as unknown as Record<string, unknown>[], 'in_progress');
      plan.stats = {
        pending: plan.tasks.filter(t => t.status === 'pending').length,
        inProgress: plan.tasks.filter(t => t.status === 'in_progress').length,
        completed: plan.tasks.filter(t => t.status === 'completed').length,
        skipped: plan.tasks.filter(t => t.status === 'skipped').length,
        failed: plan.tasks.filter(t => t.status === 'failed').length,
        autoFixable: updatedTally.byClassification.autoFixable,
        quickFixable: updatedTally.byClassification.quickFix,
        manualRequired: updatedTally.byClassification.manual,
        byFixType: {
          auto: updatedTally.byClassification.autoFixable,
          quickfix: updatedTally.byClassification.quickFix,
          manual: updatedTally.byClassification.manual,
        },
        bySource: {
          epubCheck: updatedTally.bySource.epubCheck,
          ace: updatedTally.bySource.ace,
          jsAuditor: updatedTally.bySource.jsAuditor,
        },
        bySeverity: {
          critical: updatedTally.bySeverity.critical,
          serious: updatedTally.bySeverity.serious,
          moderate: updatedTally.bySeverity.moderate,
          minor: updatedTally.bySeverity.minor,
        },
      };
      plan.updatedAt = new Date();

      await tx.job.update({
        where: { id: planJob.id },
        data: { output: JSON.parse(JSON.stringify(plan)) },
      });

      return task;
    });
  }

  async markManualTaskFixed(
    jobId: string,
    taskId: string,
    data: { notes?: string; verifiedBy?: string; resolution?: string }
  ): Promise<RemediationTask> {
    const resolution = data.resolution || 'Manually verified and fixed';
    const verifiedBy = data.verifiedBy || 'user';
    
    return this.updateTaskStatus(
      jobId,
      taskId,
      'completed',
      resolution,
      verifiedBy,
      { notes: data.notes, completionMethod: 'manual' }
    );
  }

  async startTask(jobId: string, taskId: string): Promise<RemediationTask> {
    return this.updateTaskStatus(jobId, taskId, 'in_progress');
  }

  async completeTask(
    jobId: string,
    taskId: string,
    resolution: string,
    resolvedBy: string
  ): Promise<RemediationTask> {
    return this.updateTaskStatus(jobId, taskId, 'completed', resolution, resolvedBy);
  }

  async skipTask(jobId: string, taskId: string, reason: string): Promise<RemediationTask> {
    return this.updateTaskStatus(jobId, taskId, 'skipped', reason);
  }

  async runAutoRemediation(jobId: string): Promise<{
    attempted: number;
    succeeded: number;
    failed: number;
    results: { taskId: string; success: boolean; message: string }[];
  }> {
    const plan = await this.getRemediationPlan(jobId);
    if (!plan) {
      throw new Error('Remediation plan not found');
    }

    const autoTasks = plan.tasks.filter(
      t => t.type === 'auto' && t.status === 'pending'
    );

    const results: { taskId: string; success: boolean; message: string }[] = [];

    for (const task of autoTasks) {
      try {
        const result = await this.autoFix(task);
        await this.completeTask(jobId, task.id, result.message, 'system');
        results.push({ taskId: task.id, success: true, message: result.message });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Auto-fix failed';
        await this.updateTaskStatus(jobId, task.id, 'failed', message);
        results.push({ taskId: task.id, success: false, message });
      }
    }

    return {
      attempted: autoTasks.length,
      succeeded: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results,
    };
  }

  /**
   * Auto-fix a specific issue.
   * 
   * NOTE: This is a placeholder implementation that describes what fixes WOULD be applied.
   * Actual EPUB modification will be implemented in Epic 3.7 (Complete Remediation).
   * 
   * @param task - The remediation task to auto-fix
   * @returns Description of the fix that would be applied
   */
  private async autoFix(task: RemediationTask): Promise<{ success: boolean; message: string }> {
    const handler = AUTO_FIX_HANDLERS[task.issueCode];
    if (!handler) {
      throw new Error(`No auto-fix available for ${task.issueCode}`);
    }
    return handler.handler();
  }

  async getRemediationSummary(jobId: string): Promise<{
    totalTasks: number;
    completionPercentage: number;
    stats: RemediationPlan['stats'];
    criticalRemaining: number;
    estimatedTimeMinutes: number;
  }> {
    const plan = await this.getRemediationPlan(jobId);
    if (!plan) {
      throw new Error('Remediation plan not found');
    }

    const completedOrSkipped = plan.stats.completed + plan.stats.skipped;
    const completionPercentage = plan.totalIssues > 0
      ? Math.round((completedOrSkipped / plan.totalIssues) * 100)
      : 100;

    const criticalRemaining = plan.tasks.filter(
      t => t.priority === 'critical' && t.status === 'pending'
    ).length;

    const pendingManual = plan.tasks.filter(
      t => t.type === 'manual' && t.status === 'pending'
    ).length;
    const estimatedTimeMinutes = pendingManual * 5;

    return {
      totalTasks: plan.totalIssues,
      completionPercentage,
      stats: plan.stats,
      criticalRemaining,
      estimatedTimeMinutes,
    };
  }

  async reauditEpub(
    jobId: string,
    file: { buffer: Buffer; originalname: string }
  ): Promise<{
    originalIssues: number;
    newIssues: number;
    resolved: number;
    stillPending: number;
    verifiedTasks: string[];
    newIssuesFound: Array<{ code: string; message: string; severity: string }>;
    comparison: {
      before: { total: number; bySeverity: Record<string, number> };
      after: { total: number; bySeverity: Record<string, number> };
    };
    coverage: {
      totalFiles: number;
      filesScanned: number;
      percentage: number;
      fileCategories: {
        frontMatter: number;
        chapters: number;
        backMatter: number;
      };
    };
  }> {
    const originalPlan = await this.getRemediationPlan(jobId);
    if (!originalPlan) {
      throw new Error('Original remediation plan not found');
    }

    logger.info(`[Re-audit] Starting re-audit for job ${jobId}, file: ${file.originalname}`);

    // Get original job to extract tenant and user info
    const originalJob = await prisma.job.findUnique({
      where: { id: jobId },
      select: { tenantId: true, userId: true },
    });

    if (!originalJob) {
      throw new Error('Original job not found');
    }

    // Create a new job for the re-audit
    const reauditJobId = nanoid();
    await prisma.job.create({
      data: {
        id: reauditJobId,
        tenantId: originalJob.tenantId,
        userId: originalJob.userId,
        type: 'EPUB_ACCESSIBILITY',
        status: 'PROCESSING',
        input: {
          sourceJobId: jobId,
          fileName: file.originalname,
          auditType: 'reaudit',
        },
        startedAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const newAuditResult = await epubAuditService.runAudit(
      file.buffer,
      reauditJobId,
      file.originalname
    );

    logger.info(`[Re-audit] New audit found ${newAuditResult.combinedIssues.length} issues`);

    const resolvedIssueCodes = this.findResolvedIssues(
      originalPlan.tasks,
      newAuditResult.combinedIssues
    );

    logger.info(`[Re-audit] Resolved issues: ${resolvedIssueCodes.join(', ')}`);

    const verifiedTasks: string[] = [];
    for (const task of originalPlan.tasks) {
      if (resolvedIssueCodes.includes(task.issueCode) && task.status === 'pending') {
        await this.updateTaskStatus(
          jobId,
          task.id,
          'completed',
          'Verified fixed via re-audit',
          'system',
          { completionMethod: 'verified' }
        );
        verifiedTasks.push(task.id);
      }
    }

    const originalIssueCodes = new Set(originalPlan.tasks.map(t => t.issueCode));
    const newIssuesFound = newAuditResult.combinedIssues
      .filter((i: { code: string }) => !originalIssueCodes.has(i.code))
      .map((i: { code: string; message: string; severity: string }) => ({
        code: i.code,
        message: i.message,
        severity: i.severity,
      }));

    const beforeBySeverity: Record<string, number> = {};
    for (const task of originalPlan.tasks) {
      beforeBySeverity[task.severity] = (beforeBySeverity[task.severity] || 0) + 1;
    }

    const afterBySeverity: Record<string, number> = {};
    for (const issue of newAuditResult.combinedIssues) {
      afterBySeverity[issue.severity] = (afterBySeverity[issue.severity] || 0) + 1;
    }

    return {
      originalIssues: originalPlan.tasks.length,
      newIssues: newAuditResult.combinedIssues.length,
      resolved: resolvedIssueCodes.length,
      stillPending: originalPlan.tasks.length - verifiedTasks.length,
      verifiedTasks,
      newIssuesFound,
      comparison: {
        before: { total: originalPlan.tasks.length, bySeverity: beforeBySeverity },
        after: { total: newAuditResult.combinedIssues.length, bySeverity: afterBySeverity },
      },
      coverage: newAuditResult.coverage,
    };
  }

  private getRemediationGuidance(code: string): string {
    const guidance: Record<string, string> = {
      'EPUB-META-001': 'Add <dc:language> element to the package document (OPF) with the primary language code (e.g., "en" for English).',
      'EPUB-META-002': 'Add schema:accessibilityFeature metadata with values like "alternativeText", "readingOrder", "structuralNavigation".',
      'EPUB-META-003': 'Add schema:accessibilitySummary with a description of the publication\'s accessibility features.',
      'EPUB-META-004': 'Add schema:accessMode metadata specifying how content can be consumed (e.g., "textual", "visual").',
      'EPUB-SEM-001': 'Add lang attribute to HTML elements to specify the document language for screen readers.',
      'EPUB-SEM-002': 'Add descriptive aria-label or visible text content to empty links.',
      'EPUB-SEM-003': 'Add role attribute matching epub:type semantic (e.g., epub:type="chapter" should have role="doc-chapter").',
      'EPUB-IMG-001': 'Add meaningful alt text describing the image content, or alt="" for decorative images.',
      'EPUB-STRUCT-001': 'Ensure document structure uses semantic HTML5 elements (article, section, nav, aside, header, footer).',
      'EPUB-STRUCT-002': 'Add <th> elements with scope attributes to data tables for proper header associations.',
      'EPUB-STRUCT-003': 'Fix heading hierarchy to avoid skipped levels (e.g., h1 → h2 → h3, not h1 → h3).',
      'EPUB-STRUCT-004': 'Add ARIA landmark roles (main, navigation, banner, contentinfo) to major page regions.',
      'EPUB-NAV-001': 'Add skip navigation link at the top of content pages to bypass repetitive navigation.',
      'EPUB-NAV-002': 'Add page-list navigation element linking to page break markers in the content.',
      'EPUB-NAV-003': 'Add landmarks navigation with entries for major document sections.',
      'EPUB-FIG-001': 'Wrap images in <figure> elements with <figcaption> for proper figure structure.',
      'COLOR-CONTRAST': 'Adjust text/background colors to meet WCAG contrast ratio requirements (4.5:1 for normal text, 3:1 for large text).',
      'EPUB-CONTRAST-001': 'Adjust text/background colors to meet WCAG contrast ratio requirements (4.5:1 for normal text, 3:1 for large text).',
      'LINK-TEXT': 'Replace generic link text like "click here" with descriptive text indicating the link destination.',
      'LINK-NAME': 'Ensure all links have accessible names via visible text, aria-label, or aria-labelledby.',
      'FORM-LABEL': 'Associate form inputs with visible <label> elements using for/id attributes.',
      'BUTTON-NAME': 'Ensure all buttons have accessible names via visible text, aria-label, or aria-labelledby.',
      'IMAGE-ALT': 'Add alt attribute to images. Use descriptive text for meaningful images, empty alt="" for decorative ones.',
      'LANDMARK-UNIQUE': 'Ensure landmark roles are unique or have unique accessible names to distinguish them.',
      'DUPLICATE-ID': 'Remove or rename duplicate id attributes - each id must be unique within the document.',
      'ARIA-VALID-ATTR': 'Ensure ARIA attributes are valid and properly spelled (e.g., aria-label, aria-describedby).',
      'ARIA-VALID-ATTR-VALUE': 'Ensure ARIA attribute values are valid for the attribute type.',
      'ARIA-ROLES': 'Use valid ARIA roles and ensure they are applied to appropriate elements.',
      'TABINDEX': 'Avoid positive tabindex values. Use tabindex="0" to add to tab order or tabindex="-1" for programmatic focus.',
      'FOCUS-VISIBLE': 'Ensure interactive elements have visible focus indicators for keyboard navigation.',
      'LIST-STRUCTURE': 'Use proper list markup (<ul>, <ol>, <li>) for list content instead of styled paragraphs.',
      'TABLE-STRUCTURE': 'Use proper table markup with <thead>, <tbody>, <th>, and <td> for data tables.',
      'EPUB-TYPE-HAS-MATCHING-ROLE': 'Add ARIA role attribute to elements with epub:type to ensure accessibility tree mapping.',
      'METADATA-ACCESSMODE': 'Add schema:accessMode metadata (textual, visual, auditory) to package document.',
      'METADATA-ACCESSMODESUFFICIENT': 'Add schema:accessModeSufficient metadata to package document.',
      'METADATA-ACCESSIBILITYFEATURE': 'Add schema:accessibilityFeature metadata listing accessibility features.',
      'METADATA-ACCESSIBILITYHAZARD': 'Add schema:accessibilityHazard metadata (none, flashing, motion, sound).',
      'METADATA-ACCESSIBILITYSUMMARY': 'Add schema:accessibilitySummary with human-readable accessibility description.',
      'PKG-001': 'Fix package document structure according to EPUB specification requirements.',
      'OPF-014': 'Ensure package document metadata is complete and valid.',
      'OPF-085': 'Fix the dc:identifier value - it is marked as a UUID but contains an invalid format. Either use a valid UUID format (e.g., urn:uuid:550e8400-e29b-41d4-a716-446655440000) or remove the "urn:uuid:" prefix if using a different identifier scheme.',
      'OPF-086': 'Fix the unique-identifier reference - ensure dc:identifier has a matching id attribute.',
      'OPF-073': 'Add required dc:identifier element to package metadata.',
      'OPF-074': 'Add required dc:title element to package metadata.',
      'OPF-075': 'Add required dc:language element to package metadata.',
      'RSC-005': 'Fix resource file reference - ensure file exists and path is correct.',
      'HTM-004': 'Fix HTML markup errors - ensure valid, well-formed HTML5.',
      'CSS-001': 'Fix CSS syntax errors or invalid property values.',
      'NAV-001': 'Ensure navigation document (toc.xhtml) is present and valid.',
      'NCX-001': 'Ensure NCX navigation (for EPUB 2 compatibility) is valid if present.',
      'REGION-LABEL': 'Add aria-label or aria-labelledby to regions to provide accessible names.',
      'FRAME-TITLE': 'Add title attribute to iframe elements to describe their content.',
      'VIDEO-CAPTION': 'Provide captions for video content using <track kind="captions">.',
      'AUDIO-DESCRIPTION': 'Provide audio descriptions for video content with important visual information.',
    };
    
    const upperCode = code.toUpperCase();
    if (guidance[code]) {
      return guidance[code];
    }
    if (guidance[upperCode]) {
      return guidance[upperCode];
    }
    
    for (const [key, value] of Object.entries(guidance)) {
      if (upperCode.includes(key) || key.includes(upperCode)) {
        return value;
      }
    }
    
    return 'Review and manually remediate this accessibility issue according to WCAG guidelines. Check the issue message and location for specific details.';
  }

  private findResolvedIssues(
    originalTasks: RemediationTask[],
    newIssues: Array<{ code: string; location?: string }>
  ): string[] {
    const newIssueKeys = new Set(
      newIssues.map(i => `${i.code}:${i.location || ''}`)
    );

    const resolvedTaskIds: string[] = [];

    for (const task of originalTasks) {
      const taskKey = `${task.issueCode}:${task.location || ''}`;
      // Check if issue no longer exists in new audit, regardless of task status
      if (!newIssueKeys.has(taskKey)) {
        resolvedTaskIds.push(task.issueCode);
      }
    }

    return resolvedTaskIds;
  }

  async transferToAcr(jobId: string, options?: {
    edition?: string;
    productName?: string;
    vendor?: string;
    contactEmail?: string;
  }): Promise<{
    acrWorkflowId: string;
    transferredTasks: number;
    message: string;
  }> {
    const plan = await this.getRemediationPlan(jobId);
    if (!plan) {
      throw new Error('Remediation plan not found');
    }

    const pendingTasks = plan.tasks.filter(t => t.status === 'pending');

    if (pendingTasks.length === 0) {
      throw new Error('No pending tasks to transfer. All tasks are already completed.');
    }

    const originalJob = await prisma.job.findFirst({
      where: { id: jobId },
    });

    if (!originalJob) {
      throw new Error('Original job not found');
    }

    // Group tasks by WCAG criterion to create proper VPAT criteria entries
    const criteriaMap = new Map<string, {
      id: string;
      name: string;
      level: 'A' | 'AA' | 'AAA';
      tasks: typeof pendingTasks;
    }>();

    for (const task of pendingTasks) {
      // Get WCAG criteria codes from task
      const wcagCodes = Array.isArray(task.wcagCriteria)
        ? task.wcagCriteria
        : task.wcagCriteria
          ? [task.wcagCriteria]
          : [];

      if (wcagCodes.length === 0) {
        // If no WCAG code, try to infer from issue code
        const inferredCode = this.inferWcagCriterion(task.issueCode);
        if (inferredCode) {
          wcagCodes.push(inferredCode);
        }
      }

      // Add task to each related criterion
      for (const code of wcagCodes) {
        const criterion = wcagCriteriaService.getCriteriaById(code);
        if (criterion) {
          if (!criteriaMap.has(code)) {
            criteriaMap.set(code, {
              id: code,
              name: criterion.name,
              level: criterion.level,
              tasks: [],
            });
          }
          criteriaMap.get(code)!.tasks.push(task);
        }
      }
    }

    // Build ACR criteria from grouped tasks
    const acrCriteria = Array.from(criteriaMap.values()).map(entry => {
      // Combine issue descriptions from all related tasks
      const descriptions = entry.tasks.map(t => t.issueMessage).filter(Boolean);
      const locations = entry.tasks.map(t => t.location).filter(Boolean);
      
      return {
        id: entry.id,
        name: entry.name,
        level: entry.level,
        code: entry.tasks[0]?.issueCode || null,
        description: descriptions.join('; '),
        severity: entry.tasks[0]?.severity || 'medium',
        location: (locations.length > 0 ? locations.join(', ') : null) as string | null,
        status: 'not_verified' as const,
        wcagCriteria: entry.id as string | null,
        sourceTaskIds: entry.tasks.map(t => t.id),
        issueCount: entry.tasks.length,
        verifiedBy: null,
        verifiedAt: null,
        notes: null,
      };
    });

    // Also include unmapped tasks with fallback identifiers
    const unmappedTasks = pendingTasks.filter(task => {
      const wcagCodes = Array.isArray(task.wcagCriteria)
        ? task.wcagCriteria
        : task.wcagCriteria ? [task.wcagCriteria] : [];
      const inferredCode = this.inferWcagCriterion(task.issueCode);
      return wcagCodes.length === 0 && !inferredCode;
    });

    for (const task of unmappedTasks) {
      acrCriteria.push({
        id: task.issueCode || `issue-${task.id.slice(0, 8)}`,
        name: task.issueMessage || 'Accessibility Issue',
        level: 'A' as const,
        code: task.issueCode || null,
        description: task.issueMessage || '',
        severity: task.severity,
        location: task.location || null,
        status: 'not_verified' as const,
        wcagCriteria: null as string | null,
        sourceTaskIds: [task.id],
        issueCount: 1,
        verifiedBy: null,
        verifiedAt: null,
        notes: null,
      });
    }

    const acrWorkflow = {
      sourceJobId: jobId,
      fileName: plan.fileName,
      epubTitle: plan.fileName,
      productName: options?.productName || plan.fileName,
      status: 'needs_verification',
      sourceType: 'remediation',
      edition: options?.edition || null,
      vendor: options?.vendor || null,
      contactEmail: options?.contactEmail || null,
      totalCriteria: pendingTasks.length,
      verifiedCount: 0,
      criteria: acrCriteria,
      stats: {
        notVerified: pendingTasks.length,
        verified: 0,
        failed: 0,
        notApplicable: 0,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const acrJob = await prisma.job.create({
      data: {
        tenantId: originalJob.tenantId,
        userId: originalJob.userId,
        type: 'ACR_WORKFLOW',
        status: 'PROCESSING',
        input: { sourceJobId: jobId, sourceType: 'remediation' },
        output: JSON.parse(JSON.stringify(acrWorkflow)),
        startedAt: new Date(),
      },
    });

    // Also create AcrJob record for the Review & Edit page
    try {
      const acrJobRecord = await prisma.acrJob.create({
        data: {
          jobId: acrJob.id,
          tenantId: originalJob.tenantId,
          userId: originalJob.userId,
          edition: 'section508',
          documentTitle: plan.fileName || 'Untitled Document',
          status: 'in_progress',
        },
      });

      // Create AcrCriterionReview records based on WCAG criteria from pending tasks
      const wcagCriteriaSet = new Set<string>();
      for (const task of pendingTasks) {
        if (Array.isArray(task.wcagCriteria)) {
          task.wcagCriteria.forEach((c: string) => wcagCriteriaSet.add(c));
        } else if (task.wcagCriteria) {
          wcagCriteriaSet.add(task.wcagCriteria);
        }
      }

      // Create criterion reviews for affected WCAG criteria
      for (const criterionId of wcagCriteriaSet) {
        await prisma.acrCriterionReview.create({
          data: {
            acrJobId: acrJobRecord.id,
            criterionId,
            criterionNumber: criterionId,
            criterionName: `WCAG ${criterionId}`,
            level: criterionId.startsWith('1.4.') ? 'AA' : 'A',
            confidence: 50,
            aiStatus: 'needs_review',
          },
        });
      }

      logger.info(`[ACR Transfer] Created AcrJob ${acrJobRecord.id} with ${wcagCriteriaSet.size} criterion reviews`);
    } catch (acrJobError) {
      logger.warn(`[ACR Transfer] Could not create AcrJob record: ${acrJobError instanceof Error ? acrJobError.message : 'Unknown error'}`);
    }

    for (const task of pendingTasks) {
      await this.updateTaskStatus(
        jobId,
        task.id,
        'pending',
        undefined,
        undefined,
        { notes: `Transferred to ACR workflow: ${acrJob.id}` }
      );
    }

    logger.info(`[ACR Transfer] Transferred ${pendingTasks.length} tasks from job ${jobId} to ACR workflow ${acrJob.id}`);

    return {
      acrWorkflowId: acrJob.id,
      transferredTasks: pendingTasks.length,
      message: `${pendingTasks.length} tasks transferred to ACR workflow for verification`,
    };
  }

  async getAcrWorkflow(acrWorkflowId: string, tenantId?: string): Promise<{
    id: string;
    sourceJobId: string;
    fileName: string;
    status: string;
    totalCriteria: number;
    verifiedCount: number;
    criteria: Array<{
      id: string;
      code: string;
      description: string;
      severity: string;
      status: string;
    }>;
    stats: {
      notVerified: number;
      verified: number;
      failed: number;
      notApplicable: number;
    };
  } | null> {
    const acrJob = await prisma.job.findFirst({
      where: {
        id: acrWorkflowId,
        type: 'ACR_WORKFLOW',
        ...(tenantId && { tenantId }),
      },
    });

    if (!acrJob || !acrJob.output) {
      return null;
    }

    const workflow = acrJob.output as {
      sourceJobId: string;
      fileName: string;
      status: string;
      totalCriteria: number;
      verifiedCount: number;
      criteria: Array<{
        id: string;
        code: string;
        description: string;
        severity: string;
        status: string;
      }>;
      stats: {
        notVerified: number;
        verified: number;
        failed: number;
        notApplicable: number;
      };
    };

    return {
      id: acrJob.id,
      ...workflow,
    };
  }

  async updateAcrCriteriaStatus(
    acrWorkflowId: string,
    criteriaId: string,
    status: 'verified' | 'failed' | 'not_applicable',
    verifiedBy: string,
    notes?: string,
    tenantId?: string
  ): Promise<{ success: boolean; criteria: unknown }> {
    return await prisma.$transaction(async (tx) => {
      const acrJob = await tx.job.findFirst({
        where: {
          id: acrWorkflowId,
          type: 'ACR_WORKFLOW',
          ...(tenantId && { tenantId }),
        },
      });

      if (!acrJob || !acrJob.output) {
        throw new Error('ACR workflow not found');
      }

      const workflow = acrJob.output as {
        criteria: Array<{
          id: string;
          status: string;
          verifiedBy: string | null;
          verifiedAt: Date | null;
          notes: string | null;
        }>;
        stats: {
          notVerified: number;
          verified: number;
          failed: number;
          notApplicable: number;
        };
        verifiedCount: number;
        status: string;
        totalCriteria: number;
      };

      const criteriaIndex = workflow.criteria.findIndex(c => c.id === criteriaId);
      if (criteriaIndex === -1) {
        throw new Error('Criteria not found');
      }

      const criteria = workflow.criteria[criteriaIndex];
      const oldStatus = criteria.status;
      
      criteria.status = status;
      criteria.verifiedBy = verifiedBy;
      criteria.verifiedAt = new Date();
      if (notes) {
        criteria.notes = notes;
      }

      if (oldStatus === 'not_verified') {
        workflow.stats.notVerified--;
      } else if (oldStatus === 'verified') {
        workflow.stats.verified--;
      } else if (oldStatus === 'failed') {
        workflow.stats.failed--;
      } else if (oldStatus === 'not_applicable') {
        workflow.stats.notApplicable--;
      }

      if (status === 'verified') {
        workflow.stats.verified++;
      } else if (status === 'failed') {
        workflow.stats.failed++;
      } else if (status === 'not_applicable') {
        workflow.stats.notApplicable++;
      }

      workflow.verifiedCount = workflow.stats.verified + workflow.stats.failed + workflow.stats.notApplicable;

      if (workflow.verifiedCount === workflow.totalCriteria) {
        workflow.status = 'completed';
      } else {
        workflow.status = 'in_progress';
      }

      await tx.job.update({
        where: { id: acrWorkflowId },
        data: {
          output: JSON.parse(JSON.stringify(workflow)),
          status: workflow.status === 'completed' ? 'COMPLETED' : 'PROCESSING',
          completedAt: workflow.status === 'completed' ? new Date() : undefined,
        },
      });

      return { success: true, criteria };
    });
  }

  /**
   * Group issues by quick fix type for batch application
   */
  async getSimilarIssuesGrouping(jobId: string) {
    const plan = await this.getRemediationPlan(jobId);

    if (!plan) {
      return {
        totalIssues: 0,
        groups: [],
        batchableGroups: [],
        hasBatchableIssues: false
      };
    }

    const pendingTasks = plan.tasks.filter((t: RemediationTask) => t.status === 'pending' && t.quickFixable);

    const grouped = new Map<string, {
      fixType: string;
      fixName: string;
      issues: Array<{
        id: string;
        code: string;
        message: string;
        filePath: string | null;
        location: string | null;
        severity: string;
      }>;
      count: number;
      canBatchApply: boolean;
    }>();

    for (const task of pendingTasks) {
      const fixType = this.getQuickFixType(task.issueCode) || task.issueCode;
      const fixName = this.getFixNameFromCodeAndMessage(task.issueCode, task.issueMessage);

      if (!grouped.has(fixType)) {
        grouped.set(fixType, {
          fixType,
          fixName,
          issues: [],
          count: 0,
          canBatchApply: true
        });
      }

      const group = grouped.get(fixType)!;
      group.issues.push({
        id: task.id,
        code: task.issueCode,
        message: task.issueMessage,
        filePath: task.filePath ?? null,
        location: task.location ?? null,
        severity: task.severity
      });
      group.count++;
    }

    const groupsArray = Array.from(grouped.values());

    logger.info(`[Similar Issues] Found ${groupsArray.length} issue types, ${groupsArray.filter(g => g.count >= 3).length} batchable`);

    return {
      totalIssues: pendingTasks.length,
      groups: groupsArray,
      batchableGroups: groupsArray.filter(g => g.count >= 3),
      hasBatchableIssues: groupsArray.some(g => g.count >= 3)
    };
  }

  /**
   * Get friendly fix name from issue code and message
   */
  private getFixNameFromCodeAndMessage(code: string, message: string): string {
    const codeToName: Record<string, string> = {
      'EPUB-STRUCT-002': 'Add Table Headers',
      'epub_struct_002': 'Add Table Headers',
      'EPUB-A11Y-001': 'Add Image Alt Text',
      'EPUB-IMG-001': 'Add Image Alt Text',
      'epub_a11y_001': 'Add Image Alt Text',
      'EPUB-SEMANTICS-001': 'Add Landmark Roles',
      'EPUB-STRUCT-004': 'Add Landmark Roles',
      'epub_semantics_001': 'Add Landmark Roles',
      'EPUB-LANG-001': 'Add Language Attributes',
      'EPUB-SEM-001': 'Add Language Attributes',
      'epub_lang_001': 'Add Language Attributes',
      'EPUB-META-001': 'Add Document Language',
      'EPUB-META-002': 'Add Accessibility Features',
      'EPUB-META-003': 'Add Accessibility Summary',
      'EPUB-META-004': 'Add Access Modes',
      'EPUB-SEM-002': 'Fix Empty Links',
      'EPUB-STRUCT-003': 'Fix Heading Hierarchy',
      'EPUB-NAV-001': 'Add Skip Navigation',
      'EPUB-FIG-001': 'Add Figure Structure',
    };

    if (codeToName[code]) {
      return codeToName[code];
    }

    const lowerMessage = message.toLowerCase();
    if (lowerMessage.includes('table') && lowerMessage.includes('header')) {
      return 'Add Table Headers';
    }
    if (lowerMessage.includes('alt')) {
      return 'Add Image Alt Text';
    }
    if (lowerMessage.includes('landmark')) {
      return 'Add Landmark Roles';
    }
    if (lowerMessage.includes('language') || lowerMessage.includes('lang')) {
      return 'Add Language Attributes';
    }

    return `Fix ${code}`;
  }

  /**
   * Map issue code to quick fix type
   */
  private getQuickFixType(issueCode: string): string | null {
    const mapping: Record<string, string> = {
      'EPUB-STRUCT-002': 'addTableHeaders',
      'epub_struct_002': 'addTableHeaders',
      'epub_struct_table_headers': 'addTableHeaders',
      'EPUB-IMG-001': 'addImageAltText',
      'epub_a11y_001': 'addImageAltText',
      'epub_images_alt': 'addImageAltText',
      'EPUB-STRUCT-004': 'addLandmarkRoles',
      'epub_semantics_001': 'addLandmarkRoles',
      'epub_landmarks': 'addLandmarkRoles',
      'EPUB-SEM-001': 'addLanguageAttribute',
      'epub_lang_001': 'addLanguageAttribute',
      'EPUB-META-001': 'addDcLanguage',
      'EPUB-META-002': 'addAccessibilityFeatures',
      'EPUB-META-003': 'addAccessibilitySummary',
      'EPUB-META-004': 'addAccessModes',
      'EPUB-SEM-002': 'fixEmptyLinks',
      'EPUB-STRUCT-003': 'fixHeadingHierarchy',
      'EPUB-NAV-001': 'addSkipNavigation',
      'EPUB-FIG-001': 'addFigureStructure',
    };

    return mapping[issueCode] || null;
  }

  /**
   * Get human-readable fix name
   */
  private getFixName(fixType: string): string {
    const names: Record<string, string> = {
      'addTableHeaders': 'Add Table Headers',
      'addImageAltText': 'Add Alt Text to Images',
      'addLandmarkRoles': 'Add Landmark Roles',
      'addLanguageAttribute': 'Add Language Attributes',
      'addDcLanguage': 'Add Document Language',
      'addAccessibilityFeatures': 'Add Accessibility Features Metadata',
      'addAccessibilitySummary': 'Add Accessibility Summary',
      'addAccessModes': 'Add Access Modes',
      'fixEmptyLinks': 'Fix Empty Links',
      'fixHeadingHierarchy': 'Fix Heading Hierarchy',
      'addSkipNavigation': 'Add Skip Navigation',
      'addFigureStructure': 'Add Figure Structure',
    };

    return names[fixType] || fixType;
  }

  /**
   * Infer WCAG criterion from issue code
   */
  private inferWcagCriterion(issueCode: string | undefined): string | null {
    if (!issueCode) return null;

    // Map common issue codes to WCAG criteria
    const issueToWcagMap: Record<string, string> = {
      // Image alt text issues -> 1.1.1 Non-text Content
      'EPUB-IMG-001': '1.1.1',
      'IMG-ALT': '1.1.1',
      'missing-alt': '1.1.1',
      'image-alt': '1.1.1',
      
      // Structure issues -> 1.3.1 Info and Relationships
      'EPUB-STRUCT-002': '1.3.1',
      'EPUB-STRUCT-003': '1.3.1',
      'EPUB-STRUCT-004': '1.3.1',
      'table-headers': '1.3.1',
      'heading-hierarchy': '1.3.1',
      'landmark-roles': '1.3.1',
      
      // Language issues -> 3.1.1 Language of Page
      'EPUB-META-001': '3.1.1',
      'EPUB-SEM-001': '3.1.1',
      'html-lang': '3.1.1',
      'document-language': '3.1.1',
      
      // Contrast issues -> 1.4.3 Contrast (Minimum)
      'color-contrast': '1.4.3',
      'contrast': '1.4.3',
      
      // Link issues -> 2.4.4 Link Purpose (In Context)
      'EPUB-SEM-002': '2.4.4',
      'empty-links': '2.4.4',
      'link-name': '2.4.4',
      
      // Navigation issues -> 2.4.1 Bypass Blocks
      'EPUB-NAV-001': '2.4.1',
      'skip-navigation': '2.4.1',
      'bypass-blocks': '2.4.1',
      
      // Figure structure -> 1.1.1 Non-text Content
      'EPUB-FIG-001': '1.1.1',
      'figure-caption': '1.1.1',
      
      // Metadata issues (accessibility features)
      'EPUB-META-002': '4.1.2',
      'EPUB-META-003': '4.1.2',
      'EPUB-META-004': '4.1.2',
    };

    // Check direct match
    if (issueToWcagMap[issueCode]) {
      return issueToWcagMap[issueCode];
    }

    // Check if issue code contains WCAG pattern (e.g., "WCAG-1.1.1")
    const wcagPattern = issueCode.match(/(\d+\.\d+\.\d+)/);
    if (wcagPattern) {
      return wcagPattern[1];
    }

    return null;
  }

  /**
   * Automatically apply high-confidence fixes
   */
  async autoApplyHighConfidenceFixes(jobId: string) {
    logger.info(`[AutoFix] Starting automatic fix application for job ${jobId}`);

    const plan = await this.getRemediationPlan(jobId);

    if (!plan) {
      logger.warn(`[AutoFix] No remediation plan found for job ${jobId}`);
      return { applied: 0, failed: 0, skipped: 0, details: [] };
    }

    const autofixTasks = (plan.tasks || []).filter((t: { status?: string; autoFixable?: boolean }) => 
      t.status === 'pending' && 
      t.autoFixable === true
    );

    if (autofixTasks.length === 0) {
      logger.info('[AutoFix] No high-confidence issues to auto-apply');
      return { applied: 0, failed: 0, skipped: 0, details: [] };
    }

    logger.info(`[AutoFix] Found ${autofixTasks.length} high-confidence issues to auto-apply`);

    const results: {
      applied: number;
      failed: number;
      skipped: number;
      details: Array<{ taskId: string; code: string; status: string; description?: string; error?: string }>;
    } = {
      applied: 0,
      failed: 0,
      skipped: 0,
      details: []
    };

    const { fileStorageService } = await import('../storage/file-storage.service');
    const { epubModifier } = await import('./epub-modifier.service');

    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (!job) {
      logger.error(`[AutoFix] Job ${jobId} not found`);
      return results;
    }

    const input = job.input as { fileName?: string };
    const originalFileName = input?.fileName || 'upload.epub';
    const remediatedFileName = originalFileName.replace(/\.epub$/i, '_remediated.epub');

    let epubBuffer = await fileStorageService.getRemediatedFile(jobId, remediatedFileName);
    if (!epubBuffer) {
      epubBuffer = await fileStorageService.getFile(jobId, originalFileName);
    }

    if (!epubBuffer) {
      logger.error(`[AutoFix] EPUB file not found for job ${jobId}`);
      return results;
    }

    const zip = await epubModifier.loadEPUB(epubBuffer);

    const codeGroups = new Map<string, typeof autofixTasks>();
    for (const task of autofixTasks) {
      const code = task.issueCode;
      if (!codeGroups.has(code)) {
        codeGroups.set(code, []);
      }
      codeGroups.get(code)!.push(task);
    }

    for (const [code, tasks] of codeGroups) {
      try {
        let fixResults: ModificationResult[] = [];

        switch (code) {
          case 'EPUB-META-001':
            fixResults = [await epubModifier.addLanguage(zip)];
            break;
          case 'EPUB-META-002':
            fixResults = await epubModifier.addAccessibilityMetadata(zip);
            break;
          case 'EPUB-META-003':
            fixResults = [await epubModifier.addAccessibilitySummary(zip)];
            break;
          case 'EPUB-META-004':
            fixResults = await epubModifier.addAccessibilityMetadata(zip, ['accessMode']);
            break;
          case 'EPUB-SEM-001':
            fixResults = await epubModifier.addHtmlLangAttributes(zip);
            break;
          case 'EPUB-NAV-001':
            fixResults = await epubModifier.addSkipNavigation(zip);
            break;
          case 'EPUB-STRUCT-004':
            // Pass target file locations so landmarks are added to the correct files
            const targetLocations = tasks
              .map(t => t.location)
              .filter((loc): loc is string => !!loc);
            fixResults = await epubModifier.addAriaLandmarks(zip, targetLocations);
            break;
          default:
            logger.debug(`[AutoFix] No auto-fix handler for ${code}, skipping`);
            for (const task of tasks) {
              results.skipped++;
              results.details.push({ taskId: task.id, code, status: 'skipped' });
            }
            continue;
        }

        const successCount = fixResults.filter(r => r.success).length;
        if (successCount > 0) {
          // Log changes for Visual Comparison feature
          const { ComparisonService } = await import('../comparison/comparison.service');
          const comparisonService = new ComparisonService(prisma);
          for (const result of fixResults.filter(r => r.success)) {
            try {
              await comparisonService.logChange({
                jobId,
                taskId: tasks[0]?.id,
                ruleId: code,
                filePath: result.filePath,
                changeType: code.toLowerCase().replace(/-/g, '_'),
                description: result.description,
                beforeContent: result.before,
                afterContent: result.after,
                severity: 'MAJOR',
                appliedBy: 'system',
              });
            } catch (logError) {
              logger.warn(`[AutoFix] Failed to log change for ${result.filePath}: ${logError instanceof Error ? logError.message : String(logError)}`);
            }
          }

          // Extract resolved location from fix results (computed once for all tasks)
          const modifiedFiles = fixResults
            .filter(r => r.success && r.filePath && r.filePath !== 'all')
            .map(r => r.filePath);

          for (const task of tasks) {
            // Each task prefers its own location if that location appears in modified files
            const resolvedLocation = modifiedFiles.includes(task.location || '')
              ? task.location
              : (modifiedFiles.length > 0 ? modifiedFiles[0] : task.location);

            await this.updateTaskStatus(
              jobId,
              task.id,
              'completed',
              `Auto-applied high-confidence fix`,
              'system',
              {
                resolvedLocation,
                resolvedFiles: modifiedFiles.length > 0 ? modifiedFiles : undefined,
              }
            );
            results.applied++;
            results.details.push({
              taskId: task.id,
              code,
              status: 'success',
              description: fixResults[0]?.description || `Applied ${code}`
            });
          }
          logger.info(`[AutoFix] Successfully applied ${code} fix for ${tasks.length} tasks`);
        } else {
          for (const task of tasks) {
            results.failed++;
            results.details.push({ taskId: task.id, code, status: 'failed', error: 'Fix returned no success' });
          }
        }
      } catch (error) {
        logger.error(`[AutoFix] Error applying fix for ${code}`, error instanceof Error ? error : undefined);
        for (const task of tasks) {
          results.failed++;
          results.details.push({
            taskId: task.id,
            code,
            status: 'error',
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      }
    }

    if (results.applied > 0) {
      let modifiedBuffer = await epubModifier.saveEPUB(zip);

      // Phase 2: Post-modification landmark validation
      logger.info('[Post-Modification] Validating landmarks after all fixes...');
      const landmarkValidation = await epubModifier.validateAndFixLandmarks(modifiedBuffer);

      if (landmarkValidation.success && landmarkValidation.changes.length > 0) {
        logger.info(`[Post-Modification] Applied ${landmarkValidation.changes.length} landmark fixes`);
        if (landmarkValidation.buffer) {
          modifiedBuffer = landmarkValidation.buffer;
        }

        // Track landmark fixes in results
        results.applied += landmarkValidation.changes.length;
        for (const change of landmarkValidation.changes) {
          logger.info(`  - ${change.filePath}: ${change.description}`);
        }
      } else if (landmarkValidation.success) {
        logger.info('[Post-Modification] All landmarks validated - no fixes needed');
      } else {
        logger.warn('[Post-Modification] Landmark validation failed:', landmarkValidation.error);
      }

      await fileStorageService.saveRemediatedFile(jobId, remediatedFileName, modifiedBuffer);
      logger.info(`[AutoFix] Saved remediated EPUB after ${results.applied} auto-fixes (including landmark validation)`);
    }

    logger.info(`[AutoFix] Results: ${results.applied} applied, ${results.failed} failed, ${results.skipped} skipped`);

    return results;
  }
}

export const remediationService = new RemediationService();
export type { RemediationPlan, RemediationTask, RemediationStatus, RemediationPriority, RemediationType };
