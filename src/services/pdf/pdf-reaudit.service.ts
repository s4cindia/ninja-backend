/**
 * PDF Re-Audit Service
 *
 * Implements re-auditing of remediated PDFs and comparison with original results.
 * Phase 3 BE-T1: Re-audit service and before/after comparison logic.
 */

import { Prisma } from '@prisma/client';
import { logger } from '../../lib/logger';
import prisma from '../../lib/prisma';
import { pdfAuditService } from './pdf-audit.service';
import { fileStorageService } from '../storage/file-storage.service';
import { AuditIssue, AuditReport } from '../audit/base-audit.service';
import {
  ReauditComparisonResult,
  IssueComparison,
  SuccessMetrics,
} from '../../types/pdf-reaudit.types';

/**
 * PDF Re-Audit Service
 *
 * Orchestrates re-auditing of remediated PDFs and comparison with original results.
 */
class PdfReauditService {
  /**
   * Re-audit a remediated PDF and compare with original results
   *
   * @param jobId - Original audit job ID
   * @param remediatedPdfBuffer - Buffer of the remediated PDF
   * @param fileName - Original file name
   * @returns Comparison of before/after results
   */
  async reauditAndCompare(
    jobId: string,
    remediatedPdfBuffer: Buffer,
    fileName: string
  ): Promise<ReauditComparisonResult> {
    try {
      logger.info(`[PdfReaudit] Starting re-audit for job ${jobId}`);

      // Step 1: Get original audit results from job
      const originalJob = await prisma.job.findUnique({
        where: { id: jobId },
      });

      if (!originalJob) {
        const error = `Audit job ${jobId} not found for re-audit`;
        logger.error(`[PdfReaudit] ${error}`);
        return {
          success: false,
          jobId,
          originalAuditId: '',
          reauditId: '',
          fileName,
          comparison: {
            resolved: [],
            remaining: [],
            regressions: [],
          },
          metrics: this.getEmptyMetrics(),
          error,
        };
      }

      // Extract original audit report from job output
      const originalOutput = originalJob.output as { auditReport?: AuditReport } | null;
      if (!originalOutput?.auditReport) {
        const error = `No audit report found in job ${jobId}`;
        logger.error(`[PdfReaudit] ${error}`);
        return {
          success: false,
          jobId,
          originalAuditId: jobId,
          reauditId: '',
          fileName,
          comparison: {
            resolved: [],
            remaining: [],
            regressions: [],
          },
          metrics: this.getEmptyMetrics(),
          error,
        };
      }

      const originalIssues = originalOutput.auditReport.issues;
      logger.info(`[PdfReaudit] Original audit had ${originalIssues.length} issues`);

      // Step 2: Run fresh audit on remediated PDF
      // Always 'comprehensive' — this fire-and-forget background pass is what
      // produces the resolved/remaining/regressions counts a user sees after
      // applying fixes, so it must run every validator a fix could touch.
      // runAuditFromBuffer's own default ('basic') excludes 'contrast' (and
      // headings/reading-order/lists/language/links/forms/bookmarks); a fix
      // whose validator isn't in 'basic' would always misreport as "resolved"
      // regardless of whether it actually worked, since the validator that
      // would catch a lingering problem never re-runs.
      logger.info(`[PdfReaudit] Running fresh audit on remediated PDF...`);
      let reauditReport;
      try {
        // Same progress-callback mechanism the initial audit already uses
        // (accessibility.processor.ts) — surfaces "X of Y pages" / "X of Y
        // validators" via job.output.postRemediationProgress, polled through
        // the existing GET /jobs/:id endpoint, instead of this fire-and-forget
        // pass running with no visible progress at all.
        const onProgress = (currentPage: number, totalPages: number) => {
          void this.updateReauditProgress(jobId, { currentPage, totalPages });
        };
        const onValidatorComplete = (label: string, _issuesFound: number, completed: number, total: number) => {
          void this.updateReauditProgress(jobId, { completedValidators: completed, totalValidators: total, currentValidator: label });
        };

        await this.updateReauditProgress(jobId, { currentPage: 0, totalPages: 0, completedValidators: 0, totalValidators: 0 });

        reauditReport = await pdfAuditService.runAuditFromBuffer(
          remediatedPdfBuffer,
          `${jobId}-reaudit`,
          fileName,
          'comprehensive',
          undefined,
          onProgress,
          onValidatorComplete
        );
      } catch (auditError) {
        logger.error(`[PdfReaudit] Audit execution failed:`, auditError);
        return {
          success: false,
          jobId,
          originalAuditId: jobId,
          reauditId: '',
          fileName,
          comparison: {
            resolved: [],
            remaining: [],
            regressions: [],
          },
          metrics: this.getEmptyMetrics(),
          error: `Re-audit failed: ${auditError instanceof Error ? auditError.message : 'Unknown error'}`,
        };
      }

      const newIssues = reauditReport.issues;
      logger.info(`[PdfReaudit] Re-audit found ${newIssues.length} issues`);

      // Step 3: Compare results
      const comparison = this.compareAuditResults(originalIssues, newIssues);
      logger.info(
        `[PdfReaudit] Comparison: ${comparison.resolved.length} resolved, ` +
        `${comparison.remaining.length} remaining, ${comparison.regressions.length} regressions`
      );

      // Step 4: Calculate success metrics
      const metrics = this.calculateSuccessMetrics(comparison);
      logger.info(`[PdfReaudit] Resolution rate: ${metrics.resolutionRate.toFixed(1)}%`);

      // Step 5: Save remediated PDF if not already saved
      let remediatedFileUrl: string | undefined;
      try {
        remediatedFileUrl = await fileStorageService.saveRemediatedFile(
          jobId,
          fileName,
          remediatedPdfBuffer
        );
        logger.info(`[PdfReaudit] Saved remediated PDF: ${remediatedFileUrl}`);
      } catch (error) {
        logger.warn(`[PdfReaudit] Failed to save remediated PDF:`, error);
      }

      // Step 6: Return comparison result
      const result: ReauditComparisonResult = {
        success: true,
        jobId,
        originalAuditId: jobId,
        reauditId: reauditReport.jobId,
        fileName,
        comparison,
        metrics,
        remediatedFileUrl,
        reauditReport,
      };

      logger.info(`[PdfReaudit] Re-audit complete for job ${jobId}`);
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`[PdfReaudit] Re-audit failed for job ${jobId}:`, error);

      return {
        success: false,
        jobId,
        originalAuditId: jobId,
        reauditId: '',
        fileName,
        comparison: {
          resolved: [],
          remaining: [],
          regressions: [],
        },
        metrics: this.getEmptyMetrics(),
        error: errorMessage,
      };
    }
  }

  /**
   * Compare two audit results and categorize differences
   *
   * Issue Matching Algorithm:
   * 1. Match by code + location (strict match)
   * 2. If not matched, match by code + severity + bounding-box position
   *    (handles page reflow: an earlier fix adding/removing a whole page
   *    shifts every subsequent page's *number* by a constant offset, but
   *    each page's own internal layout is unaffected -- an element's own
   *    (x, y, width, height) on its page stays identical even though its
   *    page number changed. This is a much stronger signal than code+
   *    severity alone: it can't cross-match two genuinely different
   *    same-code-same-severity issues, since their geometry would differ.)
   * 3. If neither issue in a candidate pair carries bounding-box data at
   *    all (some issue types don't populate it), fall back to code +
   *    severity only -- the original, weaker fuzzy match. Deliberately
   *    NOT used when both issues have bounding boxes that failed to align
   *    in step 2: at that point their positions are known to differ, so
   *    treating them as "the same issue" would reintroduce the exact
   *    false-cross-match risk this tiering exists to avoid.
   *
   * Categorization:
   * - Resolved: In original, not in new
   * - Remaining: In both original and new
   * - Regressions: Not in original, but in new
   *
   * @param originalIssues - Issues from original audit
   * @param newIssues - Issues from re-audit
   * @returns Categorized comparison
   */
  private compareAuditResults(
    originalIssues: AuditIssue[],
    newIssues: AuditIssue[]
  ): IssueComparison {
    logger.info(`[PdfReaudit] Comparing ${originalIssues.length} original vs ${newIssues.length} new issues`);

    const resolved: AuditIssue[] = [];
    const remaining: AuditIssue[] = [];
    const regressions: AuditIssue[] = [];

    // Track which new issues have been matched
    const matchedNewIssueIds = new Set<string>();

    // For each original issue, try to find a match in new issues
    for (const originalIssue of originalIssues) {
      // Try strict match: code + location
      let matched = newIssues.find(
        (newIssue) =>
          !matchedNewIssueIds.has(newIssue.id) &&
          newIssue.code === originalIssue.code &&
          this.isSameLocation(originalIssue, newIssue)
      );

      // Fuzzy match, tier 2: code + severity + matching bounding-box
      // position (handles page reflow -- see method doc comment above).
      if (!matched) {
        matched = newIssues.find(
          (newIssue) =>
            !matchedNewIssueIds.has(newIssue.id) &&
            newIssue.code === originalIssue.code &&
            newIssue.severity === originalIssue.severity &&
            this.isSameBoundingBox(originalIssue, newIssue)
        );
      }

      // Fuzzy match, tier 3 (original fallback): code + severity only --
      // only when bounding-box comparison genuinely wasn't possible for
      // this pair (at least one side lacks the data), not when it was
      // possible and failed.
      if (!matched) {
        matched = newIssues.find(
          (newIssue) =>
            !matchedNewIssueIds.has(newIssue.id) &&
            newIssue.code === originalIssue.code &&
            newIssue.severity === originalIssue.severity &&
            (!originalIssue.boundingBox || !newIssue.boundingBox)
        );
      }

      if (matched) {
        // Issue still exists (not fixed)
        remaining.push(matched);
        matchedNewIssueIds.add(matched.id);
      } else {
        // Issue was fixed
        resolved.push(originalIssue);
      }
    }

    // Any new issues that weren't matched are regressions
    for (const newIssue of newIssues) {
      if (!matchedNewIssueIds.has(newIssue.id)) {
        regressions.push(newIssue);
      }
    }

    logger.info(
      `[PdfReaudit] Comparison results: ` +
      `${resolved.length} resolved, ${remaining.length} remaining, ${regressions.length} regressions`
    );

    return { resolved, remaining, regressions };
  }

  /**
   * Check if two issues have the same location
   *
   * Compares location string and page number if available.
   *
   * @param issue1 - First issue
   * @param issue2 - Second issue
   * @returns True if locations match
   */
  private isSameLocation(issue1: AuditIssue, issue2: AuditIssue): boolean {
    // If both have page numbers, compare them
    if (issue1.pageNumber !== undefined && issue2.pageNumber !== undefined) {
      if (issue1.pageNumber !== issue2.pageNumber) {
        return false;
      }
    }

    // If both have location strings, compare them
    if (issue1.location && issue2.location) {
      return issue1.location === issue2.location;
    }

    // If page numbers match but no locations, consider it a match
    if (issue1.pageNumber !== undefined && issue2.pageNumber !== undefined) {
      return issue1.pageNumber === issue2.pageNumber;
    }

    // Default: no location info means we can't determine sameness
    return false;
  }

  /**
   * Checks whether two issues' bounding boxes describe the same element,
   * deliberately WITHOUT comparing page number -- a page-reflow-causing fix
   * (one that adds or removes a whole page earlier in the document) shifts
   * every subsequent page's *number* by a constant offset, but each page's
   * own internal layout is unaffected: an element's (x, y, width, height)
   * on its own page stays identical even though the page it's on is now
   * numbered differently. Requires both issues to actually carry
   * boundingBox data -- returns false (not a match) when either is
   * missing, so callers can distinguish "compared and didn't match" from
   * "couldn't compare at all" (see compareAuditResults' tier 3 fallback).
   */
  private isSameBoundingBox(issue1: AuditIssue, issue2: AuditIssue): boolean {
    const b1 = issue1.boundingBox;
    const b2 = issue2.boundingBox;
    if (!b1 || !b2) return false;

    const TOLERANCE_PT = 2; // small rounding tolerance, in PDF points
    return (
      Math.abs(b1.x - b2.x) <= TOLERANCE_PT &&
      Math.abs(b1.y - b2.y) <= TOLERANCE_PT &&
      Math.abs(b1.width - b2.width) <= TOLERANCE_PT &&
      Math.abs(b1.height - b2.height) <= TOLERANCE_PT
    );
  }

  /**
   * Calculate remediation success metrics
   *
   * @param comparison - Issue comparison data
   * @returns Success metrics (% resolved, severity breakdown, etc.)
   */
  private calculateSuccessMetrics(comparison: IssueComparison): SuccessMetrics {
    const { resolved, remaining, regressions } = comparison;

    const totalOriginal = resolved.length + remaining.length;
    const totalNew = remaining.length + regressions.length;
    const resolvedCount = resolved.length;
    const remainingCount = remaining.length;
    const regressionCount = regressions.length;

    // Calculate resolution rate (avoid division by zero)
    const resolutionRate = totalOriginal > 0
      ? (resolvedCount / totalOriginal) * 100
      : 0;

    // Calculate severity breakdown in a single pass for better performance
    const severityBreakdown = {
      critical: { resolved: 0, remaining: 0 },
      serious: { resolved: 0, remaining: 0 },
      moderate: { resolved: 0, remaining: 0 },
      minor: { resolved: 0, remaining: 0 },
    };

    // Single pass through resolved issues
    for (const issue of resolved) {
      const severity = issue.severity as keyof typeof severityBreakdown;
      if (severityBreakdown[severity]) {
        severityBreakdown[severity].resolved++;
      }
    }

    // Single pass through remaining issues
    for (const issue of remaining) {
      const severity = issue.severity as keyof typeof severityBreakdown;
      if (severityBreakdown[severity]) {
        severityBreakdown[severity].remaining++;
      }
    }

    const criticalResolved = severityBreakdown.critical.resolved;
    const criticalRemaining = severityBreakdown.critical.remaining;

    logger.info(
      `[PdfReaudit] Metrics calculated: ` +
      `${totalOriginal} → ${totalNew} issues (${resolutionRate.toFixed(1)}% resolved)`
    );

    return {
      totalOriginal,
      totalNew,
      resolvedCount,
      remainingCount,
      regressionCount,
      resolutionRate,
      criticalResolved,
      criticalRemaining,
      severityBreakdown,
    };
  }

  /**
   * Get empty metrics for error cases
   *
   * @returns Empty success metrics
   */
  private getEmptyMetrics(): SuccessMetrics {
    return {
      totalOriginal: 0,
      totalNew: 0,
      resolvedCount: 0,
      remainingCount: 0,
      regressionCount: 0,
      resolutionRate: 0,
      criticalResolved: 0,
      criticalRemaining: 0,
      severityBreakdown: {
        critical: { resolved: 0, remaining: 0 },
        serious: { resolved: 0, remaining: 0 },
        moderate: { resolved: 0, remaining: 0 },
        minor: { resolved: 0, remaining: 0 },
      },
    };
  }

  /**
   * Merge a partial progress update into job.output.postRemediationProgress
   * so the frontend can poll GET /jobs/:id for "X of Y pages" / "X of Y
   * validators" during this fire-and-forget re-audit pass, the same way it
   * already polls job.input.validatorProgress during the initial audit.
   * Best-effort — a failed progress write must never fail the re-audit itself.
   */
  private async updateReauditProgress(
    jobId: string,
    partial: {
      currentPage?: number;
      totalPages?: number;
      completedValidators?: number;
      totalValidators?: number;
      currentValidator?: string;
    }
  ): Promise<void> {
    try {
      const job = await prisma.job.findUnique({ where: { id: jobId }, select: { output: true } });
      const output = (job?.output ?? {}) as Record<string, unknown>;
      const prevProgress = (output.postRemediationProgress ?? {}) as Record<string, unknown>;
      await prisma.job.update({
        where: { id: jobId },
        data: {
          output: {
            ...output,
            postRemediationProgress: { ...prevProgress, ...partial, updatedAt: new Date().toISOString() },
          } as Prisma.InputJsonObject,
        },
      });
    } catch (err) {
      logger.warn(`[PdfReaudit] Failed to update progress for job ${jobId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export const pdfReauditService = new PdfReauditService();
