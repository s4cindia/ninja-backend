import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { remediationService } from '../epub/remediation.service';
import { sseService } from '../../sse/sse.service';

interface QuickFixResult {
  success: boolean;
  filesProcessed: number;
  issuesFixed: number;
  errors: string[];
}

class BatchQuickFixService {
  /**
   * Apply quick-fixes to all files in a batch
   */
  async applyQuickFixes(batchId: string, tenantId: string, userId: string): Promise<QuickFixResult> {
    logger.info(`[Batch ${batchId}] Starting batch quick-fix application`);

    const batch = await prisma.batch.findFirst({
      where: { id: batchId, tenantId },
      include: {
        files: {
          where: {
            status: 'REMEDIATED',
          },
          select: {
            id: true,
            originalName: true,
            auditJobId: true,
            issuesQuickFix: true,
            status: true,
          },
        },
      },
    });

    if (!batch) {
      throw new Error('Batch not found');
    }

    if (batch.status !== 'COMPLETED') {
      throw new Error('Batch must be completed before applying quick-fixes');
    }

    const filesWithQuickFixes = batch.files.filter(f => (f.issuesQuickFix || 0) > 0);

    if (filesWithQuickFixes.length === 0) {
      return {
        success: true,
        filesProcessed: 0,
        issuesFixed: 0,
        errors: ['No quick-fixes available to apply'],
      };
    }

    logger.info(`[Batch ${batchId}] Found ${filesWithQuickFixes.length} files with quick-fixes`);

    const results: QuickFixResult = {
      success: true,
      filesProcessed: 0,
      issuesFixed: 0,
      errors: [],
    };

    // Broadcast start event
    sseService.broadcastToChannel(`batch:${batchId}`, {
      type: 'quick_fix_started',
      batchId,
      totalFiles: filesWithQuickFixes.length,
    }, tenantId);

    for (const file of filesWithQuickFixes) {
      try {
        if (!file.auditJobId) {
          results.errors.push(`${file.originalName}: No audit job ID`);
          continue;
        }

        logger.info(`[Batch ${batchId}] Applying quick-fixes for ${file.originalName}`);

        // Get the remediation plan for this file
        const plan = await remediationService.getRemediationPlan(file.auditJobId);
        
        if (!plan) {
          results.errors.push(`${file.originalName}: No remediation plan found`);
          continue;
        }

        // Get quick-fix tasks from the plan
        const quickFixTasks = plan.tasks.filter(
          (t: { type: string; status: string }) => 
            t.type === 'quickfix' && t.status === 'pending'
        );

        if (quickFixTasks.length === 0) {
          logger.info(`[Batch ${batchId}] No pending quick-fix tasks for ${file.originalName}`);
          continue;
        }

        // Apply quick-fixes using remediation service
        let fixedCount = 0;
        for (const task of quickFixTasks) {
          try {
            await remediationService.updateTaskStatus(
              file.auditJobId,
              task.id,
              'completed',
              'Applied via batch quick-fix',
              'system',
              { completionMethod: 'auto' }
            );
            fixedCount++;
          } catch (taskError) {
            logger.warn(`[Batch ${batchId}] Failed to apply task ${task.id}: ${taskError}`);
          }
        }

        // Update file record
        await prisma.batchFile.update({
          where: { id: file.id },
          data: {
            issuesQuickFix: 0,
            issuesAutoFixed: {
              increment: fixedCount,
            },
          },
        });

        results.filesProcessed++;
        results.issuesFixed += fixedCount;

        // Broadcast progress
        sseService.broadcastToChannel(`batch:${batchId}`, {
          type: 'quick_fix_file_completed',
          batchId,
          fileId: file.id,
          fileName: file.originalName,
          issuesFixed: fixedCount,
        }, tenantId);

        logger.info(`[Batch ${batchId}] Applied ${fixedCount} quick-fixes for ${file.originalName}`);

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        results.errors.push(`${file.originalName}: ${errorMessage}`);
        logger.error(`[Batch ${batchId}] Quick-fix error for ${file.originalName}:`, error instanceof Error ? error : undefined);
      }
    }

    // Update batch statistics
    await prisma.batch.update({
      where: { id: batchId },
      data: {
        quickFixIssues: { decrement: results.issuesFixed },
        autoFixedIssues: { increment: results.issuesFixed },
      },
    });

    // Broadcast completion
    sseService.broadcastToChannel(`batch:${batchId}`, {
      type: 'quick_fix_completed',
      batchId,
      filesProcessed: results.filesProcessed,
      issuesFixed: results.issuesFixed,
      errors: results.errors,
    }, tenantId);

    results.success = results.errors.length === 0;

    logger.info(
      `[Batch ${batchId}] Quick-fix complete: ${results.filesProcessed} files, ` +
      `${results.issuesFixed} issues fixed, ${results.errors.length} errors`
    );

    return results;
  }
}

export const batchQuickFixService = new BatchQuickFixService();
