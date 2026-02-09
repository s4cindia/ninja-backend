/**
 * PDF Remediation Service
 *
 * Handles PDF remediation plan creation, task management, and classification
 */

import { nanoid } from 'nanoid';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { classifyIssueType } from '../../constants/pdf-fix-classification';
import type {
  RemediationPlan,
  RemediationTask,
  RemediationSummary,
  FixType,
  UpdateTaskStatusRequest,
  UpdateTaskStatusResponse,
} from '../../types/pdf-remediation.types';

/**
 * Classified issues by fix type
 */
interface ClassifiedIssues {
  autoFixable: Array<Record<string, unknown>>;
  quickFix: Array<Record<string, unknown>>;
  manual: Array<Record<string, unknown>>;
}

/**
 * PDF Remediation Service
 */
class PdfRemediationService {
  /**
   * Creates a remediation plan for a PDF job
   *
   * @param jobId - Job ID
   * @returns Remediation plan with tasks
   */
  async createRemediationPlan(jobId: string): Promise<RemediationPlan> {
    logger.info(`[PDF Remediation] Creating remediation plan for job ${jobId}`);

    // Fetch job with validation results
    const job = await prisma.job.findUnique({
      where: { id: jobId },
      include: {
        validationResults: {
          include: {
            issues: {
              where: {
                status: 'PENDING', // Only include unresolved issues
              },
            },
          },
        },
      },
    });

    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }

    if (job.type !== 'PDF_ACCESSIBILITY') {
      throw new Error(`Job ${jobId} is not a PDF accessibility audit`);
    }

    if (job.status !== 'COMPLETED') {
      throw new Error(`Job ${jobId} has not completed yet`);
    }

    // Extract all issues from validation results
    const allIssues = job.validationResults.flatMap((vr) => vr.issues);

    if (allIssues.length === 0) {
      logger.warn(`[PDF Remediation] No issues found for job ${jobId}`);
    }

    logger.info(`[PDF Remediation] Found ${allIssues.length} issues to remediate`);

    // Classify issues by fix type
    const classified = await this.classifyIssues(allIssues);

    // Create remediation tasks
    const tasks: RemediationTask[] = allIssues.map((issue) => {
      const fixType = this.getFixTypeForIssue(issue);

      return {
        id: `task-${nanoid(8)}`,
        issueId: issue.id,
        issueCode: issue.code || 'UNKNOWN',
        description: issue.description,
        severity: this.mapIssueSeverity(issue.severity),
        type: fixType,
        status: 'PENDING',
        filePath: issue.filePath || undefined,
        location: issue.location || undefined,
      };
    });

    // Sort tasks by severity priority (critical first)
    const severityOrder: Record<string, number> = {
      critical: 0,
      serious: 1,
      moderate: 2,
      minor: 3,
    };

    tasks.sort(
      (a, b) =>
        (severityOrder[a.severity] || 999) - (severityOrder[b.severity] || 999)
    );

    // Get file name from job input
    const jobInput = job.input as { fileName?: string };
    const fileName = jobInput?.fileName || 'document.pdf';

    // Build remediation plan
    const plan: RemediationPlan = {
      jobId,
      fileName,
      totalIssues: tasks.length,
      autoFixableCount: classified.autoFixable.length,
      quickFixCount: classified.quickFix.length,
      manualFixCount: classified.manual.length,
      tasks,
      createdAt: new Date(),
    };

    // Store plan in database as BATCH_VALIDATION job
    await prisma.job.create({
      data: {
        id: nanoid(),
        tenantId: job.tenantId,
        userId: job.userId,
        type: 'BATCH_VALIDATION',
        status: 'COMPLETED',
        input: {
          sourceJobId: jobId,
          planType: 'pdf_remediation',
        },
        output: JSON.parse(JSON.stringify(plan)),
        completedAt: new Date(),
        updatedAt: new Date(),
      },
    });

    logger.info(
      `[PDF Remediation] Created plan with ${tasks.length} tasks: ${classified.autoFixable.length} auto, ${classified.quickFix.length} quick-fix, ${classified.manual.length} manual`
    );

