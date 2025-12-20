import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';

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

const AUTO_FIXABLE_CODES = [
  'EPUB-META-001',
  'EPUB-META-002',
  'EPUB-META-003',
  'EPUB-META-004',
  'EPUB-NAV-002',
  'EPUB-NAV-003',
];

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
    const issues = (auditData.combinedIssues as Array<Record<string, unknown>>) || [];

    const tasks: RemediationTask[] = issues.map((issue, index: number) => {
      const issueCode = (issue.code as string) || '';
      const isAutoFixable = AUTO_FIXABLE_CODES.includes(issueCode);
      const severity = (issue.severity as string) || 'moderate';
      
      return {
        id: `task-${jobId.slice(0, 8)}-${index + 1}`,
        jobId,
        issueId: (issue.id as string) || `issue-${index + 1}`,
        issueCode,
        issueMessage: (issue.message as string) || '',
        severity,
        category: (issue.category as string) || 'general',
        location: issue.location as string | undefined,
        status: 'pending' as RemediationStatus,
        priority: SEVERITY_TO_PRIORITY[severity] || 'medium',
        type: isAutoFixable ? 'auto' : 'manual' as RemediationType,
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
    resolvedBy?: string
  ): Promise<RemediationTask> {
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

    await prisma.job.update({
      where: { id: planJob.id },
      data: { output: JSON.parse(JSON.stringify(plan)) },
    });

    return task;
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

  private async autoFix(task: RemediationTask): Promise<{ success: boolean; message: string }> {
    switch (task.issueCode) {
      case 'EPUB-META-001':
        return { success: true, message: 'Would add <dc:language>en</dc:language> to package document' };
      case 'EPUB-META-002':
        return { success: true, message: 'Would add schema:accessibilityFeature metadata with standard values' };
      case 'EPUB-META-003':
        return { success: true, message: 'Would add schema:accessibilitySummary with auto-generated description' };
      case 'EPUB-META-004':
        return { success: true, message: 'Would add schema:accessMode with "textual" value' };
      case 'EPUB-NAV-002':
        return { success: true, message: 'Would generate page-list navigation from content structure' };
      case 'EPUB-NAV-003':
        return { success: true, message: 'Would generate landmarks navigation with bodymatter, toc entries' };
      default:
        throw new Error(`No auto-fix available for ${task.issueCode}`);
    }
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
}

export const remediationService = new RemediationService();
export type { RemediationPlan, RemediationTask, RemediationStatus, RemediationPriority, RemediationType };
