/**
 * PDF Auto-Remediation Service
 *
 * Orchestrates automatic PDF remediation by running handlers sequentially
 * and tracking all modifications for comparison and verification
 */

import { PDFDocument } from 'pdf-lib';
import { logger } from '../../lib/logger';
import { pdfModifierService, ModificationResult } from './pdf-modifier.service';
import { pdfRemediationService } from './pdf-remediation.service';
import { pdfVerificationService, VerificationResult } from './pdf-verification.service';
import type {
  RemediationTask,
  TaskStatus,
} from '../../types/pdf-remediation.types';

/**
 * Handler function type
 */
type RemediationHandler = (
  doc: PDFDocument,
  task: RemediationTask,
  options?: Record<string, unknown>
) => Promise<ModificationResult>;

/**
 * Result of auto-remediation execution
 */
export interface AutoRemediationResult {
  success: boolean;
  jobId: string;
  fileName: string;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  skippedTasks: number;
  modifications: ModificationResult[];
  remediatedPdfBuffer?: Buffer;
  backupPath?: string;
  verification?: VerificationResult;
  error?: string;
}

/**
 * Quick fix input from user
 */
export interface QuickFixInput {
  taskId: string;
  issueCode: string;
  data: Record<string, unknown>;
}

/**
 * PDF Auto-Remediation Service
 */
class PdfAutoRemediationService {
  /**
   * Registry of remediation handlers by issue code
   */
  private handlers: Map<string, RemediationHandler> = new Map();

  constructor() {
    this.registerDefaultHandlers();
  }

  /**
   * Register default Tier-1 handlers
   */
  private registerDefaultHandlers(): void {
    // Tier 1: Auto-fixable handlers
    this.registerHandler('PDF-NO-LANGUAGE', this.handleAddLanguage.bind(this));
    this.registerHandler('PDF-NO-TITLE', this.handleAddTitle.bind(this));
    this.registerHandler('PDF-NO-METADATA', this.handleAddMetadata.bind(this));
    this.registerHandler('PDF-NO-CREATOR', this.handleAddCreator.bind(this));

    logger.info('[Auto-Remediation] Registered 4 default handlers');
  }

  /**
   * Register a remediation handler
   */
  registerHandler(issueCode: string, handler: RemediationHandler): void {
    this.handlers.set(issueCode, handler);
    logger.debug(`[Auto-Remediation] Registered handler for ${issueCode}`);
  }

