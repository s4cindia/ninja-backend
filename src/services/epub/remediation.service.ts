import crypto from 'crypto';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { epubAuditService } from './epub-audit.service';

type RemediationStatus = 'pending' | 'in_progress' | 'completed' | 'skipped' | 'failed';
type RemediationPriority = 'critical' | 'high' | 'medium' | 'low';
type RemediationType = 'auto' | 'manual' | 'hybrid';

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
  suggestion?: string;
  resolution?: string;
  resolvedBy?: string;
  resolvedAt?: Date;
  notes?: string;
  completionMethod?: 'auto' | 'manual' | 'verified';
  createdAt: Date;
  updatedAt: Date;
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
    manualRequired: number;
  };
  createdAt: Date;
  updatedAt: Date;
}

// Auto-fixable codes - must match handlers in auto-remediation.service.ts
const AUTO_FIX_HANDLERS: Record<string, { handler: () => { success: boolean; message: string } }> = {
  // Metadata issues
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
  // Semantic issues
  'EPUB-SEM-001': {
    handler: () => ({ success: true, message: 'Would add lang attribute to HTML elements' }),
  },
  'EPUB-SEM-002': {
    handler: () => ({ success: true, message: 'Would fix empty links with aria-label' }),
  },
  // Image issues
  'EPUB-IMG-001': {
    handler: () => ({ success: true, message: 'Would add alt text to images' }),
  },
  // Structure issues
  'EPUB-STRUCT-002': {
    handler: () => ({ success: true, message: 'Would add table headers' }),
  },
  'EPUB-STRUCT-003': {
    handler: () => ({ success: true, message: 'Would fix heading hierarchy' }),
  },
  'EPUB-STRUCT-004': {
    handler: () => ({ success: true, message: 'Would add ARIA landmarks' }),
  },
  // Navigation issues
  'EPUB-NAV-001': {
    handler: () => ({ success: true, message: 'Would add skip navigation links' }),
  },
  // Figure issues
  'EPUB-FIG-001': {
    handler: () => ({ success: true, message: 'Would add figure/figcaption structure' }),
  },
};

const isAutoFixableCode = (code: string): boolean => code in AUTO_FIX_HANDLERS;

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

    const validatedIssues = issues.filter(issue => {
      if (!issue || typeof issue !== 'object') {
        logger.warn('Skipping invalid issue entry');
        return false;
      }
      return true;
    });

    const tasks: RemediationTask[] = validatedIssues.map((issue) => {
      const issueCode = (issue.code as string) || '';
      const issueLocation = (issue.location as string) || '';
      const isAutoFixable = isAutoFixableCode(issueCode);
      const severity = (issue.severity as string) || 'moderate';
      const taskId = crypto.createHash('md5')
        .update(`${jobId}-${issueCode}-${issueLocation}`)
        .digest('hex')
        .substring(0, 8);
      
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
        type: (isAutoFixable ? 'auto' : 'manual') as RemediationType,
        suggestion: issue.suggestion as string | undefined,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    });

    const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    tasks.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

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
        autoFixable: tasks.filter(t => t.type === 'auto').length,
        manualRequired: tasks.filter(t => t.type === 'manual').length,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

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

      plan.stats = {
        pending: plan.tasks.filter(t => t.status === 'pending').length,
        inProgress: plan.tasks.filter(t => t.status === 'in_progress').length,
        completed: plan.tasks.filter(t => t.status === 'completed').length,
        skipped: plan.tasks.filter(t => t.status === 'skipped').length,
        failed: plan.tasks.filter(t => t.status === 'failed').length,
        autoFixable: plan.tasks.filter(t => t.type === 'auto').length,
        manualRequired: plan.tasks.filter(t => t.type === 'manual').length,
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

  private findResolvedIssues(
    originalTasks: RemediationTask[],
    newIssues: Array<{ code: string }>
  ): string[] {
    const newIssueCodes = new Set(newIssues.map(i => i.code));
    const resolvedCodes: string[] = [];
    
    for (const task of originalTasks) {
      if (!newIssueCodes.has(task.issueCode) && task.status === 'pending') {
        resolvedCodes.push(task.issueCode);
      }
    }
    
    return [...new Set(resolvedCodes)];
  }
}

export const remediationService = new RemediationService();
export type { RemediationPlan, RemediationTask, RemediationStatus, RemediationPriority, RemediationType };
