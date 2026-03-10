/**
 * PAC-Equivalent Report Service
 *
 * Generates a Matterhorn Protocol 1.1 compliance report for a completed
 * PDF audit job, covering all 137 conditions across 31 checkpoints.
 *
 * Core principle: UNTESTED ≠ PASS
 *   - Machine conditions with no test are marked UNTESTED, not PASS.
 *   - Human-only conditions are marked HUMAN_REQUIRED.
 *   - Conditions not relevant to this document are NOT_APPLICABLE.
 *
 * Matterhorn Coverage Plan — Step 5
 */

import { logger } from '../../lib/logger';
import prisma from '../../lib/prisma';
import {
  MATTERHORN_CONDITIONS,
  MatterhornCondition,
} from '../../data/matterhorn-1.1.data';
import type { AuditIssue } from '../audit/base-audit.service';

// ─── Types ────────────────────────────────────────────────────────────────────

export type PacConditionStatus =
  | 'PASS'
  | 'FAIL'
  | 'UNTESTED'
  | 'HUMAN_REQUIRED'
  | 'NOT_APPLICABLE';

export type PacCheckpointStatus = 'PASS' | 'FAIL' | 'UNTESTED' | 'HUMAN_REQUIRED';

export interface PacConditionResult {
  id: string;
  description: string;
  how: 'M' | 'H' | '--';
  status: PacConditionStatus;
  /** IDs of AuditIssues that caused this FAIL */
  issueIds?: string[];
  /** Which validator sourced the failing issue */
  source?: 'ninja' | 'verapdf';
}

export interface PacCheckpointResult {
  id: string;
  title: string;
  status: PacCheckpointStatus;
  conditions: PacConditionResult[];
}

export interface PacReportSummary {
  total: number;
  pass: number;
  fail: number;
  untested: number;
  humanRequired: number;
  notApplicable: number;
}

export interface PacReport {
  jobId: string;
  fileName: string;
  generatedAt: string;
  ninjaVersion: string;
  isTagged: boolean;
  summary: PacReportSummary;
  checkpoints: PacCheckpointResult[];
}

// ─── Testable conditions ──────────────────────────────────────────────────────

/**
 * The complete set of Matterhorn condition IDs that Ninja validators (or
 * veraPDF via the mapping table) can currently test.
 *
 * A condition in this set but with no corresponding failing issue → PASS.
 * A machine condition NOT in this set → UNTESTED.
 *
 * Update this set whenever a new validator or veraPDF mapping is added.
 */
const TESTABLE_CONDITIONS: ReadonlySet<string> = new Set([
  // ── Structure validator ──────────────────────────────────────────────────
  '01-004', // Tagged content inside Artifact
  '06-002', // pdfuaid:part missing from XMP metadata
  '07-001', // ViewerPreferences/DisplayDocTitle not set (if emitted)
  '11-001', // Table is not properly structured
  '12-001', // Logical reading order cannot be determined
  '14-003', // H element missing from structure (heading hierarchy)

  // ── Alt text validator ───────────────────────────────────────────────────
  '13-001', // Figure has no /Alt AND no /ActualText
  '13-004', // Figure /Alt value is empty string

  // ── Supplemental validator (CP19/20/21/25/26/30) ─────────────────────────
  '19-003', // Note structure element with duplicate ID
  '19-004', // Note structure element without ID
  '20-001', // OC Config Dict in /Configs missing /Name
  '20-002', // OC Config Dict in /D missing /Name
  '20-003', // OC Config Dict missing /AS entry
  '21-001', // Embedded file spec missing /F or /UF entry
  '25-001', // XFA dynamicRender set to required
  '26-001', // Encryption dictionary present
  '26-002', // Encryption /P flag does not allow text extraction
  '30-001', // Reference XObject present in page resources

  // ── Table validator ──────────────────────────────────────────────────────
  // Note: table validator sets code='MATTERHORN-15-00X' but not matterhornCheckpoint.
  // The PAC service resolves these via the code fallback below.
  '15-001',
  '15-002',
  '15-003',
  '15-004',
  '15-005',
]);

// ─── Service ──────────────────────────────────────────────────────────────────