  /**
   * Run auto-remediation for a job
   *
   * @param pdfBuffer - Original PDF buffer
   * @param jobId - Job ID
   * @param fileName - File name
   * @returns Auto-remediation result
   */
  async runAutoRemediation(
    pdfBuffer: Buffer,
    jobId: string,
    fileName: string
  ): Promise<AutoRemediationResult> {
    logger.info(`[Auto-Remediation] Starting for job ${jobId}`);

    const result: AutoRemediationResult = {
      success: false,
      jobId,
      fileName,
      totalTasks: 0,
      completedTasks: 0,
      failedTasks: 0,
      skippedTasks: 0,
      modifications: [],
    };

    try {
      // 1. Get remediation plan
      const plan = await pdfRemediationService.getRemediationPlan(jobId);

      if (!plan) {
        throw new Error(`Remediation plan not found for job ${jobId}`);
      }

      result.totalTasks = plan.tasks.length;

      // 2. Filter auto-fixable tasks
      const autoFixableTasks = plan.tasks.filter(
        (task) => task.type === 'AUTO_FIXABLE' && task.status === 'PENDING'
      );

      if (autoFixableTasks.length === 0) {
        logger.warn(`[Auto-Remediation] No auto-fixable tasks found for job ${jobId}`);
        result.success = true;
        return result;
      }

      logger.info(
        `[Auto-Remediation] Found ${autoFixableTasks.length} auto-fixable tasks`
      );

      // 3. Create backup
      result.backupPath = await pdfModifierService.createBackup(pdfBuffer, fileName);
      logger.info(`[Auto-Remediation] Created backup at ${result.backupPath}`);

      // 4. Load PDF
      const doc = await pdfModifierService.loadPDF(pdfBuffer);

      // 5. Group tasks by issue code for efficient processing
      const tasksByCode = this.groupTasksByIssueCode(autoFixableTasks);

      // 6. Run handlers sequentially
      for (const [issueCode, tasks] of tasksByCode.entries()) {
        const handler = this.handlers.get(issueCode);

        if (!handler) {
          logger.warn(`[Auto-Remediation] No handler for ${issueCode}, skipping ${tasks.length} tasks`);
          result.skippedTasks += tasks.length;

          // Update task statuses
          for (const task of tasks) {
            await pdfRemediationService.updateTaskStatus(jobId, task.id, {
              status: 'SKIPPED',
              notes: 'No handler available',
            });
          }
          continue;
        }

        logger.info(`[Auto-Remediation] Processing ${tasks.length} ${issueCode} tasks`);

        // Process each task with the handler
        for (const task of tasks) {
          try {
            // Update status to IN_PROGRESS
            await pdfRemediationService.updateTaskStatus(jobId, task.id, {
              status: 'IN_PROGRESS',
            });

            // Run handler
            const modification = await handler(doc, task);
            result.modifications.push(modification);

            // Update status based on result
            const newStatus: TaskStatus = modification.success ? 'COMPLETED' : 'FAILED';
            await pdfRemediationService.updateTaskStatus(jobId, task.id, {
              status: newStatus,
              errorMessage: modification.error,
              notes: modification.description,
            });

            if (modification.success) {
              result.completedTasks++;
              logger.info(`[Auto-Remediation] ✓ Completed task ${task.id}: ${task.issueCode}`);
            } else {
              result.failedTasks++;
              logger.error(`[Auto-Remediation] ✗ Failed task ${task.id}: ${modification.error}`);
            }
          } catch (error) {
            result.failedTasks++;
            logger.error(`[Auto-Remediation] Handler error for ${task.id}`, { error });

            await pdfRemediationService.updateTaskStatus(jobId, task.id, {
              status: 'FAILED',
              errorMessage: error instanceof Error ? error.message : 'Unknown error',
            });
          }
        }
      }

      // 7. Save modified PDF
      result.remediatedPdfBuffer = await pdfModifierService.savePDF(doc);

      // 8. Validate modified PDF
      const validation = await pdfModifierService.validatePDF(result.remediatedPdfBuffer);

      if (!validation.valid) {
        logger.error('[Auto-Remediation] Modified PDF validation failed', validation);
        throw new Error(`Modified PDF validation failed: ${validation.errors.join(', ')}`);
      }

      // 9. Verify remediation by checking if fixes were applied
      logger.info('[Auto-Remediation] Running verification checks');
      result.verification = await pdfVerificationService.verifyRemediation(
        result.remediatedPdfBuffer,
        jobId,
        fileName
      );

      logger.info('[Auto-Remediation] Verification complete', {
        verified: result.verification.verifiedFixed,
        stillBroken: result.verification.stillBroken,
        unverified: result.verification.unverified,
      });

      result.success = true;

      logger.info(`[Auto-Remediation] Completed for job ${jobId}`, {
        total: result.totalTasks,
        completed: result.completedTasks,
        failed: result.failedTasks,
        skipped: result.skippedTasks,
        verified: result.verification.verifiedFixed,
      });
    } catch (error) {
      result.success = false;
      result.error = error instanceof Error ? error.message : 'Unknown error';
      logger.error('[Auto-Remediation] Failed', { error, jobId });

      // Rollback to backup if available
      if (result.backupPath) {
        try {
          await pdfModifierService.rollback(result.backupPath);
          logger.info('[Auto-Remediation] Rolled back to backup');
        } catch (rollbackError) {
          logger.error('[Auto-Remediation] Rollback failed', { error: rollbackError });
        }
      }
    }

    return result;
  }

