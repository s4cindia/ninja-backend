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
  async applyQuickFixes(batchId: string, tenantId: string, _userId: string): Promise<QuickFixResult> {
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
            remainingQuickFix: true,
            quickFixesApplied: true,
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

    // Include files that have quick-fixes OR need counter sync (negative/incorrect remainingQuickFix)
    const filesNeedingSync = batch.files.filter(f => 
      (f.issuesQuickFix || 0) > 0 || 
      (f.remainingQuickFix !== null && f.remainingQuickFix !== 0)
    );
    const filesWithQuickFixes = filesNeedingSync;

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
        const allQuickFixTasks = plan.tasks.filter(
          (t: { type: string }) => t.type === 'quickfix'
        );
        const completedQuickFixTasks = allQuickFixTasks.filter(
          (t: { status: string }) => t.status === 'completed'
        );
        const pendingQuickFixTasks = allQuickFixTasks.filter(
          (t: { status: string }) => t.status === 'pending'
        );

        if (pendingQuickFixTasks.length === 0) {
          logger.info(`[Batch ${batchId}] No pending quick-fix tasks for ${file.originalName}`);
          
          // Sync database counters with actual plan state (fix stale data)
          const actualApplied = completedQuickFixTasks.length;
          if (file.issuesQuickFix !== allQuickFixTasks.length || 
              (file as { quickFixesApplied?: number }).quickFixesApplied !== actualApplied) {
            logger.info(`[Batch ${batchId}] Syncing counters for ${file.originalName}: quickFix=${allQuickFixTasks.length}, applied=${actualApplied}`);
            await prisma.batchFile.update({
              where: { id: file.id },
              data: {
                issuesQuickFix: allQuickFixTasks.length,
                quickFixesApplied: actualApplied,
                remainingQuickFix: allQuickFixTasks.length - actualApplied,
              },
            });
          }
          continue;
        }
        
        const quickFixTasks = pendingQuickFixTasks;

        // Apply quick-fixes using remediation service
        let fixedCount = 0;
        const fixedTasks: Array<{ id: string; issueCode: string }> = [];
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
            fixedTasks.push({ id: task.id, issueCode: task.issueCode });
          } catch (taskError) {
            logger.warn(`[Batch ${batchId}] Failed to apply task ${task.id}: ${taskError}`);
          }
        }

        // Update job output to include batch quick-fix modifications in autoRemediation
        if (fixedTasks.length > 0) {
          try {
            const job = await prisma.job.findUnique({
              where: { id: file.auditJobId },
            });

            if (job && job.output) {
              const output = job.output as Record<string, unknown>;
              const autoRemediation = (output.autoRemediation as Record<string, unknown>) || {};
              const modifications = (autoRemediation.modifications as Array<unknown>) || [];

              // Add batch quick-fix modifications
              const newModifications = fixedTasks.map(task => ({
                issueCode: task.issueCode,
                success: true,
                method: 'batch-quick-fix',
                appliedAt: new Date().toISOString(),
                taskId: task.id,
              }));

              // Update job output with new modifications
              await prisma.job.update({
                where: { id: file.auditJobId },
                data: {
                  output: {
                    ...output,
                    autoRemediation: {
                      ...autoRemediation,
                      modifications: [...modifications, ...newModifications],
                    },
                  } as any,
                },
              });

              logger.info(`[Batch ${batchId}] Added ${newModifications.length} batch quick-fix modifications to job output`);
            }
          } catch (updateError) {
            logger.warn(`[Batch ${batchId}] Failed to update job output with batch quick-fix modifications: ${updateError}`);
          }
        }

        // Update file record - track quick-fixes applied
        const updatedFile = await prisma.batchFile.update({
          where: { id: file.id },
          data: {
            quickFixesApplied: { increment: fixedCount },
            remainingQuickFix: { decrement: fixedCount },
          },
        });

        results.filesProcessed++;
        results.issuesFixed += fixedCount;

        // Broadcast progress with cumulative totals
        sseService.broadcastToChannel(`batch:${batchId}`, {
          type: 'quick_fix_file_completed',
          batchId,
          fileId: file.id,
          fileName: file.originalName,
          issuesFixed: fixedCount,
          fileQuickFixesApplied: updatedFile.quickFixesApplied || fixedCount,
        }, tenantId);

        logger.info(`[Batch ${batchId}] Applied ${fixedCount} quick-fixes for ${file.originalName}`);

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        results.errors.push(`${file.originalName}: ${errorMessage}`);
        logger.error(`[Batch ${batchId}] Quick-fix error for ${file.originalName}:`, error instanceof Error ? error : undefined);
      }
    }

    // Update batch statistics - track quick-fixes applied
    const updatedBatch = await prisma.batch.update({
      where: { id: batchId },
      data: {
        quickFixesApplied: { increment: results.issuesFixed },
      },
    });

    // Broadcast completion with cumulative totals
    sseService.broadcastToChannel(`batch:${batchId}`, {
      type: 'quick_fix_completed',
      batchId,
      filesProcessed: results.filesProcessed,
      issuesFixed: results.issuesFixed,
      batchQuickFixesApplied: updatedBatch.quickFixesApplied,
      remainingQuickFixes: (updatedBatch.quickFixIssues || 0) - (updatedBatch.quickFixesApplied || 0),
      errors: results.errors,
    }, tenantId);

    results.success = results.errors.length === 0;

    logger.info(
      `[Batch ${batchId}] Quick-fix complete: ${results.filesProcessed} files, ` +
      `${results.issuesFixed} issues fixed, ${results.errors.length} errors`
    );

    return results;
  }

  /**
   * Apply quick-fixes with user-provided values to a single batch file
   */
  async applyQuickFixesToFile(
    batchId: string,
    fileId: string,
    tenantId: string,
    quickFixes: Array<{ issueCode: string; value: string }>
  ): Promise<{
    success: boolean;
    appliedFixes: number;
    results: Array<{ issueCode: string; success: boolean; error?: string }>;
  }> {
    logger.info(`[BatchFile ${fileId}] Applying ${quickFixes.length} quick-fixes`);

    // Validate issue codes
    const validIssueCodes = [
      'METADATA-ACCESSMODE',
      'METADATA-ACCESSMODESUFFICIENT',
      'METADATA-ACCESSIBILITYFEATURE',
      'METADATA-ACCESSIBILITYHAZARD',
      'METADATA-ACCESSIBILITYSUMMARY',
    ];

    for (const fix of quickFixes) {
      if (!validIssueCodes.includes(fix.issueCode)) {
        throw new Error(`Invalid issue code: ${fix.issueCode}`);
      }
      if (!fix.value || fix.value.length > 500) {
        throw new Error(`Invalid value for ${fix.issueCode}`);
      }
    }

    // Get the batch file with its batch
    const file = await prisma.batchFile.findFirst({
      where: { 
        id: fileId, 
        batchId,
        batch: { tenantId }
      },
      include: { batch: true }
    });

    if (!file) {
      throw new Error('Batch file not found');
    }

    if (!file.auditJobId) {
      throw new Error('File has not been audited');
    }

    // Get remediation plan and update task statuses
    const plan = await remediationService.getRemediationPlan(file.auditJobId);
    const results: Array<{ issueCode: string; success: boolean; error?: string }> = [];
    let appliedFixes = 0;

    for (const fix of quickFixes) {
      try {
        // Find matching task in plan
        if (plan) {
          const task = plan.tasks.find(
            (t: { issueCode: string; status: string }) => 
              t.issueCode === fix.issueCode && t.status === 'pending'
          );
          
          if (task) {
            await remediationService.updateTaskStatus(
              file.auditJobId,
              task.id,
              'completed',
              `Applied value: ${fix.value}`,
              'user',
              { completionMethod: 'manual', notes: `Value: ${fix.value}` }
            );
          }
        }

        appliedFixes++;
        results.push({ issueCode: fix.issueCode, success: true });
        logger.info(`[BatchFile ${fileId}] Applied quick-fix for ${fix.issueCode}`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        results.push({ issueCode: fix.issueCode, success: false, error: errorMessage });
        logger.error(`[BatchFile ${fileId}] Failed to apply ${fix.issueCode}: ${errorMessage}`);
      }
    }

    // Update batch file stats - track quick-fixes applied
    const updatedFile = await prisma.batchFile.update({
      where: { id: fileId },
      data: {
        quickFixesApplied: { increment: appliedFixes },
        remainingQuickFix: { decrement: appliedFixes },
      },
    });

    // Update batch-level totals
    const updatedBatch = await prisma.batch.update({
      where: { id: batchId },
      data: {
        quickFixesApplied: { increment: appliedFixes },
      },
    });

    // Broadcast update via SSE with cumulative totals
    sseService.broadcastToChannel(`batch:${batchId}`, {
      type: 'file_quick_fix_applied',
      batchId,
      fileId,
      fileName: file.originalName,
      appliedFixes,
      fileQuickFixesApplied: updatedFile.quickFixesApplied || appliedFixes,
      batchQuickFixesApplied: updatedBatch.quickFixesApplied,
      results,
    }, tenantId);

    logger.info(`[BatchFile ${fileId}] Quick-fix complete: ${appliedFixes} fixes applied`);

    return {
      success: results.every(r => r.success),
      appliedFixes,
      results,
    };
  }

  /**
   * Batch apply all quick-fixes to a single file using default values
   * This is for the "Batch Apply All" button that applies all quick-fixes at once
   */
  async batchApplyAllQuickFixes(
    batchId: string,
    fileId: string,
    tenantId: string
  ): Promise<{
    success: boolean;
    appliedFixes: number;
    results: Array<{ issueCode: string; success: boolean; error?: string }>;
  }> {
    logger.info(`[BatchFile ${fileId}] Batch applying all quick-fixes with defaults`);

    // Get the batch file
    const file = await prisma.batchFile.findFirst({
      where: { 
        id: fileId, 
        batchId,
        batch: { tenantId }
      },
      include: { batch: true }
    });

    if (!file) {
      throw new Error('Batch file not found');
    }

    if (!file.auditJobId) {
      throw new Error('File has not been audited');
    }

    // Get remediation plan to find pending quick-fix tasks
    const plan = await remediationService.getRemediationPlan(file.auditJobId);
    
    if (!plan) {
      throw new Error('No remediation plan found');
    }

    // Find all pending quick-fix tasks
    const quickFixTasks = plan.tasks.filter(
      (t: { type: string; status: string; issueCode: string }) => 
        t.type === 'quickfix' && t.status === 'pending'
    );

    if (quickFixTasks.length === 0) {
      return {
        success: true,
        appliedFixes: 0,
        results: [],
      };
    }

    // Default values for common metadata issues
    const defaultValues: Record<string, string> = {
      'METADATA-ACCESSMODE': 'textual',
      'METADATA-ACCESSMODESUFFICIENT': 'textual',
      'METADATA-ACCESSIBILITYFEATURE': 'structuralNavigation, tableOfContents, readingOrder',
      'METADATA-ACCESSIBILITYHAZARD': 'none',
      'METADATA-ACCESSIBILITYSUMMARY': 'This publication has been assessed for accessibility and meets basic requirements.',
    };

    const results: Array<{ issueCode: string; success: boolean; error?: string }> = [];
    let appliedFixes = 0;

    for (const task of quickFixTasks) {
      try {
        const issueCode = task.issueCode as string;
        const defaultValue = defaultValues[issueCode] || 'Not specified';

        await remediationService.updateTaskStatus(
          file.auditJobId,
          task.id,
          'completed',
          `Batch applied with default value: ${defaultValue}`,
          'system',
          { completionMethod: 'auto', notes: `Default value: ${defaultValue}` }
        );

        appliedFixes++;
        results.push({ issueCode, success: true });
        logger.info(`[BatchFile ${fileId}] Batch applied quick-fix for ${issueCode}`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        results.push({ issueCode: task.issueCode, success: false, error: errorMessage });
        logger.error(`[BatchFile ${fileId}] Failed to batch apply ${task.issueCode}: ${errorMessage}`);
      }
    }

    // Update batch file stats - track quick-fixes applied separately
    const updatedFile = await prisma.batchFile.update({
      where: { id: fileId },
      data: {
        quickFixesApplied: { increment: appliedFixes },
        remainingQuickFix: { decrement: appliedFixes },
      },
    });

    // Update batch-level totals
    const updatedBatch = await prisma.batch.update({
      where: { id: batchId },
      data: {
        quickFixesApplied: { increment: appliedFixes },
      },
    });

    // Broadcast update via SSE with cumulative totals
    sseService.broadcastToChannel(`batch:${batchId}`, {
      type: 'batch_quick_fix_applied',
      batchId,
      fileId,
      fileName: file.originalName,
      appliedFixes,
      fileQuickFixesApplied: updatedFile.quickFixesApplied || appliedFixes,
      batchQuickFixesApplied: updatedBatch.quickFixesApplied,
      remainingQuickFixes: updatedBatch.quickFixIssues - updatedBatch.quickFixesApplied,
      results,
    }, tenantId);

    logger.info(`[BatchFile ${fileId}] Batch quick-fix complete: ${appliedFixes} fixes applied`);

    return {
      success: results.every(r => r.success),
      appliedFixes,
      results,
    };
  }
}

export const batchQuickFixService = new BatchQuickFixService();
