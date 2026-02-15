/**
 * PDF Re-Audit Service
 *
 * Implements re-auditing of remediated PDFs and comparison with original results.
 * Phase 3 BE-T1: Re-audit service and before/after comparison logic.
 */

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
        const error = `Job ${jobId} not found`;
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
      logger.info(`[PdfReaudit] Running fresh audit on remediated PDF...`);
      const reauditReport = await pdfAuditService.runAuditFromBuffer(
        remediatedPdfBuffer,
        `${jobId}-reaudit`,
        fileName
      );

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
   * 2. If not matched, match by code only (fuzzy match for reflow cases)
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

      // If no strict match, try fuzzy match: code only (handles page reflow)
      if (!matched) {
        matched = newIssues.find(
          (newIssue) =>
            !matchedNewIssueIds.has(newIssue.id) &&
            newIssue.code === originalIssue.code &&
            newIssue.severity === originalIssue.severity
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
}

export const pdfReauditService = new PdfReauditService();