class PacReportService {
  /**
   * Generate a PAC-equivalent Matterhorn Protocol 1.1 report for a job.
   *
   * @param jobId    Completed PDF audit job ID
   * @param tenantId Tenant ID for authorization check
   */
  async generateReport(jobId: string, tenantId: string): Promise<PacReport> {
    const job = await prisma.job.findFirst({
      where: { id: jobId, tenantId },
    });

    if (!job) {
      throw Object.assign(new Error('Job not found or access denied'), { statusCode: 404 });
    }

    if (job.status !== 'COMPLETED') {
      throw Object.assign(
        new Error('PAC report is only available for completed jobs'),
        { statusCode: 400 },
      );
    }

    // Extract audit issues from job output
    const output = job.output as Record<string, unknown> | null;
    const auditReport = output?.['auditReport'] as Record<string, unknown> | undefined;
    const rawIssues = (auditReport?.['issues'] as AuditIssue[] | undefined) ?? [];
    const isTagged = (auditReport?.['metadata'] as Record<string, unknown> | undefined)?.['isTagged'] as boolean ?? false;
    const fileName = (auditReport?.['fileName'] as string | undefined) ?? job.fileName ?? 'unknown.pdf';

    // Build a lookup: matterhornConditionId → [issue, ...]
    const failureMap = this.buildFailureMap(rawIssues);

    // Build checkpoint results across all 31 checkpoints
    const checkpointMap = new Map<string, PacCheckpointResult>();

    for (const [conditionId, condition] of MATTERHORN_CONDITIONS) {
      const conditionResult = this.classifyCondition(condition, failureMap);

      let checkpoint = checkpointMap.get(condition.checkpoint);
      if (!checkpoint) {
        checkpoint = {
          id: condition.checkpoint,
          title: condition.title,
          status: 'PASS',
          conditions: [],
        };
        checkpointMap.set(condition.checkpoint, checkpoint);
      }

      checkpoint.conditions.push(conditionResult);
    }

    // Roll up condition statuses to checkpoint level
    for (const checkpoint of checkpointMap.values()) {
      checkpoint.status = this.rollupStatus(checkpoint.conditions);
    }

    const checkpoints = Array.from(checkpointMap.values()).sort(
      (a, b) => parseInt(a.id) - parseInt(b.id),
    );

    const summary = this.buildSummary(checkpoints);

    return {
      jobId,
      fileName,
      generatedAt: new Date().toISOString(),
      ninjaVersion: process.env.npm_package_version ?? '1.0.0',
      isTagged,
      summary,
      checkpoints,
    };
  }

  /**
   * Build a map from Matterhorn condition ID → AuditIssue[].
   *
   * Resolves condition IDs from two sources:
   *   1. issue.matterhornCheckpoint  (most validators)
   *   2. issue.code matching /^MATTERHORN-(\d{2}-\d{3})$/  (table validator fallback)
   */
  private buildFailureMap(issues: AuditIssue[]): Map<string, AuditIssue[]> {
    const map = new Map<string, AuditIssue[]>();

    for (const issue of issues) {
      let conditionId = issue.matterhornCheckpoint;

      // Fallback: extract from code like "MATTERHORN-15-001"
      if (!conditionId && issue.code) {
        const match = issue.code.match(/^MATTERHORN-(\d{2}-\d{3})$/);
        if (match) conditionId = match[1];
      }

      if (!conditionId) continue;

      const existing = map.get(conditionId);
      if (existing) {
        existing.push(issue);
      } else {
        map.set(conditionId, [issue]);
      }
    }

    return map;
  }

  /**
   * Classify a single Matterhorn condition as PASS/FAIL/UNTESTED/etc.
   */
  private classifyCondition(
    condition: MatterhornCondition,
    failureMap: Map<string, AuditIssue[]>,
  ): PacConditionResult {
    const base: PacConditionResult = {
      id: condition.id,
      description: condition.description,
      how: condition.how,
      status: 'UNTESTED',
    };

    // Human-only conditions cannot be machine-tested
    if (condition.how === 'H') {
      return { ...base, status: 'HUMAN_REQUIRED' };
    }

    // No-test conditions (spec defines no specific test)
    if (condition.how === '--') {
      return { ...base, status: 'NOT_APPLICABLE' };
    }

    // Machine condition (how === 'M')
    const failingIssues = failureMap.get(condition.id);
    if (failingIssues && failingIssues.length > 0) {
      return {
        ...base,
        status: 'FAIL',
        issueIds: failingIssues.map((i) => i.id),
        source: failingIssues[0].source === 'verapdf' ? 'verapdf' : 'ninja',
      };
    }

    if (TESTABLE_CONDITIONS.has(condition.id)) {
      return { ...base, status: 'PASS' };
    }

    return { ...base, status: 'UNTESTED' };
  }

  /**
   * Roll up condition statuses to a single checkpoint status.
   * Priority: FAIL > UNTESTED > HUMAN_REQUIRED > PASS
   */
  private rollupStatus(conditions: PacConditionResult[]): PacCheckpointStatus {
    const statuses = conditions.map((c) => c.status);
    if (statuses.includes('FAIL')) return 'FAIL';
    if (statuses.includes('UNTESTED')) return 'UNTESTED';
    if (statuses.every((s) => s === 'HUMAN_REQUIRED' || s === 'NOT_APPLICABLE')) {
      return 'HUMAN_REQUIRED';
    }
    return 'PASS';
  }

  private buildSummary(checkpoints: PacCheckpointResult[]): PacReportSummary {
    const allConditions = checkpoints.flatMap((cp) => cp.conditions);
    return {
      total: allConditions.length,
      pass: allConditions.filter((c) => c.status === 'PASS').length,
      fail: allConditions.filter((c) => c.status === 'FAIL').length,
      untested: allConditions.filter((c) => c.status === 'UNTESTED').length,
      humanRequired: allConditions.filter((c) => c.status === 'HUMAN_REQUIRED').length,
      notApplicable: allConditions.filter((c) => c.status === 'NOT_APPLICABLE').length,
    };
  }
}

export const pacReportService = new PacReportService();

logger.info('[PacReport] Service initialised');
