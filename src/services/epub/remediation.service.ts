import crypto from 'crypto';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { epubAuditService } from './epub-audit.service';
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
  createdAt: Date;
  updatedAt: Date;
  filePath?: string;
  selector?: string;
  wcagCriteria?: string[];
  source?: string;
  html?: string;
  remediation?: string;
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
    const jsAuditorCodes = new Set(
      validatedIssues
        .filter(i => (i.source as string) === 'js-auditor')
        .map(i => i.code as string)
    );
    
    const deduplicatedIssues = validatedIssues.filter(issue => {
      const code = issue.code as string;
      const source = issue.source as string;
      
      // If this is an ACE issue that maps to a JS Auditor code that's already present, skip it
      const mappedCode = DUPLICATE_CODE_MAP[code];
      if (mappedCode && source === 'ace' && jsAuditorCodes.has(mappedCode)) {
        logger.info(`  Skipping duplicate ACE issue ${code} (covered by JS Auditor ${mappedCode})`);
        return false;
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
        tenantId: job.tenantId,
        userId: job.userId,
        type: 'BATCH_VALIDATION',
        status: 'COMPLETED',
        input: { sourceJobId: jobId, planType: 'remediation' },
        output: JSON.parse(JSON.stringify(plan)),
        completedAt: new Date(),
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
    options?: { notes?: string; completionMethod?: 'auto' | 'manual' | 'verified' }
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
  }> {
    const originalPlan = await this.getRemediationPlan(jobId);
    if (!originalPlan) {
      throw new Error('Original remediation plan not found');
    }

    logger.info(`[Re-audit] Starting re-audit for job ${jobId}, file: ${file.originalname}`);

    const newAuditResult = await epubAuditService.runAudit(
      file.buffer,
      `reaudit-${jobId}`,
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
      if (!newIssueKeys.has(taskKey) && task.status === 'pending') {
        resolvedTaskIds.push(task.id);
      }
    }

    return resolvedTaskIds;
  }

  async transferToAcr(jobId: string): Promise<{
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

    const acrCriteria = pendingTasks.map(task => ({
      id: `acr-${task.id}`,
      code: task.issueCode,
      description: task.issueMessage,
      severity: task.severity,
      location: task.location,
      status: 'not_verified' as const,
      wcagCriteria: Array.isArray(task.wcagCriteria)
        ? task.wcagCriteria.join(', ')
        : task.wcagCriteria || null,
      sourceTaskId: task.id,
      verifiedBy: null,
      verifiedAt: null,
      notes: null,
    }));

    const acrWorkflow = {
      sourceJobId: jobId,
      fileName: plan.fileName,
      status: 'needs_verification',
      sourceType: 'remediation',
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
}

export const remediationService = new RemediationService();
export type { RemediationPlan, RemediationTask, RemediationStatus, RemediationPriority, RemediationType };