  /**
   * Apply a quick fix with user input
   *
   * @param pdfBuffer - Original PDF buffer
   * @param quickFix - Quick fix input
   * @returns Modification result
   */
  async applyQuickFix(
    pdfBuffer: Buffer,
    quickFix: QuickFixInput
  ): Promise<ModificationResult> {
    logger.info(`[Auto-Remediation] Applying quick fix for ${quickFix.issueCode}`);

    try {
      const doc = await pdfModifierService.loadPDF(pdfBuffer);

      // Route to appropriate handler based on issue code
      let result: ModificationResult;

      switch (quickFix.issueCode) {
        case 'PDF-IMAGE-NO-ALT':
          result = await this.handleAddImageAltText(doc, quickFix.data);
          break;

        default:
          result = {
            success: false,
            description: `No quick fix handler for ${quickFix.issueCode}`,
            error: 'Unsupported issue code',
          };
      }

      return result;
    } catch (error) {
      logger.error('[Auto-Remediation] Quick fix failed', { error, quickFix });
      return {
        success: false,
        description: 'Quick fix failed',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Group tasks by issue code for efficient processing
   */
  private groupTasksByIssueCode(
    tasks: RemediationTask[]
  ): Map<string, RemediationTask[]> {
    const grouped = new Map<string, RemediationTask[]>();

    for (const task of tasks) {
      const existing = grouped.get(task.issueCode) || [];
      existing.push(task);
      grouped.set(task.issueCode, existing);
    }

    return grouped;
  }

  // ============================================================================
  // Tier 1 Handlers: Auto-Fixable
  // ============================================================================

  /**
   * Handler: Add document language
   */
  private async handleAddLanguage(
    doc: PDFDocument,
    task: RemediationTask,
    options?: Record<string, unknown>
  ): Promise<ModificationResult> {
    const lang = (options?.lang as string) || 'en';
    return await pdfModifierService.addLanguage(doc, lang);
  }

  /**
   * Handler: Add document title
   */
  private async handleAddTitle(
    doc: PDFDocument,
    task: RemediationTask,
    options?: Record<string, unknown>
  ): Promise<ModificationResult> {
    // Try to infer title from file name or use default
    const fileName = options?.fileName as string;
    const title = fileName
      ? fileName.replace(/\.pdf$/i, '').replace(/[-_]/g, ' ')
      : 'Untitled Document';

    return await pdfModifierService.addTitle(doc, title);
  }

  /**
   * Handler: Add XMP metadata
   */
  private async handleAddMetadata(
    doc: PDFDocument,
    task: RemediationTask,
    options?: Record<string, unknown>
  ): Promise<ModificationResult> {
    const metadata = {
      marked: true, // PDF/UA compliance
      ...(options?.metadata as Record<string, unknown>),
    };

    return await pdfModifierService.addMetadata(doc, metadata);
  }

  /**
   * Handler: Add creator information
   */
  private async handleAddCreator(
    doc: PDFDocument,
    task: RemediationTask,
    options?: Record<string, unknown>
  ): Promise<ModificationResult> {
    const creator = (options?.creator as string) || 'Ninja Accessibility Platform';
    return await pdfModifierService.addCreator(doc, creator);
  }

  // ============================================================================
  // Quick Fix Handlers (with user input)
  // ============================================================================

  /**
   * Handler: Add image alt text (requires user input)
   */
  private async handleAddImageAltText(
    _doc: PDFDocument,
    _data: Record<string, unknown>
  ): Promise<ModificationResult> {
    // This is a placeholder - actual implementation requires PDF structure manipulation
    // which is complex and may need additional libraries or tools
    logger.warn('[Auto-Remediation] Image alt text addition not yet implemented');

    return {
      success: false,
      description: 'Image alt text addition not yet implemented',
      error: 'Feature not available',
    };
  }
}

// Export singleton instance
export const pdfAutoRemediationService = new PdfAutoRemediationService();