    return plan;
  }

  /**
   * Retrieves existing remediation plan
   *
   * @param jobId - Source job ID
   * @returns Remediation plan or null if not found
   */
  async getRemediationPlan(jobId: string): Promise<RemediationPlan> {
    logger.info(`[PDF Remediation] Retrieving plan for job ${jobId}`);

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
      throw new Error(`Remediation plan not found for job ${jobId}`);
    }

    const plan = planJob.output as unknown as RemediationPlan;

    // Ensure dates are Date objects
    plan.createdAt = new Date(plan.createdAt);

    logger.info(
      `[PDF Remediation] Retrieved plan with ${plan.totalIssues} tasks`
    );

    return plan;
  }

  /**
   * Classifies issues by fix type
   *
   * @param issues - Array of issues
   * @returns Classified issues
   */
  async classifyIssues(
    issues: Array<Record<string, unknown>>
  ): Promise<ClassifiedIssues> {
    const autoFixable: Array<Record<string, unknown>> = [];
    const quickFix: Array<Record<string, unknown>> = [];
    const manual: Array<Record<string, unknown>> = [];

    for (const issue of issues) {
      const code = (issue.code as string) || '';
      const fixType = classifyIssueType(code);

      switch (fixType) {
        case 'AUTO_FIXABLE':
          autoFixable.push(issue);
          break;
        case 'QUICK_FIX':
          quickFix.push(issue);
          break;
        case 'MANUAL':
          manual.push(issue);
          break;
      }
    }

    logger.info(
      `[PDF Remediation] Classified ${issues.length} issues: ${autoFixable.length} auto, ${quickFix.length} quick-fix, ${manual.length} manual`
    );

    return { autoFixable, quickFix, manual };
  }

  /**
   * Updates task status
   *
   * @param jobId - Job ID
   * @param taskId - Task ID
   * @param request - Update request
   * @returns Updated task and summary
   */
  async updateTaskStatus(
    jobId: string,
    taskId: string,
    request: UpdateTaskStatusRequest
  ): Promise<UpdateTaskStatusResponse> {
    logger.info(
      `[PDF Remediation] Updating task ${taskId} status to ${request.status}`
    );

    return await prisma.$transaction(async (tx) => {
      // Find the plan job
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
        throw new Error(`Remediation plan not found for job ${jobId}`);
      }

      const plan = planJob.output as unknown as RemediationPlan;

      // Find task in plan
      const taskIndex = plan.tasks.findIndex((t: RemediationTask) => t.id === taskId);

      if (taskIndex === -1) {
        throw new Error(`Task ${taskId} not found in plan`);
      }

      const task = plan.tasks[taskIndex];

      // Update task status
      task.status = request.status;

      // Update plan in database
      await tx.job.update({
        where: { id: planJob.id },
        data: {
          output: JSON.parse(JSON.stringify(plan)),
          updatedAt: new Date(),
        },
      });

      // Update corresponding Issue record if task completed
      if (request.status === 'COMPLETED') {
        await tx.issue.updateMany({
          where: {
            id: task.issueId,
            status: 'PENDING',
          },
          data: {
            status: 'REMEDIATED',
            fixedAt: new Date(),
            fixedBy: 'user',
            remediationMethod: this.getRemediationMethod(task.type),
            remediationTaskId: taskId,
          },
        });

        logger.info(
          `[PDF Remediation] Marked issue ${task.issueId} as REMEDIATED`
        );
      }

      // Calculate summary
      const summary = this.calculateSummary(plan);

      logger.info(
        `[PDF Remediation] Updated task ${taskId}. Progress: ${summary.completionPercentage}%`
      );

      return {
        task,
        summary,
      };
    });
  }

  /**
   * Gets fix type for an issue
   *
   * @param issue - Issue object
   * @returns Fix type
   */
  private getFixTypeForIssue(issue: Record<string, unknown>): FixType {
    const code = (issue.code as string) || '';
    return classifyIssueType(code);
  }

  /**
   * Maps issue severity to plan severity format
   *
   * @param severity - Prisma IssueSeverity enum
   * @returns Plan severity string
   */
  private mapIssueSeverity(severity: string): string {
    const map: Record<string, string> = {
      CRITICAL: 'critical',
      MAJOR: 'serious',
      MINOR: 'moderate',
      INFO: 'minor',
    };

    return map[severity] || 'moderate';
  }

  /**
   * Gets remediation method string from fix type
   *
   * @param fixType - Fix type
   * @returns Remediation method
   */
  private getRemediationMethod(fixType: FixType): string {
    const map: Record<FixType, string> = {
      AUTO_FIXABLE: 'auto',
      QUICK_FIX: 'quick-fix',
      MANUAL: 'manual',
    };

    return map[fixType] || 'manual';
  }

  /**
   * Calculates summary statistics for a plan
   *
   * @param plan - Remediation plan
   * @returns Summary statistics
   */
  private calculateSummary(plan: RemediationPlan): RemediationSummary {
    const byStatus = {
      pending: 0,
      inProgress: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
    };

    const byType = {
      autoFixable: 0,
      quickFix: 0,
      manual: 0,
    };

    for (const task of plan.tasks) {
      // Count by status
      const status = task.status.toLowerCase() as keyof typeof byStatus;
      if (status in byStatus) {
        byStatus[status]++;
      }

      // Count by type
      switch (task.type) {
        case 'AUTO_FIXABLE':
          byType.autoFixable++;
          break;
        case 'QUICK_FIX':
          byType.quickFix++;
          break;
        case 'MANUAL':
          byType.manual++;
          break;
      }
    }

    const completedOrSkipped = byStatus.completed + byStatus.skipped;
    const completionPercentage =
      plan.tasks.length > 0
        ? Math.round((completedOrSkipped / plan.tasks.length) * 100)
        : 100;

    return {
      total: plan.tasks.length,
      byStatus,
      byType,
      completionPercentage,
    };
  }
}

// Export singleton instance
export const pdfRemediationService = new PdfRemediationService();
